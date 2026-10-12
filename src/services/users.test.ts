import { describe, expect, it, vi } from 'vitest'
import { openDb, now } from '../db'
import type { Db } from '../db'
import { createEvents } from '../context'
import type { AppContext } from '../context'
import type { CoordinatorConfig } from '../config/schema'
import {
  findUserByUsername, getUser, listUsers, markMembershipChecked, reactivateUser, revokeUser, suspendUser, unrevokeUser, upsertUser,
} from './users'

function fakeCtx(db: Db = openDb(':memory:')) {
  const events = createEvents()
  const peersChanged = vi.fn()
  events.on('peers-changed', peersChanged)
  const ctx: AppContext = {
    db,
    config: () => ({}) as CoordinatorConfig,
    events,
    alert: vi.fn(async () => {}),
  }

  return { ctx, peersChanged }
}

let seq = 0
function addConfig(db: Db, tgId: number, state: 'active' | 'suspended' | 'revoked' = 'active') {
  seq += 1
  db.prepare(`
    INSERT INTO client_configs (id, tg_id, name, address, private_key, public_key, preshared_key, state, issued_via, created_at)
    VALUES (?, ?, ?, ?, 'priv', 'pub', 'psk', ?, 'bot', ?)
  `).run(`c${seq}`, tgId, `dev${seq}`, `10.8.0.${seq + 1}`, state, now())
}

function addToken(db: Db, tgId: number, revoked = false) {
  seq += 1
  db.prepare('INSERT INTO device_tokens (token_hash, tg_id, created_at, revoked_at) VALUES (?, ?, ?, ?)')
    .run(`t${seq}`, tgId, now(), revoked ? now() : null)
}

const states = (db: Db, tgId: number) =>
  (db.prepare('SELECT state FROM client_configs WHERE tg_id = ? ORDER BY id').all(tgId) as { state: string }[]).map(r => r.state)
