import type { Db } from '../db'
import { nodeName, type NetworkState } from '../types'
import type { HostStats } from '../metrics/hostStats'
import { latestHandshake, type ParsedDump } from './dump'

// Site health rules (spec section 8). Pure except persistSiteHealth; SSH probing lives elsewhere
// and only hands us NodeProbe values.

export const HANDSHAKE_FRESH_SEC = 180
export const CLIENT_IFACE = 'awgc'
export const TUNNEL_IFACE = 'awgt'

export type NodeHealth = 'ok' | 'down' | 'unknown-mgmt' | 'degraded'

export interface NodeProbe {
  reachable: boolean
  dump?: ParsedDump
  error?: string
  /** The probed node's own clock (unix s) at dump time; handshake ages use it to ignore clock skew. */
  nowSec?: number
  /** CPU/RAM/disk/network of the node for /metrics; absent if reading /proc failed. */
  stats?: HostStats
}

export interface SiteHealth {
  network: NetworkState
  local: NodeHealth
  remote: NodeHealth
  detail: string
}

function isUp(probe: NodeProbe, iface: string): boolean {
  return probe.reachable && !!probe.dump?.interfaces[iface]
}

function handshakeAge(probe: NodeProbe, nowSec: number): number | null {
  if(!probe.reachable || !probe.dump) {
    return null
  }

  const at = latestHandshake(probe.dump, TUNNEL_IFACE)

  // Handshake timestamps come from the node's clock, so measure their age with the same clock.
  return at > 0 ? Math.max(0, (probe.nowSec ?? nowSec) - at) : null
}

function unreachable(probe: NodeProbe): string {
  return probe.error ? `SSH недоступен: ${probe.error}` : 'SSH недоступен'
}

export function evaluateSite(local: NodeProbe, remote: NodeProbe, nowSec: number): SiteHealth {
  // LOCAL's view of the tunnel wins; REMOTE's is only consulted when LOCAL can't be asked (R-H3).
  const age = local.reachable ? handshakeAge(local, nowSec) : handshakeAge(remote, nowSec)
  const fresh = age !== null && age < HANDSHAKE_FRESH_SEC
  const tunnelText = age === null ? 'handshake не было' : `последний handshake ${age} с назад`

  let localHealth: NodeHealth
  let localText: string

  if(!local.reachable) {
    localHealth = fresh ? 'unknown-mgmt' : 'down'
    localText = fresh ? `LOCAL: ${unreachable(local)}, но REMOTE видит свежий handshake` : `LOCAL: ${unreachable(local)}`
  }
  else if(!isUp(local, CLIENT_IFACE)) {
    localHealth = 'down'
    localText = `LOCAL: интерфейс ${CLIENT_IFACE} не поднят`
  }
  else if(!fresh) {
    localHealth = 'degraded'
    localText = `LOCAL: туннель до REMOTE не отвечает (${tunnelText})`
  }
  else {
    localHealth = 'ok'
    localText = 'LOCAL: ok'
  }

  let remoteHealth: NodeHealth
  let remoteText: string

  if(!remote.reachable) {
    remoteHealth = fresh ? 'unknown-mgmt' : 'down'
    remoteText = fresh ? `REMOTE: ${unreachable(remote)}, но LOCAL видит свежий handshake` : `REMOTE: ${unreachable(remote)}`
  }
  else if(!isUp(remote, TUNNEL_IFACE)) {
    remoteHealth = 'down'
    remoteText = `REMOTE: интерфейс ${TUNNEL_IFACE} не поднят`
  }
  else if(!fresh) {
    remoteHealth = 'degraded'
    remoteText = `REMOTE: туннель не отвечает (${tunnelText})`
  }
  else {
    remoteHealth = 'ok'
    remoteText = 'REMOTE: ok'
  }

  // unknown-mgmt LOCAL still carries traffic as far as we can tell, so it's not an outage.
  const network: NetworkState = localHealth === 'down' ? 'down' : localHealth === 'degraded' ? 'degraded' : 'ok'

  return { network, local: localHealth, remote: remoteHealth, detail: `${localText}; ${remoteText}` }
}

/** R-H4: a state change is confirmed only after 2 consecutive identical observations. */
export class Debouncer {
  private pending: NetworkState | null = null
  private count = 0

  constructor(private confirmed: NetworkState, private readonly threshold = 2) {}

  get state(): NetworkState {
    return this.confirmed
  }

  /** Returns the newly confirmed state, or null when nothing changed (yet). */
  observe(state: NetworkState): NetworkState | null {
    if(state === this.confirmed) {
      this.pending = null
      this.count = 0
      return null
    }

    if(state !== this.pending) {
      this.pending = state
      this.count = 0
    }

    this.count += 1

    if(this.count < this.threshold) {
      return null
    }

    this.confirmed = state
    this.pending = null
    this.count = 0

    return state
  }
}

export function readSiteNetwork(db: Db, site: string): NetworkState | null {
  const row = db.prepare('SELECT network FROM sites WHERE name = ?').get(site) as { network: NetworkState } | undefined

  return row?.network ?? null
}

/**
 * Stores the raw (non-debounced) node health and the given network state. Callers pass the
 * debounced network in `result.network` if that's what the API should expose (R-A6).
 */
export function persistSiteHealth(db: Db, site: string, result: SiteHealth, at: string): void {
  const upsertSite = db.prepare(`
    INSERT INTO sites (name, network, checked_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET network = excluded.network, checked_at = excluded.checked_at
  `)
  const updateHost = db.prepare('UPDATE hosts SET health = ?, health_checked_at = ?, health_detail = ? WHERE node = ?')

  db.transaction(() => {
    upsertSite.run(site, result.network, at)
    updateHost.run(result.local, at, result.detail, nodeName(site, 'local'))
    updateHost.run(result.remote, at, result.detail, nodeName(site, 'remote'))
  })()
}
