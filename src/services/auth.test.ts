import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db'
import { hashSecret } from '../crypto/tokens'
import {
  GLOBAL_FAILURE_LIMIT, LoginRateLimiter, appVersionStats, authenticateToken, issueLoginCode, listTokens,
  redeemLoginCode, revokeAllTokens, revokeToken, revokeTokenForUser,
} from './auth'

const T0 = new Date('2026-10-12T10:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

let db: Db
let limiter: LoginRateLimiter

function addUser(tgId: number, username: string, status = 'active') {
  db.prepare('INSERT INTO users (tg_id, username, status, created_at) VALUES (?, ?, ?, ?)')
    .run(tgId, username, status, T0.toISOString())
}

function login(tgId = 1, ip = '1.1.1.1', extra: { deviceLabel?: string, appVersion?: string } = {}, now = T0) {
  const { code } = issueLoginCode(db, tgId, now)
  const res = redeemLoginCode(db, { code, ip, ...extra }, limiter, now)
  if(!res.ok) throw new Error(res.error)
  return res
}

beforeEach(() => {
  db = openDb(':memory:')
  limiter = new LoginRateLimiter()
  addUser(1, 'alice')
  addUser(2, 'bob')
})

describe('issueLoginCode', () => {
  it('stores only the hash with a 5 min TTL', () => {
    const { code, expiresAt } = issueLoginCode(db, 1, T0)
    expect(expiresAt).toBe(at(5 * 60_000).toISOString())
    const rows = db.prepare('SELECT * FROM login_codes').all() as { code_hash: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].code_hash).toBe(hashSecret(code))
    expect(JSON.stringify(rows)).not.toContain(code)
  })

  it('invalidates the previous unused code', () => {
    const first = issueLoginCode(db, 1, T0)
    issueLoginCode(db, 1, T0)
    expect(redeemLoginCode(db, { code: first.code, ip: 'x' }, limiter, T0)).toEqual({ ok: false, error: 'invalid_code' })
  })

  it('needs an existing user', () => {
    expect(() => issueLoginCode(db, 999, T0)).toThrow()
  })
})

describe('redeemLoginCode', () => {
  it('returns a token and stores only its hash', () => {
    const { code } = issueLoginCode(db, 1, T0)
    const res = redeemLoginCode(db, { code: ` ${code.toLowerCase()} `, deviceLabel: 'Pixel', appVersion: '4.8.1', ip: 'x' }, limiter, T0)
    expect(res.ok).toBe(true)
    if(!res.ok) return
    expect(res.user).toEqual({ tgId: 1, username: 'alice' })
    const [row] = listTokens(db, 1)
    expect(row.token_hash).toBe(hashSecret(res.token))
    expect(row.label).toBe('Pixel')
    expect(row.app_version).toBe('4.8.1')
  })

  it('is single use (AC-A2)', () => {
    const { code } = issueLoginCode(db, 1, T0)
    expect(redeemLoginCode(db, { code, ip: 'x' }, limiter, T0).ok).toBe(true)
    expect(redeemLoginCode(db, { code, ip: 'x' }, limiter, T0)).toEqual({ ok: false, error: 'invalid_code' })
  })

  it('expires after 5 minutes (AC-A2)', () => {
    const { code } = issueLoginCode(db, 1, T0)
    expect(redeemLoginCode(db, { code, ip: 'x' }, limiter, at(5 * 60_000))).toEqual({ ok: false, error: 'invalid_code' })
    const again = issueLoginCode(db, 1, T0)
    expect(redeemLoginCode(db, { code: again.code, ip: 'y' }, limiter, at(5 * 60_000 - 1)).ok).toBe(true)
  })

  it('rejects unknown codes and suspended users', () => {
    expect(redeemLoginCode(db, { code: 'ZZZZZZ', ip: 'x' }, limiter, T0)).toEqual({ ok: false, error: 'invalid_code' })
    db.prepare("UPDATE users SET status = 'suspended' WHERE tg_id = 1").run()
    const { code } = issueLoginCode(db, 1, T0)
    expect(redeemLoginCode(db, { code, ip: 'y' }, limiter, T0)).toEqual({ ok: false, error: 'invalid_code' })
    expect(listTokens(db, 1)).toHaveLength(0)
  })

  it('rate limits 5 attempts per IP per minute (R-A1)', () => {
    for(let i = 0; i < 5; i++) redeemLoginCode(db, { code: 'ZZZZZZ', ip: 'a' }, limiter, at(i))
    const { code } = issueLoginCode(db, 1, T0)
    expect(redeemLoginCode(db, { code, ip: 'a' }, limiter, at(10))).toEqual({ ok: false, error: 'rate_limited' })
    expect(redeemLoginCode(db, { code, ip: 'b' }, limiter, at(10)).ok).toBe(true)
  })

  it('burns live codes after too many global failures (R-A1)', () => {
    const { code } = issueLoginCode(db, 1, T0)
    for(let i = 0; i <= GLOBAL_FAILURE_LIMIT; i++) {
      redeemLoginCode(db, { code: 'ZZZZZZ', ip: `10.0.0.${i}` }, limiter, at(i))
    }
    expect(redeemLoginCode(db, { code, ip: 'fresh' }, limiter, at(100))).toEqual({ ok: false, error: 'invalid_code' })
    // A code issued after the attack is unaffected
    const next = issueLoginCode(db, 2, at(200))
    expect(redeemLoginCode(db, { code: next.code, ip: 'fresh2' }, limiter, at(300)).ok).toBe(true)
  })

  it('survives exactly the limit of failures', () => {
    const { code } = issueLoginCode(db, 1, T0)
    for(let i = 0; i < GLOBAL_FAILURE_LIMIT; i++) {
      redeemLoginCode(db, { code: 'ZZZZZZ', ip: `10.0.0.${i}` }, limiter, at(i))
    }
    expect(redeemLoginCode(db, { code, ip: 'fresh' }, limiter, at(100)).ok).toBe(true)
  })
})

