import type { AppContext } from '../context'
import { CLIENT_IFACE, HANDSHAKE_FRESH_SEC, TUNNEL_IFACE } from '../health/evaluate'
import type { ProbeRecord } from '../reconcile/loop'
import { nodeName, type NodeRole } from '../types'
import { Exposition, type Labels } from './exposition'
import type { HostStats } from './hostStats'

// /metrics for Prometheus (R-O7). Nothing is sampled here except the coordinator's own host:
// node figures come from the minute health probe (awg dump + /proc), the rest from the DB.
// Counters are the raw awg / kernel counters; they reset with the interface or the host,
// which Prometheus' rate()/increase() handle.

/** Probes older than this are not reported: a node being provisioned is skipped by health checks. */
export const PROBE_STALE_MS = 5 * 60_000
/** Devices that talked to the API within this window count in vpn_app_devices. */
export const APP_ACTIVE_DAYS = 30

export interface MetricsInput {
  probes: ReadonlyMap<string, ProbeRecord>
  /** The coordinator's own host; undefined when it couldn't be read. */
  coordinatorStats?: HostStats
  version: string
  now: Date
}

interface ConfigRef {
  id: string
  name: string
  tgId: number
  user: string
}

const NETWORK_STATES = ['ok', 'degraded', 'down'] as const

function declareAll(m: Exposition) {
  m.declare('vpn_coordinator_info', 'gauge', 'Coordinator version')
  m.declare('vpn_users', 'gauge', 'Users by status (revoked = /revoke_user)')
  m.declare('vpn_client_configs', 'gauge', 'Client configs by state')
  m.declare('vpn_app_devices', 'gauge', `App device tokens seen in the last ${APP_ACTIVE_DAYS} days by app version`)
  m.declare('vpn_site_network', 'gauge', 'Site network state (1 for the current state)')
  m.declare('vpn_node_up', 'gauge', 'Node answered the last health probe over SSH')
  m.declare('vpn_node_last_probe_timestamp_seconds', 'gauge', 'When the node was last probed')
  m.declare('vpn_client_upload_bytes_total', 'counter', 'Bytes received by LOCAL from the client config (client upload)')
  m.declare('vpn_client_download_bytes_total', 'counter', 'Bytes sent by LOCAL to the client config (client download)')
  m.declare('vpn_client_last_handshake_timestamp_seconds', 'gauge', 'Latest handshake of the client config')
  m.declare('vpn_clients_online', 'gauge', `Client configs with a handshake in the last ${HANDSHAKE_FRESH_SEC} s`)
  m.declare('vpn_users_online', 'gauge', `Users with a handshake in the last ${HANDSHAKE_FRESH_SEC} s`)
  m.declare('vpn_tunnel_transmit_bytes_total', 'counter', 'Bytes LOCAL sent to REMOTE over the tunnel (traffic exiting abroad)')
  m.declare('vpn_tunnel_receive_bytes_total', 'counter', 'Bytes LOCAL received from REMOTE over the tunnel')
  m.declare('vpn_tunnel_last_handshake_timestamp_seconds', 'gauge', 'Latest LOCAL-REMOTE tunnel handshake')
  m.declare('vpn_node_cpu_seconds_total', 'counter', 'CPU time over all cores by mode')
  m.declare('vpn_node_cpus', 'gauge', 'Number of CPUs')
  m.declare('vpn_node_load1', 'gauge', '1-minute load average')
  m.declare('vpn_node_load5', 'gauge', '5-minute load average')
  m.declare('vpn_node_load15', 'gauge', '15-minute load average')
  m.declare('vpn_node_uptime_seconds', 'gauge', 'Host uptime')
  m.declare('vpn_node_memory_total_bytes', 'gauge', 'MemTotal')
  m.declare('vpn_node_memory_available_bytes', 'gauge', 'MemAvailable')
  m.declare('vpn_node_swap_total_bytes', 'gauge', 'SwapTotal')
  m.declare('vpn_node_swap_free_bytes', 'gauge', 'SwapFree')
  m.declare('vpn_node_disk_total_bytes', 'gauge', 'Root filesystem size')
  m.declare('vpn_node_disk_available_bytes', 'gauge', 'Root filesystem space available')
  m.declare('vpn_node_network_receive_bytes_total', 'counter', 'Bytes received by network device')
  m.declare('vpn_node_network_transmit_bytes_total', 'counter', 'Bytes sent by network device')
}

