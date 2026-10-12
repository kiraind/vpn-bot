import type { Db } from '../db'
import { now } from '../db'
import type { AppContext } from '../context'
import type { UserRow } from '../types'

// Users are keyed by Telegram id (R-S1); username is display-only and refreshed on every contact.

export function upsertUser(db: Db, tgId: number, username: string | null): UserRow {
  db.prepare(`
    INSERT INTO users (tg_id, username, created_at) VALUES (?, ?, ?)
    ON CONFLICT (tg_id) DO UPDATE SET username = excluded.username
  `).run(tgId, username, now())

  return getUser(db, tgId)!
}

export function getUser(db: Db, tgId: number): UserRow | null {
  return (db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId) as UserRow | undefined) ?? null
}

export function findUserByUsername(db: Db, name: string): UserRow | null {
  const clean = name.trim().replace(/^@/, '')
  if(!clean) {
    return null
  }

  return (db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE ORDER BY tg_id LIMIT 1')
    .get(clean) as UserRow | undefined) ?? null
}

export function listUsers(db: Db): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY tg_id').all() as UserRow[]
}

export function markMembershipChecked(db: Db, tgId: number, at: string = now()) {
  db.prepare('UPDATE users SET membership_checked_at = ? WHERE tg_id = ?').run(at, tgId)
}

export interface DisableResult {
  configs: number
  tokens: number
}

function revokeTokens(db: Db, tgId: number, at: string): number {
  return db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE tg_id = ? AND revoked_at IS NULL')
    .run(at, tgId).changes
}

/** Left the chat (R-B1): peers go away but configs are kept for a later return; tokens die for good. */
export function suspendUser(ctx: AppContext, tgId: number): DisableResult {
  const result = ctx.db.transaction(() => {
    const at = now()
    ctx.db.prepare(`UPDATE users SET status = 'suspended' WHERE tg_id = ?`).run(tgId)
    const configs = ctx.db.prepare(`UPDATE client_configs SET state = 'suspended' WHERE tg_id = ? AND state = 'active'`)
      .run(tgId).changes

    return { configs, tokens: revokeTokens(ctx.db, tgId, at) }
  })()

  if(result.configs > 0) {
    ctx.events.emit('peers-changed')
  }

  return result
}

/** Back in the chat: configs return, device tokens do not (a new /login is required, R-B1, R-A3). */
export function reactivateUser(ctx: AppContext, tgId: number): number {
  const configs = ctx.db.transaction(() => {
    ctx.db.prepare(`UPDATE users SET status = 'active' WHERE tg_id = ?`).run(tgId)

    return ctx.db.prepare(`UPDATE client_configs SET state = 'active' WHERE tg_id = ? AND state = 'suspended'`)
      .run(tgId).changes
  })()

  if(configs > 0) {
    ctx.events.emit('peers-changed')
  }

  return configs
}

/** Admin /revoke_user: like suspend, but configs are revoked for good (their addresses become free). */
export function revokeUser(ctx: AppContext, tgId: number): DisableResult {
  const result = ctx.db.transaction(() => {
    const at = now()
    ctx.db.prepare(`UPDATE users SET status = 'suspended' WHERE tg_id = ?`).run(tgId)
    const configs = ctx.db.prepare(`
      UPDATE client_configs SET state = 'revoked', revoked_at = ? WHERE tg_id = ? AND state != 'revoked'
    `).run(at, tgId).changes

    return { configs, tokens: revokeTokens(ctx.db, tgId, at) }
  })()

  if(result.configs > 0) {
    ctx.events.emit('peers-changed')
  }

  return result
}
