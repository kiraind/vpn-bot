import { describe, expect, it, vi } from 'vitest'
import { openDb, now } from '../db'
import type { Db } from '../db'
import { createEvents } from '../context'
import type { AppContext } from '../context'
import type { CoordinatorConfig } from '../config/schema'
import { getUser, markMembershipChecked, suspendUser, upsertUser } from './users'
import {
  createTelegramMemberChecker, ensureMemberFresh, handleChatMemberUpdate, sweepMembership,
} from './membership'
import type { MemberChecker, MembershipStatus } from './membership'

function fakeCtx() {
  const events = createEvents()
  const peersChanged = vi.fn()
  events.on('peers-changed', peersChanged)
  const ctx: AppContext = {
    db: openDb(':memory:'),
    config: () => ({}) as CoordinatorConfig,
    events,
    alert: vi.fn(async () => {}),
  }

  return { ctx, peersChanged }
}

let seq = 0
function addUserWithStuff(db: Db, tgId: number) {
  upsertUser(db, tgId, `u${tgId}`)
  seq += 1
  db.prepare(`
    INSERT INTO client_configs (id, tg_id, name, address, private_key, public_key, preshared_key, issued_via, created_at)
    VALUES (?, ?, 'phone', ?, 'priv', 'pub', 'psk', 'bot', ?)
  `).run(`c${seq}`, tgId, `10.8.0.${seq + 1}`, now())
  db.prepare('INSERT INTO device_tokens (token_hash, tg_id, created_at) VALUES (?, ?, ?)').run(`t${seq}`, tgId, now())
}

const configState = (db: Db, tgId: number) =>
  (db.prepare('SELECT state FROM client_configs WHERE tg_id = ?').get(tgId) as { state: string }).state
const liveTokens = (db: Db, tgId: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM device_tokens WHERE tg_id = ? AND revoked_at IS NULL').get(tgId) as { n: number }).n

function checkerOf(map: Record<number, MembershipStatus>) {
  return vi.fn<MemberChecker>(async (tgId) => ({ status: map[tgId] ?? 'unknown', reason: 'test' }))
}

describe('createTelegramMemberChecker', () => {
  it('maps chat member statuses', async () => {
    const statuses: Record<number, { status: string, is_member?: boolean }> = {
      1: { status: 'member' }, 2: { status: 'administrator' }, 3: { status: 'creator' },
      4: { status: 'restricted', is_member: true }, 5: { status: 'restricted', is_member: false },
      6: { status: 'left' }, 7: { status: 'kicked' },
    }
    const check = createTelegramMemberChecker(async (_chat, id) => statuses[id], -100, { delayMs: 0 })
    const result = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(id => check(id)))
    expect(result.map(r => r.status)).toEqual(['member', 'member', 'member', 'member', 'not-member', 'not-member', 'not-member'])
  })

  it('retries then succeeds', async () => {
    const get = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ status: 'member' })
    const check = createTelegramMemberChecker(get, -100, { retries: 3, delayMs: 0 })
    expect(await check(1)).toEqual({ status: 'member', reason: 'member' })
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledWith(-100, 1)
  })

  it('returns unknown after all retries fail', async () => {
    const get = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'))
    const check = createTelegramMemberChecker(get, -100, { retries: 3, delayMs: 0 })
    const r = await check(1)
    expect(r.status).toBe('unknown')
    expect(r.reason).toMatch(/check failed: ETIMEDOUT/)
    expect(get).toHaveBeenCalledTimes(3)
  })
})

describe('sweepMembership', () => {
  it('suspends leavers, skips unknown, never auto-reactivates (R-B1, AC-A1)', async () => {
    const { ctx, peersChanged } = fakeCtx()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for(const id of [1, 2, 3, 4]) {
      addUserWithStuff(ctx.db, id)
    }
    suspendUser(ctx, 4)
    peersChanged.mockClear()

    const result = await sweepMembership(ctx, checkerOf({ 1: 'member', 2: 'not-member', 3: 'unknown', 4: 'member' }))
    expect(result).toEqual({ checked: 3, suspended: 1, unknown: 1 })

    expect(getUser(ctx.db, 1)!.status).toBe('active')
    expect(getUser(ctx.db, 2)!.status).toBe('suspended')
    expect(configState(ctx.db, 2)).toBe('suspended')
    expect(liveTokens(ctx.db, 2)).toBe(0)
    expect(getUser(ctx.db, 3)!.status).toBe('active')
    expect(configState(ctx.db, 3)).toBe('active')
    expect(getUser(ctx.db, 4)!.status).toBe('suspended')
    expect(peersChanged).toHaveBeenCalledTimes(1)

    expect(getUser(ctx.db, 1)!.membership_checked_at).not.toBeNull()
    expect(getUser(ctx.db, 3)!.membership_checked_at).toBeNull()
  })
})