function addHostStats(m: Exposition, labels: Labels, stats: HostStats) {
  for(const [mode, seconds] of Object.entries(stats.cpuSeconds ?? {})) m.add('vpn_node_cpu_seconds_total', { ...labels, mode }, seconds)
  if(stats.cpus !== undefined) m.add('vpn_node_cpus', labels, stats.cpus)
  if(stats.load) {
    m.add('vpn_node_load1', labels, stats.load[0])
    m.add('vpn_node_load5', labels, stats.load[1])
    m.add('vpn_node_load15', labels, stats.load[2])
  }
  if(stats.uptimeSec !== undefined) m.add('vpn_node_uptime_seconds', labels, stats.uptimeSec)
  if(stats.memTotalBytes !== undefined) m.add('vpn_node_memory_total_bytes', labels, stats.memTotalBytes)
  if(stats.memAvailableBytes !== undefined) m.add('vpn_node_memory_available_bytes', labels, stats.memAvailableBytes)
  if(stats.swapTotalBytes !== undefined) m.add('vpn_node_swap_total_bytes', labels, stats.swapTotalBytes)
  if(stats.swapFreeBytes !== undefined) m.add('vpn_node_swap_free_bytes', labels, stats.swapFreeBytes)
  if(stats.diskTotalBytes !== undefined) m.add('vpn_node_disk_total_bytes', labels, stats.diskTotalBytes)
  if(stats.diskAvailableBytes !== undefined) m.add('vpn_node_disk_available_bytes', labels, stats.diskAvailableBytes)
  for(const [device, net] of Object.entries(stats.net)) {
    if(device === 'lo') continue
    m.add('vpn_node_network_receive_bytes_total', { ...labels, device }, net.rxBytes)
    m.add('vpn_node_network_transmit_bytes_total', { ...labels, device }, net.txBytes)
  }
}

function userLabel(tgId: number, username: string | null): string {
  return username ? `@${username}` : `tg:${tgId}`
}