const liveTokens = (db: Db, tgId: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM device_tokens WHERE tg_id = ? AND revoked_at IS NULL').get(tgId) as { n: number }).n

describe('users', () => {
  it('upserts by tg id and refreshes username (R-S1)', () => {
    const db = openDb(':memory:')
    const u = upsertUser(db, 1, 'Alice')
    expect(u).toMatchObject({ tg_id: 1, username: 'Alice', status: 'active', membership_checked_at: null })
    const again = upsertUser(db, 1, 'alice2')
    expect(again.username).toBe('alice2')
    expect(again.created_at).toBe(u.created_at)
    upsertUser(db, 2, null)
    expect(listUsers(db).map(r => r.tg_id)).toEqual([1, 2])
    expect(getUser(db, 3)).toBeNull()
  })

  it('finds by username ignoring @ and case', () => {
    const db = openDb(':memory:')
    upsertUser(db, 1, 'Alice')
    expect(findUserByUsername(db, '@alice')?.tg_id).toBe(1)
    expect(findUserByUsername(db, 'ALICE')?.tg_id).toBe(1)
    expect(findUserByUsername(db, 'bob')).toBeNull()
    expect(findUserByUsername(db, '@')).toBeNull()
  })

  it('marks membership checked', () => {
    const db = openDb(':memory:')
    upsertUser(db, 1, 'a')
    markMembershipChecked(db, 1, '2026-01-01T00:00:00.000Z')
    expect(getUser(db, 1)!.membership_checked_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('suspends: configs suspended, tokens revoked, event emitted', () => {
    const { ctx, peersChanged } = fakeCtx()
    upsertUser(ctx.db, 1, 'a')
    upsertUser(ctx.db, 2, 'b')
    addConfig(ctx.db, 1)
    addConfig(ctx.db, 1, 'revoked')
    addConfig(ctx.db, 2)
    addToken(ctx.db, 1)
    addToken(ctx.db, 1)
    addToken(ctx.db, 1, true)
    addToken(ctx.db, 2)

    expect(suspendUser(ctx, 1)).toEqual({ configs: 1, tokens: 2 })
    expect(getUser(ctx.db, 1)!.status).toBe('suspended')
    expect(states(ctx.db, 1)).toEqual(['suspended', 'revoked'])
    expect(liveTokens(ctx.db, 1)).toBe(0)
    expect(states(ctx.db, 2)).toEqual(['active'])
    expect(liveTokens(ctx.db, 2)).toBe(1)
    expect(peersChanged).toHaveBeenCalledTimes(1)

    // Idempotent: nothing changes, no event.
    expect(suspendUser(ctx, 1)).toEqual({ configs: 0, tokens: 0 })
    expect(peersChanged).toHaveBeenCalledTimes(1)
  })

  it('does not emit when a user without configs is suspended', () => {
    const { ctx, peersChanged } = fakeCtx()
    upsertUser(ctx.db, 1, 'a')
    addToken(ctx.db, 1)
    expect(suspendUser(ctx, 1)).toEqual({ configs: 0, tokens: 1 })
    expect(peersChanged).not.toHaveBeenCalled()
  })

  it('suspend is atomic', () => {
    const { ctx, peersChanged } = fakeCtx()
    upsertUser(ctx.db, 1, 'a')
    addConfig(ctx.db, 1)
    addToken(ctx.db, 1)
    ctx.db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON device_tokens BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    expect(() => suspendUser(ctx, 1)).toThrow(/boom/)
    expect(getUser(ctx.db, 1)!.status).toBe('active')
    expect(states(ctx.db, 1)).toEqual(['active'])
    expect(peersChanged).not.toHaveBeenCalled()
  })

  it('reactivates configs but not tokens (R-B1)', () => {
    const { ctx, peersChanged } = fakeCtx()
    upsertUser(ctx.db, 1, 'a')
    addConfig(ctx.db, 1)
    addConfig(ctx.db, 1, 'revoked')
    addToken(ctx.db, 1)
    suspendUser(ctx, 1)
    peersChanged.mockClear()

    expect(reactivateUser(ctx, 1)).toBe(1)
    expect(getUser(ctx.db, 1)!.status).toBe('active')
    expect(states(ctx.db, 1)).toEqual(['active', 'revoked'])
    expect(liveTokens(ctx.db, 1)).toBe(0)
    expect(peersChanged).toHaveBeenCalledTimes(1)

    expect(reactivateUser(ctx, 1)).toBe(0)
    expect(peersChanged).toHaveBeenCalledTimes(1)
  })

  it('revokes user: configs revoked with revoked_at, addresses free', () => {
    const { ctx, peersChanged } = fakeCtx()
    upsertUser(ctx.db, 1, 'a')
    addConfig(ctx.db, 1)
    addConfig(ctx.db, 1, 'suspended')
    addToken(ctx.db, 1)

    expect(revokeUser(ctx, 1)).toEqual({ configs: 2, tokens: 1 })
    expect(getUser(ctx.db, 1)!.status).toBe('suspended')
    expect(states(ctx.db, 1)).toEqual(['revoked', 'revoked'])
    const rows = ctx.db.prepare('SELECT revoked_at FROM client_configs WHERE tg_id = 1').all() as { revoked_at: string | null }[]
    expect(rows.every(r => r.revoked_at)).toBe(true)
    expect(peersChanged).toHaveBeenCalledTimes(1)
    expect(reactivateUser(ctx, 1)).toBe(0)
  })
})

describe('admin revocation', () => {
  it('sets revoked_at; reactivation is refused until unrevoked', () => {
    const { ctx } = fakeCtx()
    upsertUser(ctx.db, 1, 'a')
    revokeUser(ctx, 1)
    const user = getUser(ctx.db, 1)!
    expect(user.status).toBe('suspended')
    expect(user.revoked_at).not.toBeNull()

    addConfig(ctx.db, 1, 'suspended')
    expect(reactivateUser(ctx, 1)).toBe(0)
    expect(getUser(ctx.db, 1)!.status).toBe('suspended')
    expect(states(ctx.db, 1)).toEqual(['suspended'])

    expect(unrevokeUser(ctx, 1)).toBe(true)
    expect(unrevokeUser(ctx, 1)).toBe(false)
    expect(getUser(ctx.db, 1)!.revoked_at).toBeNull()
    expect(reactivateUser(ctx, 1)).toBe(1)
    expect(getUser(ctx.db, 1)!.status).toBe('active')
  })

  it('keeps the first revoked_at on a repeated revoke', () => {
    const { ctx } = fakeCtx()
    upsertUser(ctx.db, 1, 'a')
    ctx.db.prepare(`UPDATE users SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE tg_id = 1`).run()
    revokeUser(ctx, 1)
    expect(getUser(ctx.db, 1)!.revoked_at).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('stale usernames', () => {
  it('a username moves to its new owner, case-insensitively', () => {
    const { ctx } = fakeCtx()
    upsertUser(ctx.db, 1, 'Alice')
    upsertUser(ctx.db, 2, 'alice')
    expect(getUser(ctx.db, 1)!.username).toBeNull()
    expect(findUserByUsername(ctx.db, '@ALICE')!.tg_id).toBe(2)
    upsertUser(ctx.db, 3, null)
    expect(getUser(ctx.db, 2)!.username).toBe('alice')
  })

  it('ambiguous legacy duplicates resolve to nobody', () => {
    const { ctx } = fakeCtx()
    upsertUser(ctx.db, 1, 'x')
    upsertUser(ctx.db, 2, 'y')
    ctx.db.prepare(`UPDATE users SET username = 'X' WHERE tg_id = 2`).run()
    expect(findUserByUsername(ctx.db, 'x')).toBeNull()
  })
})
