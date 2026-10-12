import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { ensureSiteIdentities, getLocalIdentity, getRemoteIdentity, PORT_MAX, PORT_MIN, rotateParams, syncProtocols } from './identity'
import { exampleConfig } from './testFixtures'

describe('ensureSiteIdentities', () => {
  it('creates local and remote identities once', () => {
    const db = openDb(':memory:')
    const config = exampleConfig()
    expect(ensureSiteIdentities(db, config)).toEqual(['main/local', 'main/remote'])
    const local = getLocalIdentity(db, 'main')
    const remote = getRemoteIdentity(db, 'main')

    expect(local.role).toBe('local')
    expect(local.awgc.protocol).toBe('awg2')
    expect(local.awgc.listenPort).toBeGreaterThanOrEqual(PORT_MIN)
    expect(local.awgc.listenPort).toBeLessThanOrEqual(PORT_MAX)
    expect(Object.keys(local.awgc.params)).toContain('H1')
    expect(local.awgt.publicKey).toHaveLength(44)
    expect(remote.awgt.presharedKey).toHaveLength(44)
    expect(remote.awgt.params.S1).toBeDefined()

    expect(ensureSiteIdentities(db, config)).toEqual([])
    expect(getLocalIdentity(db, 'main')).toEqual(local)
    expect(getRemoteIdentity(db, 'main')).toEqual(remote)
  })

  it('adds identities for a new site only', () => {
    const db = openDb(':memory:')
    const config = exampleConfig()
    ensureSiteIdentities(db, config)
    const two = { ...config, sites: [...config.sites, { ...config.sites[0], name: 'second' }] }
    expect(ensureSiteIdentities(db, two)).toEqual(['second/local', 'second/remote'])
  })

  it('throws for missing identities', () => {
    const db = openDb(':memory:')
    expect(() => getLocalIdentity(db, 'nope')).toThrow()
    expect(() => getRemoteIdentity(db, 'nope')).toThrow()
  })
})

describe('rotateParams', () => {
  it('regenerates only params of the chosen interface', () => {
    const db = openDb(':memory:')
    ensureSiteIdentities(db, exampleConfig())
    const local = getLocalIdentity(db, 'main')
    const remote = getRemoteIdentity(db, 'main')

    rotateParams(db, 'main', 'clients')
    const local2 = getLocalIdentity(db, 'main')
    expect(local2.awgc.params).not.toEqual(local.awgc.params)
    expect({ ...local2.awgc, params: null }).toEqual({ ...local.awgc, params: null })
    expect(local2.awgt).toEqual(local.awgt)
    expect(getRemoteIdentity(db, 'main')).toEqual(remote)

    rotateParams(db, 'main', 'tunnel')
    const remote2 = getRemoteIdentity(db, 'main')
    expect(remote2.awgt.params).not.toEqual(remote.awgt.params)
    expect({ ...remote2.awgt, params: null }).toEqual({ ...remote.awgt, params: null })
  })
})

describe('syncProtocols', () => {
  it('is a no-op when protocols match and regenerates params when they differ', () => {
    const db = openDb(':memory:')
    const config = exampleConfig()
    ensureSiteIdentities(db, config)
    expect(syncProtocols(db, config)).toEqual([])

    // Only awg2 exists today, so simulate an identity left over from another profile
    const local = getLocalIdentity(db, 'main')
    const stale = { ...local, awgc: { ...local.awgc, protocol: 'awg1' as never } }
    db.prepare('UPDATE nodes SET identity = ? WHERE name = ?').run(JSON.stringify(stale), 'main/local')

    expect(syncProtocols(db, config)).toEqual(['main'])
    const synced = getLocalIdentity(db, 'main')
    expect(synced.awgc.protocol).toBe('awg2')
    expect(synced.awgc.params).not.toEqual(local.awgc.params)
    expect(synced.awgc.privateKey).toBe(local.awgc.privateKey)
    expect(syncProtocols(db, config)).toEqual([])
  })
})