export function collectMetrics(ctx: AppContext, input: MetricsInput): string {
  const { db } = ctx
  const m = new Exposition()
  declareAll(m)
  const nowMs = input.now.getTime()

  m.add('vpn_coordinator_info', { version: input.version }, 1)

  const users = db.prepare('SELECT tg_id, username, status, revoked_at FROM users').all() as
    { tg_id: number, username: string | null, status: string, revoked_at: string | null }[]
  const userCounts: Record<string, number> = { active: 0, suspended: 0, revoked: 0 }
  const names = new Map<number, string>()
  for(const u of users) {
    userCounts[u.revoked_at ? 'revoked' : u.status] = (userCounts[u.revoked_at ? 'revoked' : u.status] ?? 0) + 1
    names.set(u.tg_id, userLabel(u.tg_id, u.username))
  }
  for(const [status, n] of Object.entries(userCounts)) m.add('vpn_users', { status }, n)

  const configs = db.prepare('SELECT id, tg_id, name, public_key, state FROM client_configs').all() as
    { id: string, tg_id: number, name: string, public_key: string, state: string }[]
  const configCounts: Record<string, number> = { active: 0, suspended: 0, revoked: 0 }
  const byKey = new Map<string, ConfigRef>()
  for(const c of configs) {
    configCounts[c.state] = (configCounts[c.state] ?? 0) + 1
    // A live config wins over a revoked one with the same key (keys are fresh per config anyway).
    if(c.state !== 'revoked' || !byKey.has(c.public_key)) {
      byKey.set(c.public_key, { id: c.id, name: c.name, tgId: c.tg_id, user: names.get(c.tg_id) ?? `tg:${c.tg_id}` })
    }
  }
  for(const [state, n] of Object.entries(configCounts)) m.add('vpn_client_configs', { state }, n)

  const since = new Date(nowMs - APP_ACTIVE_DAYS * 86_400_000).toISOString()
  const versions = db.prepare(`
    SELECT COALESCE(app_version, 'unknown') AS version, COUNT(*) AS n FROM device_tokens
    WHERE revoked_at IS NULL AND last_seen_at >= ? GROUP BY 1 ORDER BY 1
  `).all(since) as { version: string, n: number }[]
  for(const v of versions) m.add('vpn_app_devices', { version: v.version }, v.n)

  const networks = new Map((db.prepare('SELECT name, network FROM sites').all() as { name: string, network: string }[])
    .map(row => [row.name, row.network]))

  for(const site of ctx.config().sites) {
    const network = networks.get(site.name)
    if(network) {
      for(const state of NETWORK_STATES) m.add('vpn_site_network', { site: site.name, state }, network === state ? 1 : 0)
    }

    for(const role of ['local', 'remote'] as NodeRole[]) {
      const node = nodeName(site.name, role)
      const labels = { node, site: site.name, role }
      const record = input.probes.get(node)
      if(!record) continue
      m.add('vpn_node_last_probe_timestamp_seconds', labels, Math.floor(record.at.getTime() / 1000))
      const fresh = nowMs - record.at.getTime() <= PROBE_STALE_MS
      const probe = record.probe
      m.add('vpn_node_up', labels, fresh && probe.reachable ? 1 : 0)
      if(!fresh || !probe.reachable) continue

      if(probe.stats) addHostStats(m, labels, probe.stats)
      if(role !== 'local' || !probe.dump) continue

      const nowSec = probe.nowSec ?? Math.floor(nowMs / 1000)
      const online = new Set<string>()
      const onlineUsers = new Set<number>()
      for(const peer of probe.dump.interfaces[CLIENT_IFACE]?.peers ?? []) {
        const ref = byKey.get(peer.publicKey)
        if(!ref) continue
        const peerLabels = { site: site.name, user: ref.user, tg_id: String(ref.tgId), config: ref.name, config_id: ref.id }
        m.add('vpn_client_upload_bytes_total', peerLabels, peer.rxBytes)
        m.add('vpn_client_download_bytes_total', peerLabels, peer.txBytes)
        if(peer.latestHandshake > 0) {
          m.add('vpn_client_last_handshake_timestamp_seconds', peerLabels, peer.latestHandshake)
          if(nowSec - peer.latestHandshake < HANDSHAKE_FRESH_SEC) {
            online.add(ref.id)
            onlineUsers.add(ref.tgId)
          }
        }
      }
      if(probe.dump.interfaces[CLIENT_IFACE]) {
        m.add('vpn_clients_online', { site: site.name }, online.size)
        m.add('vpn_users_online', { site: site.name }, onlineUsers.size)
      }

      const tunnel = probe.dump.interfaces[TUNNEL_IFACE]
      if(tunnel) {
        const sum = (f: 'rxBytes' | 'txBytes') => tunnel.peers.reduce((acc, p) => acc + p[f], 0)
        m.add('vpn_tunnel_transmit_bytes_total', { site: site.name }, sum('txBytes'))
        m.add('vpn_tunnel_receive_bytes_total', { site: site.name }, sum('rxBytes'))
        const hs = tunnel.peers.reduce((max, p) => Math.max(max, p.latestHandshake), 0)
        if(hs > 0) m.add('vpn_tunnel_last_handshake_timestamp_seconds', { site: site.name }, hs)
      }
    }
  }

  if(input.coordinatorStats) addHostStats(m, { node: 'coordinator', site: '', role: 'coordinator' }, input.coordinatorStats)

  return m.render()
}
