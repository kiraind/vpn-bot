import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db'
import { createEvents, type AppContext } from '../context'
import type { CoordinatorConfig } from '../config/schema'
import type { NodeTarget, ProvisionDeps, ProvisionResult } from '../provision/node'
import type { NodeProbe } from '../health/evaluate'
import type { HostRow } from '../types'
import { HostKeyMismatchError } from '../ssh/client'
import { ensureSiteIdentities } from '../services/identity'
import { exampleConfig } from '../services/testFixtures'
import { getGeoSet, updateGeoSet } from '../geo/store'
import { backoffMinutes, NodeLock, Reconciler, type ReconcilerDeps } from './loop'

const T0 = new Date('2026-10-12T00:00:00Z')

interface Harness {
  ctx: AppContext
  rec: Reconciler
  alerts: { text: string, announce: boolean }[]
  provision: ReturnType<typeof vi.fn>
  probe: ReturnType<typeof vi.fn>
  clock: { now: Date }
  reload: { result: { ok: boolean, errors?: string[] } }
  host(node: string): HostRow
}

function setup(over: Partial<ReconcilerDeps> = {}, patch: (c: CoordinatorConfig) => void = () => {}): Harness {
  const db = openDb(':memory:')
  const config = exampleConfig()
  patch(config)
  ensureSiteIdentities(db, config)
  const alerts: Harness['alerts'] = []
  const ctx: AppContext = {
    db,
    config: () => config,
    events: createEvents(),
    alert: async (text, opts) => { alerts.push({ text, announce: !!opts?.announce }) },
  }
  const clock = { now: T0 }
  const reload: Harness['reload'] = { result: { ok: true } }
  const provision = vi.fn(async (): Promise<ProvisionResult> => ({ outcome: 'applied', bootstrapped: false }))
  const probe = vi.fn(async (): Promise<NodeProbe> => ({ reachable: true }))
  const provisionDeps = { db, key: {}, coordinatorVersion: 'test' } as unknown as ProvisionDeps
  const rec = new Reconciler(ctx, {
    provision: provision as unknown as ReconcilerDeps['provision'],
    probe: probe as unknown as ReconcilerDeps['probe'],
    provisionDeps,
    reloadConfig: () => reload.result,
    now: () => clock.now,
    coordinatorVersion: 'test',
    ...over,
  })
  const host = (node: string) => db.prepare('SELECT * FROM hosts WHERE node = ?').get(node) as HostRow
  return { ctx, rec, alerts, provision, probe, clock, reload, host }
}