describe('ensureMemberFresh (R-A3)', () => {
  it('uses a fresh cache without a live check', async () => {
    const { ctx } = fakeCtx()
    addUserWithStuff(ctx.db, 1)
    markMembershipChecked(ctx.db, 1, now())
    const checker = checkerOf({ 1: 'not-member' })
    expect(await ensureMemberFresh(ctx, checker, 1)).toBe('member')
    expect(checker).not.toHaveBeenCalled()
  })

  it('suspended or unknown user is not a member', async () => {
    const { ctx } = fakeCtx()
    addUserWithStuff(ctx.db, 1)
    suspendUser(ctx, 1)
    const checker = checkerOf({ 1: 'member' })
    expect(await ensureMemberFresh(ctx, checker, 1)).toBe('not-member')
    expect(await ensureMemberFresh(ctx, checker, 99)).toBe('not-member')
    expect(checker).not.toHaveBeenCalled()
  })

  it('stale cache: live check suspends a leaver', async () => {
    const { ctx, peersChanged } = fakeCtx()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    addUserWithStuff(ctx.db, 1)
    markMembershipChecked(ctx.db, 1, new Date(Date.now() - 2 * 3600_000).toISOString())
    expect(await ensureMemberFresh(ctx, checkerOf({ 1: 'not-member' }), 1)).toBe('not-member')
    expect(getUser(ctx.db, 1)!.status).toBe('suspended')
    expect(liveTokens(ctx.db, 1)).toBe(0)
    expect(peersChanged).toHaveBeenCalledTimes(1)
  })

  it('stale cache: live member refreshes the timestamp', async () => {
    const { ctx } = fakeCtx()
    addUserWithStuff(ctx.db, 1)
    expect(await ensureMemberFresh(ctx, checkerOf({ 1: 'member' }), 1)).toBe('member')
    expect(getUser(ctx.db, 1)!.membership_checked_at).not.toBeNull()
  })

  it('unknown live result trusts the cached active status', async () => {
    const { ctx } = fakeCtx()
    addUserWithStuff(ctx.db, 1)
    expect(await ensureMemberFresh(ctx, checkerOf({}), 1)).toBe('member')
    expect(getUser(ctx.db, 1)!.membership_checked_at).toBeNull()
    expect(getUser(ctx.db, 1)!.status).toBe('active')
  })
})

describe('handleChatMemberUpdate (R-B2)', () => {
  const update = (id: number, status: string) => ({ new_chat_member: { status, user: { id } } })

  it('suspends instantly on left/kicked', () => {
    const { ctx, peersChanged } = fakeCtx()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    addUserWithStuff(ctx.db, 1)
    addUserWithStuff(ctx.db, 2)
    expect(handleChatMemberUpdate(ctx, update(1, 'left'))).toBe(true)
    expect(handleChatMemberUpdate(ctx, update(2, 'kicked'))).toBe(true)
    expect(getUser(ctx.db, 1)!.status).toBe('suspended')
    expect(configState(ctx.db, 2)).toBe('suspended')
    expect(peersChanged).toHaveBeenCalledTimes(2)
    // Already suspended: no-op.
    expect(handleChatMemberUpdate(ctx, update(1, 'left'))).toBe(false)
  })

  it('ignores joins and unknown users', () => {
    const { ctx, peersChanged } = fakeCtx()
    addUserWithStuff(ctx.db, 1)
    expect(handleChatMemberUpdate(ctx, update(1, 'member'))).toBe(false)
    expect(handleChatMemberUpdate(ctx, update(42, 'left'))).toBe(false)
    expect(getUser(ctx.db, 1)!.status).toBe('active')
    expect(getUser(ctx.db, 42)).toBeNull()
    expect(peersChanged).not.toHaveBeenCalled()
  })
})

describe('ensureMemberFresh with admin revocation', () => {
  it('a revoked user is not a member despite a fresh cache', async () => {
    const { ctx } = fakeCtx()
    addUserWithStuff(ctx.db, 1)
    markMembershipChecked(ctx.db, 1, now())
    ctx.db.prepare(`UPDATE users SET revoked_at = ? WHERE tg_id = 1`).run(now())
    const checker = checkerOf({ 1: 'member' })
    expect(await ensureMemberFresh(ctx, checker, 1)).toBe('not-member')
    expect(checker).not.toHaveBeenCalled()
  })
})
