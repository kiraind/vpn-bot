import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { createEvents, type AppContext } from '../context'
import type { CoordinatorConfig } from '../config/schema'
import { ensureSiteIdentities, getLocalIdentity, getRemoteIdentity, rotateParams } from '../services/identity'
import { createConfig } from '../services/configs'
import { upsertUser } from '../services/users'
import { exampleConfig } from '../services/testFixtures'
import { updateGeoSet } from '../geo/store'
import { buildRenderInputs, buildTargets } from './desired'

function makeCtx(patch: (c: CoordinatorConfig) => void = () => {}): AppContext {
  const db = openDb(':memory:')
  const config = exampleConfig()
  patch(config)
  ensureSiteIdentities(db, config)
  return { db, config: () => config, events: createEvents(), alert: async () => {} }
}

describe('buildTargets', () => {
  it('builds both nodes from config + DB', () => {
    const ctx = makeCtx()
    const site = ctx.config().sites[0]
    const { local, remote } = buildTargets(ctx, site, '2.0.0')

    expect(local).toMatchObject({
      node: 'main/local', role: 'local', host: '203.0.113.11',
      addresses: ['203.0.113.10', '203.0.113.11', '203.0.113.12'], interfaces: ['awgc', 'awgt'],
    })
    expect(remote).toMatchObject({
      node: 'main/remote', role: 'remote', host: '198.51.100.20',
      addresses: ['198.51.100.20', '198.51.100.21'], interfaces: ['awgt'],
    })
    expect(local.ssh.password).toBe('a')
    expect(local.files.length).toBeGreaterThan(0)
    expect(local.hash).toMatch(/^[0-9a-f]{64}$/)

    const inputs = buildRenderInputs(ctx, site)
    expect(inputs.local.identity).toEqual(getLocalIdentity(ctx.db, 'main'))
    expect(inputs.local.remote).toEqual(getRemoteIdentity(ctx.db, 'main').awgt)
    expect(inputs.local.remoteTunnelAddress).toBe('198.51.100.21')
    expect(inputs.remote.localTunnelAddress).toBe('203.0.113.12')
    expect(inputs.remote.localAwgtPublicKey).toBe(getLocalIdentity(ctx.db, 'main').awgt.publicKey)
  })

  it('passes each node ssh.port into its render input and nftables', () => {
    const ctx = makeCtx(c => {
      c.sites[0].local.ssh.port = 2222
      c.sites[0].remote.ssh.port = 2200
    })
    const site = ctx.config().sites[0]
    const inputs = buildRenderInputs(ctx, site)
    expect(inputs.local.sshPort).toBe(2222)
    expect(inputs.remote.sshPort).toBe(2200)
    const { local, remote } = buildTargets(ctx, site, '1')
    const nft = (t: typeof local) => t.files.map(f => f.content).join('\n')
    expect(nft(local)).toContain('tcp dport 2222 accept')
    expect(nft(remote)).toContain('tcp dport 2200 accept')
    expect(nft(local)).not.toContain('tcp dport 22 ')
  })

  it('is deterministic and the hash covers the coordinator version', () => {
    const ctx = makeCtx()
    const site = ctx.config().sites[0]
    const a = buildTargets(ctx, site, '1')
    expect(buildTargets(ctx, site, '1')).toEqual(a)
    const b = buildTargets(ctx, site, '2')
    expect(b.local.hash).not.toBe(a.local.hash)
    expect(b.remote.hash).not.toBe(a.remote.hash)
  })

  it('geoHome = stored set ∪ alwaysDirect (merged), forceRemote = alwaysRemote', () => {
    const ctx = makeCtx(c => {
      c.routing.alwaysDirect = ['10.0.1.0/24', '192.0.2.0/24']
      c.routing.alwaysRemote = ['198.18.0.0/15']
    })
    const site = ctx.config().sites[0]
    expect(buildRenderInputs(ctx, site).local.geoHome).toEqual(['10.0.1.0/24', '192.0.2.0/24'])

    updateGeoSet(ctx.db, 'RU', ['10.0.0.0/24'], 'test')
    const inputs = buildRenderInputs(ctx, site)
    expect(inputs.local.geoHome).toEqual(['10.0.0.0/23', '192.0.2.0/24'])
    expect(inputs.local.forceRemote).toEqual(['198.18.0.0/15'])
  })

  it('peer and identity changes move only the affected hashes', () => {
    const ctx = makeCtx()
    const site = ctx.config().sites[0]
    const before = buildTargets(ctx, site, '1')

    upsertUser(ctx.db, 1, 'alice')
    createConfig(ctx, { tgId: 1, name: 'phone', issuedVia: 'bot' })
    const withPeer = buildTargets(ctx, site, '1')
    expect(withPeer.local.hash).not.toBe(before.local.hash)
    expect(withPeer.remote.hash).toBe(before.remote.hash)

    rotateParams(ctx.db, 'main', 'tunnel')
    const rotated = buildTargets(ctx, site, '1')
    expect(rotated.local.hash).not.toBe(withPeer.local.hash)
    expect(rotated.remote.hash).not.toBe(withPeer.remote.hash)
  })
})
