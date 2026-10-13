import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../db'
import { createEvents, type AppContext } from '../context'
import type { CoordinatorConfig } from '../config/schema'
import type { ClientConfigRow } from '../types'
import { revokeUser, suspendUser, upsertUser } from './users'
import { ensureSiteIdentities, rotateParams } from './identity'
import { exampleConfig } from './testFixtures'
import {
  activePeers, allocateAddress, configStatus, configSummary, configView, createConfig, findConfigByName,
  getOwnConfig, listConfigs, markDelivered, NAME_RE, revokeConfig, staleBotConfigs,
} from './configs'

function makeCtx(patch: (c: CoordinatorConfig) => CoordinatorConfig = c => c): AppContext {
  const db = openDb(':memory:')
  const config = patch(exampleConfig())
  ensureSiteIdentities(db, config)
  upsertUser(db, 1, 'alice')
  upsertUser(db, 2, 'bob')
  return { db, config: () => config, events: createEvents(), alert: async () => {} }
}

function create(ctx: AppContext, tgId: number, name: string, issuedVia: 'bot' | 'api' = 'bot'): ClientConfigRow {
  const row = createConfig(ctx, { tgId, name, issuedVia })
  if('error' in row) throw new Error(row.error)
  return row
}

describe('names', () => {
  it('accepts [a-z0-9-]{1,32}', () => {
    expect(NAME_RE.test('phone-2')).toBe(true)
    expect(NAME_RE.test('a'.repeat(32))).toBe(true)
    for(const bad of ['', 'Phone', 'a_b', 'a b', 'a'.repeat(33), 'тел']) expect(NAME_RE.test(bad)).toBe(false)
  })

  it('rejects invalid and taken names, frees the name on revoke', () => {
    const ctx = makeCtx()
    expect(createConfig(ctx, { tgId: 1, name: 'Bad!', issuedVia: 'api' })).toEqual({ error: 'invalid_name' })
    const row = create(ctx, 1, 'phone')
    expect(createConfig(ctx, { tgId: 1, name: 'phone', issuedVia: 'api' })).toEqual({ error: 'name_taken' })
    expect('error' in createConfig(ctx, { tgId: 2, name: 'phone', issuedVia: 'api' })).toBe(false)
    expect(revokeConfig(ctx, 1, row.id)).toBe(true)
    expect(create(ctx, 1, 'phone').id).not.toBe(row.id)
  })
})

describe('allocation', () => {
  it('skips network/server, reuses revoked addresses, throws when exhausted', () => {
    const ctx = makeCtx(c => ({ ...c, clients: { ...c.clients, subnet: '10.9.0.0/29' } }))
    const rows = ['a', 'b', 'c', 'd', 'e'].map(n => create(ctx, 1, n))
    expect(rows.map(r => r.address)).toEqual(['10.9.0.2', '10.9.0.3', '10.9.0.4', '10.9.0.5', '10.9.0.6'])
    expect(() => create(ctx, 1, 'f')).toThrow('subnet exhausted')

    revokeConfig(ctx, 1, rows[1].id)
    expect(allocateAddress(ctx.db, '10.9.0.0/29')).toBe('10.9.0.3')
    expect(create(ctx, 1, 'f').address).toBe('10.9.0.3')
  })

  it('keeps suspended configs\' addresses', () => {
    const ctx = makeCtx()
    const row = create(ctx, 1, 'a')
    ctx.db.prepare(`UPDATE client_configs SET state = 'suspended' WHERE id = ?`).run(row.id)
    expect(create(ctx, 1, 'b').address).toBe('10.66.0.3')
    expect(activePeers(ctx.db).map(p => p.address)).toEqual(['10.66.0.3'])
  })
})

describe('ownership and events', () => {
  it('emits peers-changed and limits access to the owner', () => {
    const ctx = makeCtx()
    const spy = vi.fn()
    ctx.events.on('peers-changed', spy)
    const row = create(ctx, 1, 'phone', 'api')
    expect(row).toMatchObject({ tg_id: 1, name: 'phone', state: 'active', issued_via: 'api', address: '10.66.0.2' })
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(spy).toHaveBeenCalledTimes(1)

    expect(getOwnConfig(ctx.db, 2, row.id)).toBeNull()
    expect(revokeConfig(ctx, 2, row.id)).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(listConfigs(ctx.db, 1).map(r => r.id)).toEqual([row.id])
    expect(findConfigByName(ctx.db, 1, 'phone')?.id).toBe(row.id)

    expect(revokeConfig(ctx, 1, row.id)).toBe(true)
    expect(revokeConfig(ctx, 1, row.id)).toBe(false)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(getOwnConfig(ctx.db, 1, row.id)?.state).toBe('revoked')
    expect(getOwnConfig(ctx.db, 1, row.id)?.revoked_at).not.toBeNull()
    expect(listConfigs(ctx.db, 1)).toEqual([])
    expect(findConfigByName(ctx.db, 1, 'phone')).toBeNull()
    expect(activePeers(ctx.db)).toEqual([])
  })
})