function minutes(m: number) {
  return new Date(T0.getTime() + m * 60_000)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('backoff', () => {
  it('doubles from 1 minute and caps at 30', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMinutes)).toEqual([1, 2, 4, 8, 16, 30, 30, 30])
  })

  it('skips a failing node until next_attempt_at, alerts once, then announces recovery', async () => {
    const h = setup()
    h.provision.mockImplementation(async (_deps: ProvisionDeps, target: NodeTarget) => {
      if(target.node === 'main/remote') throw new Error('boom')
      return { outcome: 'applied', bootstrapped: false }
    })

    const r1 = await h.rec.runCycle()
    expect(r1).toEqual(expect.arrayContaining([
      { node: 'main/local', outcome: 'applied' },
      { node: 'main/remote', outcome: 'error', message: 'boom' },
    ]))
    expect(h.host('main/remote')).toMatchObject({
      consecutive_failures: 1, last_error: 'boom', phase: 'error', next_attempt_at: minutes(1).toISOString(), address: '198.51.100.20',
    })
    expect(h.host('main/local')).toMatchObject({ consecutive_failures: 0, phase: 'ready', last_ok_at: T0.toISOString() })
    expect(h.alerts.map(a => a.text)).toEqual(['main/remote: ошибка apply: boom'])

    // Still in backoff: not attempted.
    h.clock.now = new Date(T0.getTime() + 30_000)
    const r2 = await h.rec.runCycle({ nodes: new Set(['main/remote']) })
    expect(r2[0].outcome).toBe('skipped')
    expect(h.provision).toHaveBeenCalledTimes(2)

    // Progression: 1, 2, 4, 8, 16, 30, 30 minutes.
    const waits: number[] = []
    for(let i = 0; i < 6; i += 1) {
      h.clock.now = new Date(Date.parse(h.host('main/remote').next_attempt_at!) + 1)
      const before = h.clock.now.getTime()
      await h.rec.runCycle({ nodes: new Set(['main/remote']) })
      waits.push(Math.round((Date.parse(h.host('main/remote').next_attempt_at!) - before) / 60_000))
    }
    expect(waits).toEqual([2, 4, 8, 16, 30, 30])
    expect(h.host('main/remote').consecutive_failures).toBe(7)
    expect(h.alerts).toHaveLength(1)

    h.provision.mockResolvedValue({ outcome: 'applied', bootstrapped: false })
    await h.rec.applyNow()
    expect(h.host('main/remote')).toMatchObject({ consecutive_failures: 0, next_attempt_at: null, phase: 'ready' })
    expect(h.alerts.map(a => a.text)).toEqual(['main/remote: ошибка apply: boom', 'main/remote: снова в порядке'])
  })

  it('names the bootstrap stage and gives host-key mismatches their own text', async () => {
    const h = setup()
    h.provision.mockImplementation(async (deps: ProvisionDeps, target: NodeTarget) => {
      if(target.node === 'main/local') {
        deps.onPhase?.('bootstrapping')
        throw new Error('apt failed')
      }
      throw new HostKeyMismatchError(target.host, 'SHA256:x')
    })
    await h.rec.runCycle()
    const texts = h.alerts.map(a => a.text)
    expect(texts).toContain('main/local: ошибка bootstrap: apt failed')
    expect(texts.find(t => t.startsWith('main/remote'))).toMatch(/\/trust main\/remote/)
  })

  it('an address change resets the backoff', async () => {
    const h = setup()
    h.provision.mockRejectedValue(new Error('dead'))
    await h.rec.runCycle()
    expect(h.host('main/remote').consecutive_failures).toBe(1)

    h.ctx.config().sites[0].remote.addresses.outer = '192.0.2.50'
    h.provision.mockResolvedValue({ outcome: 'applied', bootstrapped: true })
    const reports = await h.rec.runCycle({ nodes: new Set(['main/remote']) })
    expect(reports).toEqual([{ node: 'main/remote', outcome: 'applied' }])
    expect(h.host('main/remote')).toMatchObject({ address: '192.0.2.50', consecutive_failures: 0 })
    // The streak was reset by the address change, so no "recovered" message for the new host.
    expect(h.alerts.filter(a => a.text.includes('снова в порядке'))).toHaveLength(0)
  })
})

describe('serialization', () => {
  it('NodeLock runs one operation at a time and reports busy', async () => {
    const lock = new NodeLock()
    let active = 0
    let max = 0
    const op = () => lock.run(async () => {
      active += 1
      max = Math.max(max, active)
      await new Promise(r => setTimeout(r, 5))
      active -= 1
    })
    const all = Promise.all([op(), op(), lock.run(async () => { throw new Error('x') }).catch(() => {}), op()])
    expect(lock.busy).toBe(true)
    await all
    expect(max).toBe(1)
    expect(lock.busy).toBe(false)
  })

  it('overlapping cycles never provision the same node concurrently and coalesce into one follow-up', async () => {
    const h = setup()
    const active = new Map<string, number>()
    let maxActive = 0
    h.provision.mockImplementation(async (_deps: ProvisionDeps, target: NodeTarget) => {
      const n = (active.get(target.node) ?? 0) + 1
      active.set(target.node, n)
      maxActive = Math.max(maxActive, n)
      await new Promise(r => setTimeout(r, 10))
      active.set(target.node, n - 1)
      return { outcome: 'up-to-date', bootstrapped: false }
    })

    const first = h.rec.runCycle()
    const second = h.rec.runCycle({ nodes: new Set(['main/local']) })
    const third = h.rec.trust('main/remote')
    const [a, b, c] = await Promise.all([first, second, third])

    expect(maxActive).toBe(1)
    expect(a).toHaveLength(2)
    expect(b).toEqual([{ node: 'main/local', outcome: 'up-to-date' }])
    expect(c).toEqual([{ node: 'main/remote', outcome: 'up-to-date' }])
    // first cycle (2 nodes) + one merged follow-up (local + remote)
    expect(h.provision).toHaveBeenCalledTimes(4)
    const forced = h.provision.mock.calls.filter(call => call[2]?.force).map(call => (call[1] as NodeTarget).node)
    expect(forced).toEqual(['main/remote'])
  })
})

