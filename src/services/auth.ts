import type { Db } from '../db'
import type { DeviceTokenRow } from '../types'
import { genDeviceToken, genLoginCode, hashSecret, normalizeLoginCode } from '../crypto/tokens'

// Login codes and device tokens (spec 9.1). Only hashes ever reach the DB (R-S4).
//
// Brute-force protection (R-A1). A wrong code doesn't tell us which code the attacker was
// aiming at, so "burn a specific code after 5 failures" can't be done literally. The rule
// actually implemented:
//   1. at most 5 redemption attempts per IP per rolling minute (LoginRateLimiter);
//   2. codes are 6 chars from a 31-char alphabet (~8.9e8 values) and live 5 minutes;
//   3. every failed redemption bumps failed_attempts on every live code; a live code that
//      has seen more than GLOBAL_FAILURE_LIMIT failures during its lifetime is burned.
// So a distributed guesser gets at most ~50 tries against any live code (~6e-8 hit chance),
// while normal users are only hurt during an active attack (they just /login again).

export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000
export const GLOBAL_FAILURE_LIMIT = 50
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60 * 1000
const STATS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export function issueLoginCode(db: Db, tgId: number, now = new Date()): { code: string, expiresAt: string } {
  const nowIso = now.toISOString()
  const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS).toISOString()

  return db.transaction(() => {
    // Dead codes are useless; dropping them also frees their hashes for reuse
    db.prepare('DELETE FROM login_codes WHERE expires_at <= ?').run(nowIso)
    db.prepare('DELETE FROM login_codes WHERE tg_id = ? AND used_at IS NULL').run(tgId)

    const exists = db.prepare('SELECT 1 FROM login_codes WHERE code_hash = ?')
    let code: string
    do code = genLoginCode()
    while(exists.get(hashSecret(code)))

    db.prepare('INSERT INTO login_codes (code_hash, tg_id, expires_at) VALUES (?, ?, ?)')
      .run(hashSecret(code), tgId, expiresAt)
    return { code, expiresAt }
  })()
}

export class LoginRateLimiter {
  private attempts = new Map<string, number[]>()

  /** Consumes an attempt for `ip`; false when it already used RATE_LIMIT in the last minute. */
  check(ip: string, now = Date.now()): boolean {
    const recent = (this.attempts.get(ip) ?? []).filter(t => t > now - RATE_WINDOW_MS)
    if(recent.length >= RATE_LIMIT) {
      this.attempts.set(ip, recent)
      return false
    }
    recent.push(now)
    this.attempts.set(ip, recent)
    this.prune(now)
    return true
  }

  // Keeps the map from growing forever under a spray of distinct IPs
  private prune(now: number) {
    if(this.attempts.size < 1000) return
    for(const [ip, times] of this.attempts) {
      if(times.every(t => t <= now - RATE_WINDOW_MS)) this.attempts.delete(ip)
    }
  }
}

export interface RedeemInput {
  code: string
  deviceLabel?: string
  appVersion?: string
  ip: string
}

export type RedeemResult =
  | { ok: true, token: string, user: { tgId: number, username: string | null } }
  | { ok: false, error: 'rate_limited' | 'invalid_code' }