describe('views', () => {
  it('renders Config and summary', () => {
    const ctx = makeCtx()
    const row = create(ctx, 1, 'phone')
    const view = configView(ctx, row)
    expect(view.revision).toMatch(/^[0-9a-f]{8}$/)
    expect(view.awg).toContain('Address = 10.66.0.2/32')
    expect(view.awg).toContain(`PrivateKey = ${row.private_key}`)
    expect(view.endpoint).toMatch(/^203\.0\.113\.10:\d+$/)
    expect(view.vpnKey.startsWith('vpn://')).toBe(true)
    expect(view.serverName).toBe('🇳🇱 Нидерланды')
    expect(configSummary(ctx, row)).toEqual({ id: row.id, name: 'phone', revision: view.revision, state: 'active', createdAt: row.created_at })
  })

  it('rotating client params changes every revision, tunnel rotation does not', () => {
    const ctx = makeCtx()
    const rows = [create(ctx, 1, 'a'), create(ctx, 2, 'b')]
    const before = rows.map(r => configView(ctx, r).revision)
    rotateParams(ctx.db, 'main', 'tunnel')
    expect(rows.map(r => configView(ctx, r).revision)).toEqual(before)
    rotateParams(ctx.db, 'main', 'clients')
    const after = rows.map(r => configView(ctx, r).revision)
    after.forEach((rev, i) => expect(rev).not.toBe(before[i]))
  })
})

describe('configStatus', () => {
  it('derives state and network', () => {
    const ctx = makeCtx()
    const row = create(ctx, 1, 'phone')
    const rev = configView(ctx, row).revision
    expect(configStatus(ctx, row, rev)).toEqual({ state: 'ok', revision: rev, network: 'down', checkedAt: null })
    expect(configStatus(ctx, row, 'deadbeef').state).toBe('outdated')
    expect(configStatus(ctx, row, undefined).state).toBe('outdated')
    expect(configStatus(ctx, { ...row, state: 'suspended' }, rev).state).toBe('suspended')
    expect(configStatus(ctx, { ...row, state: 'revoked' }, 'x').state).toBe('revoked')

    ctx.db.prepare(`INSERT INTO sites (name, network, checked_at) VALUES ('main', 'degraded', '2026-01-01T00:00:00.000Z')`).run()
    expect(configStatus(ctx, row, rev)).toMatchObject({ network: 'degraded', checkedAt: '2026-01-01T00:00:00.000Z' })
  })
})

describe('staleBotConfigs', () => {
  it('lists bot configs with an outdated delivered revision that the app never fetched', () => {
    const ctx = makeCtx()
    const bot = create(ctx, 1, 'bot')
    const fetched = create(ctx, 1, 'fetched')
    const api = create(ctx, 1, 'api', 'api')
    const undelivered = create(ctx, 2, 'undelivered')
    for(const row of [bot, fetched, api]) markDelivered(ctx.db, row.id, configView(ctx, row).revision, 'bot')
    markDelivered(ctx.db, fetched.id, configView(ctx, fetched).revision, 'api')
    expect(getOwnConfig(ctx.db, 1, fetched.id)?.api_fetched_at).not.toBeNull()
    expect(getOwnConfig(ctx.db, 1, bot.id)?.api_fetched_at).toBeNull()
    expect(staleBotConfigs(ctx)).toEqual([])

    rotateParams(ctx.db, 'main', 'clients')
    expect(staleBotConfigs(ctx).map(r => r.id)).toEqual([bot.id])
    expect(undelivered.delivered_revision).toBeNull()

    const fresh = getOwnConfig(ctx.db, 1, bot.id)!
    markDelivered(ctx.db, bot.id, configView(ctx, fresh).revision, 'bot')
    expect(staleBotConfigs(ctx)).toEqual([])
  })
})

describe('membership gate', () => {
  it('refuses suspended, revoked and unknown users', () => {
    const ctx = makeCtx()
    const peersChanged = vi.fn()
    ctx.events.on('peers-changed', peersChanged)
    suspendUser(ctx, 1)
    expect(createConfig(ctx, { tgId: 1, name: 'phone', issuedVia: 'bot' })).toEqual({ error: 'not_member' })
    revokeUser(ctx, 2)
    expect(createConfig(ctx, { tgId: 2, name: 'phone', issuedVia: 'api' })).toEqual({ error: 'not_member' })
    expect(createConfig(ctx, { tgId: 99, name: 'phone', issuedVia: 'api' })).toEqual({ error: 'not_member' })
    expect(listConfigs(ctx.db, 1)).toEqual([])
    expect(peersChanged).not.toHaveBeenCalled()
  })
})