describe('triggers', () => {
  it('peers-changed reconciles only LOCAL, within seconds, debounced', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.rec.start()
    await vi.advanceTimersByTimeAsync(0)
    h.provision.mockClear()

    h.ctx.events.emit('peers-changed')
    h.ctx.events.emit('peers-changed')
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.provision).toHaveBeenCalledTimes(1)
    expect((h.provision.mock.calls[0][1] as NodeTarget).node).toBe('main/local')

    h.provision.mockClear()
    h.ctx.events.emit('identity-changed', 'main')
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.provision.mock.calls.map(call => (call[1] as NodeTarget).node).sort()).toEqual(['main/local', 'main/remote'])

    h.rec.stop()
    h.provision.mockClear()
    h.ctx.events.emit('peers-changed')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.provision).not.toHaveBeenCalled()
  })

  it('runs a cycle every 5 minutes', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.rec.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.provision).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.provision).toHaveBeenCalledTimes(4)
    h.rec.stop()
  })
})

describe('config reload', () => {
  it('alerts once per distinct error set and keeps reconciling with the last valid config', async () => {
    const h = setup()
    h.reload.result = { ok: false, errors: ['sites.0.name: bad'] }
    await h.rec.runCycle()
    await h.rec.runCycle()
    expect(h.provision).toHaveBeenCalledTimes(4)
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0].text).toMatch(/sites\.0\.name: bad/)

    h.reload.result = { ok: false, errors: ['other'] }
    await h.rec.runCycle()
    expect(h.alerts).toHaveLength(2)

    h.reload.result = { ok: true }
    await h.rec.runCycle()
    h.reload.result = { ok: false, errors: ['other'] }
    await h.rec.runCycle()
    expect(h.alerts).toHaveLength(3)
  })
})

describe('control', () => {
  it('rotate regenerates params, emits identity-changed and applies', async () => {
    const h = setup()
    const seen: string[] = []
    h.ctx.events.on('identity-changed', site => seen.push(site))
    const before = h.ctx.db.prepare("SELECT identity FROM nodes WHERE name = 'main/remote'").get()
    const reports = await h.rec.rotate('tunnel')
    expect(seen).toEqual(['main'])
    expect(h.ctx.db.prepare("SELECT identity FROM nodes WHERE name = 'main/remote'").get()).not.toEqual(before)
    expect(reports.map(r => r.outcome)).toEqual(['applied', 'applied'])
  })

  it('emits local-applied only after LOCAL actually applied (R-O5 resend point)', async () => {
    const h = setup()
    const applied: string[] = []
    h.ctx.events.on('local-applied', node => applied.push(node))
    await h.rec.applyNow()
    expect(applied).toEqual(['main/local'])
    h.provision.mockResolvedValue({ outcome: 'up-to-date', bootstrapped: false })
    await h.rec.applyNow()
    expect(applied).toEqual(['main/local'])
  })

  it('trust clears the pinned key of the node address; unknown node is an error', async () => {
    const h = setup()
    h.ctx.db.prepare("INSERT INTO known_hosts (address, host_key, first_seen_at) VALUES ('203.0.113.11', 'SHA256:old', 'x')").run()
    await h.rec.trust('main/local')
    expect(h.ctx.db.prepare("SELECT host_key FROM known_hosts WHERE address = '203.0.113.11'").get()).toEqual({ host_key: null })
    expect(await h.rec.trust('nope/local')).toEqual([{ node: 'nope/local', outcome: 'error', message: 'неизвестный узел nope/local' }])
  })
})

function probeWith(tunnelHandshake: number): NodeProbe {
  return {
    reachable: true,
    dump: {
      interfaces: {
        awgc: { publicKey: 'c', listenPort: 1, peers: [] },
        awgt: { publicKey: 't', listenPort: 2, peers: [{ publicKey: 'p', endpoint: null, latestHandshake: tunnelHandshake }] },
      },
    },
  }
}