export function redeemLoginCode(db: Db, input: RedeemInput, limiter: LoginRateLimiter, now = new Date()): RedeemResult {
  if(!limiter.check(input.ip, now.getTime())) return { ok: false, error: 'rate_limited' }

  const nowIso = now.toISOString()
  const codeHash = hashSecret(normalizeLoginCode(input.code))

  return db.transaction((): RedeemResult => {
    const row = db.prepare(`
      SELECT c.tg_id, u.username, u.status FROM login_codes c JOIN users u ON u.tg_id = c.tg_id
      WHERE c.code_hash = ? AND c.used_at IS NULL AND c.expires_at > ?
    `).get(codeHash, nowIso) as { tg_id: number, username: string | null, status: string } | undefined

    if(!row) {
      recordFailure(db, nowIso)
      return { ok: false, error: 'invalid_code' }
    }
    // A real code of a suspended user is not a guess, so it doesn't count as a failure
    if(row.status === 'suspended') return { ok: false, error: 'invalid_code' }

    db.prepare('UPDATE login_codes SET used_at = ? WHERE code_hash = ?').run(nowIso, codeHash)
    const token = genDeviceToken()
    db.prepare(`
      INSERT INTO device_tokens (token_hash, tg_id, label, app_version, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hashSecret(token), row.tg_id, input.deviceLabel ?? null, input.appVersion ?? null, nowIso, nowIso)

    return { ok: true, token, user: { tgId: row.tg_id, username: row.username } }
  })()
}

function recordFailure(db: Db, nowIso: string) {
  db.prepare('UPDATE login_codes SET failed_attempts = failed_attempts + 1 WHERE used_at IS NULL AND expires_at > ?')
    .run(nowIso)
  // Burn by expiring rather than marking used, so "used" keeps meaning "redeemed"
  db.prepare('UPDATE login_codes SET expires_at = ? WHERE used_at IS NULL AND expires_at > ? AND failed_attempts > ?')
    .run(nowIso, nowIso, GLOBAL_FAILURE_LIMIT)
}

export type AuthResult =
  | { ok: true, tgId: number, username: string | null, tokenHash: string }
  | { ok: false, error: 'invalid_token' }

/** Resolves a device token; membership (403 not_member) is the caller's call (R-A3). */
export function authenticateToken(db: Db, token: string, opts: { appVersion?: string, now?: Date } = {}): AuthResult {
  const tokenHash = hashSecret(token)
  const row = db.prepare(`
    SELECT t.tg_id, u.username FROM device_tokens t JOIN users u ON u.tg_id = t.tg_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL
  `).get(tokenHash) as { tg_id: number, username: string | null } | undefined
  if(!row) return { ok: false, error: 'invalid_token' }

  // Old app builds may not send X-App-Version; keep the last known one then (R-O6)
  db.prepare('UPDATE device_tokens SET last_seen_at = ?, app_version = COALESCE(?, app_version) WHERE token_hash = ?')
    .run((opts.now ?? new Date()).toISOString(), opts.appVersion ?? null, tokenHash)

  return { ok: true, tgId: row.tg_id, username: row.username, tokenHash }
}

export function revokeToken(db: Db, tokenHash: string, now = new Date()): boolean {
  return db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now.toISOString(), tokenHash).changes > 0
}

/** For bot /devices buttons, which identify a token by the first 8 hex chars of its hash. */
export function revokeTokenForUser(db: Db, tgId: number, tokenHashPrefix: string, now = new Date()): boolean {
  if(!/^[0-9a-f]{8}$/.test(tokenHashPrefix)) return false
  return db.prepare(`
    UPDATE device_tokens SET revoked_at = ?
    WHERE tg_id = ? AND substr(token_hash, 1, 8) = ? AND revoked_at IS NULL
  `).run(now.toISOString(), tgId, tokenHashPrefix).changes > 0
}

export function revokeAllTokens(db: Db, tgId: number, now = new Date()): number {
  return db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE tg_id = ? AND revoked_at IS NULL')
    .run(now.toISOString(), tgId).changes
}

export function listTokens(db: Db, tgId: number): DeviceTokenRow[] {
  return db.prepare('SELECT * FROM device_tokens WHERE tg_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC')
    .all(tgId) as DeviceTokenRow[]
}

export function appVersionStats(db: Db, now = new Date()): { version: string, count: number }[] {
  const since = new Date(now.getTime() - STATS_WINDOW_MS).toISOString()
  return db.prepare(`
    SELECT COALESCE(app_version, 'unknown') AS version, COUNT(*) AS count FROM device_tokens
    WHERE revoked_at IS NULL AND COALESCE(last_seen_at, created_at) >= ?
    GROUP BY version ORDER BY count DESC, version
  `).all(since) as { version: string, count: number }[]
}
