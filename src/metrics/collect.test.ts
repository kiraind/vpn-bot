import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { createEvents, type AppContext } from '../context'
import type { NodeProbe } from '../health/evaluate'
import type { ProbeRecord } from '../reconcile/loop'
import { createConfig, revokeConfig } from '../services/configs'
import { upsertUser } from '../services/users'
import { exampleConfig } from '../services/testFixtures'
import type { ClientConfigRow } from '../types'
import { collectMetrics, PROBE_STALE_MS } from './collect'

const NOW = new Date('2026-10-16T12:00:00Z')
const NOW_SEC = NOW.getTime() / 1000

function setup() {
  const db = openDb(':memory:')
  const config = exampleConfig()
  const ctx: AppContext = { db, config: () => config, events: createEvents(), alert: async () => {} }
  upsertUser(db, 1, 'alice')
  upsertUser(db, 2, null)
  const make = (tgId: number, name: string) => createConfig(ctx, { tgId, name, issuedVia: 'api' }) as ClientConfigRow
  return { ctx, db, make }
}

function localProbe(peers: { key: string, hs: number, rx: number, tx: number }[]): NodeProbe {
  return {
    reachable: true,
    nowSec: NOW_SEC,
    dump: {
      interfaces: {
        awgc: { publicKey: 'c', listenPort: 1, peers: peers.map(p => ({ publicKey: p.key, endpoint: null, latestHandshake: p.hs, rxBytes: p.rx, txBytes: p.tx })) },
        awgt: { publicKey: 't', listenPort: 0, peers: [{ publicKey: 'r', endpoint: null, latestHandshake: NOW_SEC - 30, rxBytes: 500, txBytes: 700 }] },
      },
    },
    stats: {
      cpuSeconds: { idle: 80, user: 10 },
      cpus: 2,
      load: [0.5, 0.4, 0.3],
      memTotalBytes: 1000,
      memAvailableBytes: 400,
      net: { lo: { rxBytes: 1, txBytes: 1 }, eth0: { rxBytes: 10, txBytes: 20 } },
    },
  }
}

function lines(text: string): string[] {
  return text.split('\n').filter(l => l && !l.startsWith('#'))
}

describe('collectMetrics', () => {
  it('reports per-config traffic, online counts, tunnel and node figures', () => {
    const { ctx, make } = setup()
    const phone = make(1, 'phone')
    const laptop = make(1, 'laptop')
    const other = make(2, 'pc')
    const gone = make(2, 'old')
    revokeConfig(ctx, 2, gone.id)
    const probes = new Map<string, ProbeRecord>([
      ['main/local', { at: NOW, probe: localProbe([
        { key: phone.public_key, hs: NOW_SEC - 10, rx: 100, tx: 2000 },
        { key: laptop.public_key, hs: NOW_SEC - 60, rx: 5, tx: 6 },
        { key: other.public_key, hs: NOW_SEC - 3600, rx: 7, tx: 8 },
        { key: 'stranger=', hs: NOW_SEC, rx: 1, tx: 1 },
      ]) }],
      ['main/remote', { at: NOW, probe: { reachable: false, error: 'timeout' } }],
    ])

    const out = lines(collectMetrics(ctx, { probes, version: '2.0.0', now: NOW, coordinatorStats: { cpus: 1, net: {} } }))

    expect(out).toContain('vpn_coordinator_info{version="2.0.0"} 1')
    expect(out).toContain('vpn_users{status="active"} 2')
    expect(out).toContain('vpn_client_configs{state="active"} 3')
    expect(out).toContain('vpn_client_configs{state="revoked"} 1')
    expect(out).toContain(`vpn_client_upload_bytes_total{site="main",user="@alice",tg_id="1",config="phone",config_id="${phone.id}"} 100`)
    expect(out).toContain(`vpn_client_download_bytes_total{site="main",user="tg:2",tg_id="2",config="pc",config_id="${other.id}"} 8`)
    expect(out).toContain(`vpn_client_last_handshake_timestamp_seconds{site="main",user="@alice",tg_id="1",config="laptop",config_id="${laptop.id}"} ${NOW_SEC - 60}`)
    expect(out.some(l => l.includes('stranger'))).toBe(false)
    expect(out).toContain('vpn_clients_online{site="main"} 2')
    expect(out).toContain('vpn_users_online{site="main"} 1')
    expect(out).toContain('vpn_tunnel_transmit_bytes_total{site="main"} 700')
    expect(out).toContain('vpn_tunnel_receive_bytes_total{site="main"} 500')
    expect(out).toContain('vpn_node_up{node="main/local",site="main",role="local"} 1')
    expect(out).toContain('vpn_node_up{node="main/remote",site="main",role="remote"} 0')
    expect(out).toContain('vpn_node_cpu_seconds_total{node="main/local",site="main",role="local",mode="idle"} 80')
    expect(out).toContain('vpn_node_memory_available_bytes{node="main/local",site="main",role="local"} 400')
    expect(out).toContain('vpn_node_network_transmit_bytes_total{node="main/local",site="main",role="local",device="eth0"} 20')
    expect(out.some(l => l.includes('device="lo"'))).toBe(false)
    expect(out).toContain('vpn_node_cpus{node="coordinator",site="",role="coordinator"} 1')
  })

  it('drops stale probes and escapes label values', () => {
    const { ctx, db, make } = setup()
    db.prepare('UPDATE users SET username = ? WHERE tg_id = 1').run('a"b\\c')
    const phone = make(1, 'phone')
    const stale = new Date(NOW.getTime() - PROBE_STALE_MS - 1000)
    const probes = new Map<string, ProbeRecord>([
      ['main/local', { at: stale, probe: localProbe([{ key: phone.public_key, hs: NOW_SEC, rx: 1, tx: 1 }]) }],
    ])
    let out = lines(collectMetrics(ctx, { probes, version: 'x', now: NOW }))
    expect(out).toContain('vpn_node_up{node="main/local",site="main",role="local"} 0')
    expect(out.some(l => l.startsWith('vpn_client_upload_bytes_total'))).toBe(false)

    probes.set('main/local', { at: NOW, probe: localProbe([{ key: phone.public_key, hs: NOW_SEC, rx: 1, tx: 1 }]) })
    out = lines(collectMetrics(ctx, { probes, version: 'x', now: NOW }))
    expect(out.some(l => l.includes('user="@a\\"b\\\\c"'))).toBe(true)
  })

  it('keeps HELP/TYPE for every family even with no data', () => {
    const { ctx } = setup()
    const text = collectMetrics(ctx, { probes: new Map(), version: 'x', now: NOW })
    expect(text).toContain('# TYPE vpn_client_upload_bytes_total counter')
    expect(text).toContain('# TYPE vpn_node_cpus gauge')
    expect(text.endsWith('\n')).toBe(true)
  })
})
