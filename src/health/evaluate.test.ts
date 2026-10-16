import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import type { ParsedDump } from './dump'
import { Debouncer, evaluateSite, persistSiteHealth, readSiteNetwork, type NodeProbe } from './evaluate'

const NOW = 1_700_000_000
const FRESH = NOW - 30
const STALE = NOW - 600

function dump(ifaces: Record<string, number | null>): ParsedDump {
  const interfaces: ParsedDump['interfaces'] = {}
  for(const [name, hs] of Object.entries(ifaces)) {
    interfaces[name] = {
      publicKey: `${name}Pub=`,
      listenPort: 1,
      peers: hs === null ? [] : [{ publicKey: 'peer=', endpoint: null, latestHandshake: hs, rxBytes: 0, txBytes: 0 }],
    }
  }
  return { interfaces }
}

const local = (awgt: number | null, awgc = true): NodeProbe => ({ reachable: true, dump: dump(awgc ? { awgc: null, awgt } : { awgt }) })
const remote = (awgt: number | null): NodeProbe => ({ reachable: true, dump: dump({ awgt }) })
const gone: NodeProbe = { reachable: false, error: 'timeout' }

describe('evaluateSite', () => {
  it('measures handshake age with the probed node\'s own clock', () => {
    // Node clock is 10 min behind the coordinator: its fresh handshake looks stale by coordinator time.
    const skewed: NodeProbe = { ...local(STALE), nowSec: STALE + 30 }
    expect(evaluateSite(skewed, remote(STALE), NOW)).toMatchObject({ network: 'ok', local: 'ok' })
    // Without nowSec the coordinator clock is used.
    expect(evaluateSite(local(STALE), remote(STALE), NOW).network).toBe('degraded')
    // LOCAL unreachable: REMOTE's age is measured with REMOTE's clock.
    expect(evaluateSite(gone, { ...remote(STALE), nowSec: STALE + 10 }, NOW)).toMatchObject({ network: 'ok', local: 'unknown-mgmt' })
  })

  it.each([
    ['all fresh', local(FRESH), remote(FRESH), 'ok', 'ok', 'ok'],
    ['tunnel stale', local(STALE), remote(STALE), 'degraded', 'degraded', 'degraded'],
    ['tunnel never', local(null), remote(null), 'degraded', 'degraded', 'degraded'],
    ['awgc down', local(FRESH, false), remote(FRESH), 'down', 'down', 'ok'],
    ['LOCAL unreachable, REMOTE fresh (R-H3)', gone, remote(FRESH), 'ok', 'unknown-mgmt', 'ok'],
    ['LOCAL unreachable, REMOTE stale', gone, remote(STALE), 'down', 'down', 'degraded'],
    ['both unreachable', gone, gone, 'down', 'down', 'down'],
    ['REMOTE unreachable, LOCAL fresh', local(FRESH), gone, 'ok', 'ok', 'unknown-mgmt'],
    ['REMOTE unreachable, LOCAL stale', local(STALE), gone, 'degraded', 'degraded', 'down'],
    ['REMOTE awgt missing', local(STALE), { reachable: true, dump: dump({}) }, 'degraded', 'degraded', 'down'],
  ] as const)('%s', (_name, l, r, network, localH, remoteH) => {
    const result = evaluateSite(l, r, NOW)
    expect(result).toMatchObject({ network, local: localH, remote: remoteH })
    expect(result.detail).toBeTypeOf('string')
  })

  it('prefers LOCAL handshake over REMOTE when LOCAL is reachable', () => {
    expect(evaluateSite(local(STALE), remote(FRESH), NOW).network).toBe('degraded')
  })

  it('treats exactly 180 s as stale', () => {
    expect(evaluateSite(local(NOW - 180), remote(null), NOW).network).toBe('degraded')
    expect(evaluateSite(local(NOW - 179), remote(null), NOW).network).toBe('ok')
  })

  it('includes the SSH error in detail', () => {
    expect(evaluateSite(gone, gone, NOW).detail).toContain('timeout')
  })
})

describe('Debouncer', () => {
  it('confirms a change only after 2 identical observations', () => {
    const d = new Debouncer('ok')
    expect(d.observe('degraded')).toBeNull()
    expect(d.observe('degraded')).toBe('degraded')
    expect(d.state).toBe('degraded')
    expect(d.observe('degraded')).toBeNull()
  })

  it('resets on a blip back to the confirmed state or a different state', () => {
    const d = new Debouncer('ok')
    expect(d.observe('down')).toBeNull()
    expect(d.observe('ok')).toBeNull()
    expect(d.observe('down')).toBeNull()
    expect(d.observe('degraded')).toBeNull()
    expect(d.observe('down')).toBeNull()
    expect(d.observe('down')).toBe('down')
    expect(d.observe('ok')).toBeNull()
    expect(d.observe('ok')).toBe('ok')
  })
})

describe('persistSiteHealth', () => {
  it('upserts sites and updates existing hosts rows only', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO nodes (name, role, identity, created_at) VALUES ('main/local', 'local', '{}', 'x')`).run()
    db.prepare(`INSERT INTO hosts (node, address) VALUES ('main/local', '10.0.0.1')`).run()

    expect(readSiteNetwork(db, 'main')).toBeNull()
    persistSiteHealth(db, 'main', { network: 'degraded', local: 'degraded', remote: 'unknown-mgmt', detail: 'd1' }, 't1')
    expect(db.prepare('SELECT * FROM sites').all()).toEqual([{ name: 'main', network: 'degraded', checked_at: 't1' }])
    expect(db.prepare('SELECT health, health_checked_at, health_detail FROM hosts').get())
      .toEqual({ health: 'degraded', health_checked_at: 't1', health_detail: 'd1' })

    persistSiteHealth(db, 'main', { network: 'ok', local: 'ok', remote: 'ok', detail: 'd2' }, 't2')
    expect(readSiteNetwork(db, 'main')).toBe('ok')
    expect(db.prepare('SELECT count(*) AS n FROM hosts').get()).toEqual({ n: 1 })
  })
})