describe('LoginRateLimiter', () => {
  it('uses a rolling window', () => {
    const l = new LoginRateLimiter()
    for(let i = 0; i < 5; i++) expect(l.check('ip', i * 1000)).toBe(true)
    expect(l.check('ip', 59_999)).toBe(false)
    expect(l.check('ip', 60_001)).toBe(true)
    expect(l.check('ip', 60_002)).toBe(false)
  })
})

describe('authenticateToken', () => {
  it('resolves a valid token and records last seen + version (R-O6)', () => {
    const { token } = login(1, 'x', { appVersion: '1.0' })
    const res = authenticateToken(db, token, { appVersion: '1.1', now: at(1000) })
    expect(res).toEqual({ ok: true, tgId: 1, username: 'alice', tokenHash: hashSecret(token) })
    const [row] = listTokens(db, 1)
    expect(row.last_seen_at).toBe(at(1000).toISOString())
    expect(row.app_version).toBe('1.1')
    authenticateToken(db, token, { now: at(2000) })
    expect(listTokens(db, 1)[0].app_version).toBe('1.1')
  })

  it('rejects unknown and revoked tokens', () => {
    expect(authenticateToken(db, 'nope')).toEqual({ ok: false, error: 'invalid_token' })
    const { token } = login()
    expect(revokeToken(db, hashSecret(token))).toBe(true)
    expect(authenticateToken(db, token)).toEqual({ ok: false, error: 'invalid_token' })
    expect(revokeToken(db, hashSecret(token))).toBe(false)
  })
})

describe('revocation and listing', () => {
  it('revokeTokenForUser matches the hash prefix of own tokens only', () => {
    const { token } = login(1)
    const prefix = hashSecret(token).slice(0, 8)
    expect(revokeTokenForUser(db, 2, prefix)).toBe(false)
    expect(revokeTokenForUser(db, 1, 'zz')).toBe(false)
    expect(revokeTokenForUser(db, 1, prefix)).toBe(true)
    expect(listTokens(db, 1)).toHaveLength(0)
  })

  it('revokeAllTokens revokes every token of the user (AC-A2)', () => {
    login(1, 'a')
    login(1, 'b')
    const bob = login(2, 'c')
    expect(revokeAllTokens(db, 1)).toBe(2)
    expect(revokeAllTokens(db, 1)).toBe(0)
    expect(listTokens(db, 1)).toHaveLength(0)
    expect(authenticateToken(db, bob.token).ok).toBe(true)
  })

  it('lists newest first', () => {
    login(1, 'a', { deviceLabel: 'old' }, T0)
    login(1, 'b', { deviceLabel: 'new' }, at(1000))
    expect(listTokens(db, 1).map(t => t.label)).toEqual(['new', 'old'])
  })
})

describe('appVersionStats', () => {
  it('counts live tokens seen in the last 30 days', () => {
    const day = 24 * 60 * 60_000
    login(1, 'a', { appVersion: '2.0' }, T0)
    login(1, 'b', { appVersion: '2.0' }, T0)
    login(2, 'c', {}, T0)
    login(2, 'd', { appVersion: '1.0' }, at(-40 * day))
    const revoked = login(2, 'e', { appVersion: '3.0' }, T0)
    revokeToken(db, hashSecret(revoked.token))
    expect(appVersionStats(db, at(day))).toEqual([
      { version: '2.0', count: 2 },
      { version: 'unknown', count: 1 },
    ])
  })
})