describe('health', () => {
  it('first observation is the baseline; transitions need 2 checks and are announced', async () => {
    const h = setup()
    await h.rec.runCycle() // creates hosts rows
    const nowSec = T0.getTime() / 1000
    let state: 'ok' | 'degraded' = 'ok'
    h.probe.mockImplementation(async () => probeWith(state === 'ok' ? nowSec - 10 : 0))

    await h.rec.runHealth()
    expect(h.alerts).toHaveLength(0)
    expect(h.ctx.db.prepare("SELECT network FROM sites WHERE name = 'main'").get()).toEqual({ network: 'ok' })

    state = 'degraded'
    await h.rec.runHealth()
    expect(h.alerts).toHaveLength(0)
    expect(h.ctx.db.prepare("SELECT network FROM sites WHERE name = 'main'").get()).toEqual({ network: 'ok' })
    expect(h.host('main/local').health).toBe('degraded')

    await h.rec.runHealth()
    expect(h.alerts.map(a => a.announce)).toEqual([false, true])
    expect(h.alerts[0].text).toMatch(/main: ok → degraded/)
    expect(h.ctx.db.prepare("SELECT network FROM sites WHERE name = 'main'").get()).toEqual({ network: 'degraded' })
  })

  it('seeds from the stored network state and skips a site whose node is being provisioned', async () => {
    const h = setup()
    h.ctx.db.prepare("INSERT INTO sites (name, network) VALUES ('main', 'down')").run()
    h.probe.mockResolvedValue(probeWith(T0.getTime() / 1000 - 5))

    let release!: () => void
    h.provision.mockImplementation(() => new Promise(r => { release = () => r({ outcome: 'applied', bootstrapped: false }) }))
    const cycle = h.rec.runCycle({ nodes: new Set(['main/local']) })
    await new Promise(r => setTimeout(r, 0))
    await h.rec.runHealth()
    expect(h.probe).not.toHaveBeenCalled()
    release()
    await cycle

    await h.rec.runHealth()
    await h.rec.runHealth()
    expect(h.alerts[0].text).toMatch(/down → ok/)
  })
})

describe('geo', () => {
  it('refreshes stale sets and schedules LOCAL; refusals and failures alert admins', async () => {
    vi.useFakeTimers()
    const fetchGeo = vi.fn(async () => ['10.0.0.0/8', '11.0.0.0/8', '12.0.0.0/8', '13.0.0.0/8'])
    const h = setup({ fetchGeo })
    expect(await h.rec.refreshGeo()).toEqual(['RU'])
    expect(getGeoSet(h.ctx.db, 'RU')?.count).toBe(4)
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.provision.mock.calls.map(call => (call[1] as NodeTarget).node)).toEqual(['main/local'])

    // Fresh: not fetched again.
    expect(await h.rec.refreshGeo()).toEqual([])
    expect(fetchGeo).toHaveBeenCalledTimes(1)

    // A week later the download is suspiciously small → refused, old set stays.
    h.clock.now = new Date(Date.now() + 8 * 24 * 3600_000)
    vi.setSystemTime(h.clock.now)
    h.ctx.db.prepare("UPDATE geo_sets SET fetched_at = '2000-01-01T00:00:00Z'").run()
    fetchGeo.mockResolvedValueOnce(['10.0.0.0/8'])
    expect(await h.rec.refreshGeo()).toEqual([])
    expect(h.alerts.at(-1)?.text).toMatch(/geo RU: новая выгрузка отклонена \(new set too small/)
    expect(getGeoSet(h.ctx.db, 'RU')?.count).toBe(4)

    fetchGeo.mockRejectedValueOnce(new Error('HTTP 503'))
    expect(await h.rec.refreshGeo()).toEqual([])
    expect(h.alerts.at(-1)?.text).toMatch(/HTTP 503.*остаётся прежний набор/)
  })

  it('updateGeoSet refusal on an empty first download', async () => {
    const h = setup({ fetchGeo: async () => [] })
    expect(await h.rec.refreshGeo()).toEqual([])
    expect(h.alerts[0].text).toMatch(/empty set/)
    expect(updateGeoSet(h.ctx.db, 'RU', ['1.0.0.0/8'], 'x').updated).toBe(true)
  })
})
