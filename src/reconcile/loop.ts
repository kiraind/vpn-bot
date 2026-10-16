import type { AlertOptions, AppContext } from '../context'
import type { SiteConfig } from '../config/schema'
import type { NodeTarget, ProvisionDeps, ProvisionPhase, probeNode, provisionNode, retireNode } from '../provision/node'
import type { HostRow, NodeRole } from '../types'
import { nodeName } from '../types'
import { ensureSiteIdentities, rotateParams, syncProtocols } from '../services/identity'
import { trustAddress } from '../ssh/knownHosts'
import { HostKeyMismatchError, SshAuthError } from '../ssh/client'
import { Debouncer, evaluateSite, persistSiteHealth, readSiteNetwork, type NodeProbe } from '../health/evaluate'
import { notifyTransition } from '../health/notify'
import { getGeoSet, isGeoSetStale, updateGeoSet } from '../geo/store'
import { buildTargets } from './desired'
import type { ReconcilerControl, ReconcileReport } from './control'

// The reconcile loop (spec 7.1, 8, R-L2): periodic + event-driven apply of every node's desired
// state, per-node backoff and alerts, site health with debounce, weekly geo refresh.

export const CYCLE_INTERVAL_MS = 5 * 60_000
export const HEALTH_INTERVAL_MS = 60_000
export const GEO_INTERVAL_MS = 6 * 60 * 60_000
export const EVENT_DEBOUNCE_MS = 1000
export const BACKOFF_CAP_MIN = 30
/** A failed or refused geo download is retried at most this often (it's ~30 MB each time). */
export const GEO_RETRY_MS = 24 * 60 * 60_000
/** How long an unreachable replaced host is retried before it's assumed gone (R-S3). */
export const RETIRE_GIVE_UP_MS = 24 * 60 * 60_000

/** Minutes to wait after the n-th consecutive failure (n ≥ 1): 1, 2, 4, … capped at 30 (R-P3). */
export function backoffMinutes(failures: number): number {
  return Math.min(2 ** Math.max(0, failures - 1), BACKOFF_CAP_MIN)
}

/** Serializes operations on one node (R-P2); `busy` lets the health probe stay out of the way. */
export class NodeLock {
  private tail: Promise<unknown> = Promise.resolve()
  private holders = 0

  get busy(): boolean {
    return this.holders > 0
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.holders += 1
    const result = this.tail.then(fn)
    this.tail = result.catch(() => {}).finally(() => { this.holders -= 1 })
    return result
  }
}

export interface ProbeRecord {
  probe: NodeProbe
  at: Date
}

export interface ReconcilerDeps {
  provision: typeof provisionNode
  probe: typeof probeNode
  /** Stops a replaced host; without it old hosts are left running. */
  retire?: typeof retireNode
  provisionDeps: ProvisionDeps
  /** Re-reads config.yaml; on success ctx.config() returns the new config. */
  reloadConfig: () => { ok: boolean, errors?: string[] }
  fetchGeo?: (country: string) => Promise<string[]>
  now?: () => Date
  coordinatorVersion: string
  log?: (msg: string) => void
}

export interface CycleOptions {
  upgrade?: boolean
  /** Nodes to provision with force (also bypasses backoff). */
  force?: Set<string>
  /** Limit the cycle to these nodes; all nodes when absent. */
  nodes?: Set<string>
  /** Bypass backoff for every node in the cycle (/apply, /rotate). */
  ignoreBackoff?: boolean
}

interface Queued {
  opts: CycleOptions
  promise: Promise<ReconcileReport[]>
  resolve: (reports: ReconcileReport[]) => void
  reject: (err: unknown) => void
}

function mergeOptions(a: CycleOptions, b: CycleOptions): CycleOptions {
  const union = (x?: Set<string>, y?: Set<string>) => (x || y ? new Set([...(x ?? []), ...(y ?? [])]) : undefined)
  return {
    upgrade: a.upgrade || b.upgrade,
    force: union(a.force, b.force),
    nodes: a.nodes && b.nodes ? union(a.nodes, b.nodes) : undefined,
    ignoreBackoff: a.ignoreBackoff || b.ignoreBackoff,
  }
}

function scoped(reports: ReconcileReport[], nodes?: Set<string>): ReconcileReport[] {
  return nodes ? reports.filter(r => nodes.has(r.node)) : reports
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isHostKeyMismatch(err: unknown): boolean {
  return err instanceof HostKeyMismatchError || (err instanceof Error && err.name === 'HostKeyMismatchError')
}

export class Reconciler implements ReconcilerControl {
  private readonly locks = new Map<string, NodeLock>()
  private readonly debouncers = new Map<string, Debouncer>()
  private running: Promise<ReconcileReport[]> | null = null
  private queued: Queued | null = null
  private healthRunning = false
  private geoRunning = false
  private lastConfigErrors: string | null = null
  /** Last render error alerted per site; cleared once the site renders again. */
  private readonly renderErrors = new Map<string, string>()
  /** Geo per country: when the last failed/refused attempt was, and the reason last alerted. */
  private readonly geoAttempts = new Map<string, { failedAt: number, alerted: string }>()
  /** Nodes whose old host already got a "could not stop" alert in this process. */
  private readonly retireAlerted = new Set<string>()
  /** Latest health probe per node, for /metrics. */
  private readonly probes = new Map<string, ProbeRecord>()
  private timers: NodeJS.Timeout[] = []
  private eventTimer: NodeJS.Timeout | null = null
  private eventNodes = new Set<string>()
  private readonly now: () => Date
  private readonly onPeersChanged = () => {
    for(const site of this.ctx.config().sites) this.eventNodes.add(nodeName(site.name, 'local'))
    this.scheduleEventCycle()
  }
  private readonly onIdentityChanged = (site: string) => {
    this.eventNodes.add(nodeName(site, 'local'))
    this.eventNodes.add(nodeName(site, 'remote'))
    this.scheduleEventCycle()
  }

  constructor(private readonly ctx: AppContext, private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  latestProbes(): ReadonlyMap<string, ProbeRecord> {
    return this.probes
  }

  lock(node: string): NodeLock {
    let lock = this.locks.get(node)
    if(!lock) {
      lock = new NodeLock()
      this.locks.set(node, lock)
    }
    return lock
  }

  private log(msg: string) {
    this.deps.log?.(msg)
  }

  // Fire-and-forget: a hung Telegram send must never stall cycles or health checks.
  private alert(text: string, opts?: AlertOptions): void {
    try {
      void this.ctx.alert(text, opts).catch(err => this.log(`alert failed: ${errorMessage(err)}`))
    } catch(err) {
      this.log(`alert failed: ${errorMessage(err)}`)
    }
  }

  // Same context, but its alert never blocks (for helpers that await ctx.alert).
  private get nonBlockingCtx(): AppContext {
    return { ...this.ctx, alert: async (text, opts) => this.alert(text, opts) }
  }

  // --- triggers ---

  start(): void {
    this.ctx.events.on('peers-changed', this.onPeersChanged)
    this.ctx.events.on('identity-changed', this.onIdentityChanged)
    const guard = (what: string, p: Promise<unknown>) => p.catch(err => this.log(`${what} failed: ${errorMessage(err)}`))
    this.timers.push(
      setInterval(() => void guard('cycle', this.runCycle()), CYCLE_INTERVAL_MS),
      setInterval(() => void guard('health', this.runHealth()), HEALTH_INTERVAL_MS),
      setInterval(() => void guard('geo', this.refreshGeo()), GEO_INTERVAL_MS),
    )
    void guard('geo', this.refreshGeo())
    void guard('cycle', this.runCycle())
  }

  stop(): void {
    this.ctx.events.off('peers-changed', this.onPeersChanged)
    this.ctx.events.off('identity-changed', this.onIdentityChanged)
    for(const timer of this.timers) clearInterval(timer)
    this.timers = []
    if(this.eventTimer) clearTimeout(this.eventTimer)
    this.eventTimer = null
    this.eventNodes.clear()
  }

  // Coalesces bursts (e.g. several configs revoked at once) into one scoped cycle (R-P4).
  private scheduleEventCycle() {
    if(this.eventTimer) return
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null
      const nodes = this.eventNodes
      this.eventNodes = new Set()
      this.runCycle({ nodes }).catch(err => this.log(`event cycle failed: ${errorMessage(err)}`))
    }, EVENT_DEBOUNCE_MS)
  }

  // --- ReconcilerControl ---

  applyNow(opts: { upgrade?: boolean } = {}): Promise<ReconcileReport[]> {
    return this.runCycle({ upgrade: opts.upgrade, ignoreBackoff: true })
  }

  async trust(node: string): Promise<ReconcileReport[]> {
    const host = this.hostOf(node)
    if(!host) return [{ node, outcome: 'error', message: `неизвестный узел ${node}` }]
    trustAddress(this.ctx.db, host)
    const only = new Set([node])
    return this.runCycle({ nodes: only, force: only })
  }

  async rotate(which: 'tunnel' | 'clients'): Promise<ReconcileReport[]> {
    const sites = this.ctx.config().sites
    ensureSiteIdentities(this.ctx.db, this.ctx.config())
    for(const site of sites) rotateParams(this.ctx.db, site.name, which)
    for(const site of sites) this.ctx.events.emit('identity-changed', site.name)
    return this.runCycle({ ignoreBackoff: true })
  }

  private hostOf(node: string): string | null {
    for(const site of this.ctx.config().sites) {
      if(node === nodeName(site.name, 'local')) return site.local.addresses.outer
      if(node === nodeName(site.name, 'remote')) return site.remote.addresses.outer
    }
    return null
  }

  // --- reconcile cycle ---

  /** Cycles never overlap: a call during a running cycle joins the single queued follow-up. */
  runCycle(opts: CycleOptions = {}): Promise<ReconcileReport[]> {
    if(!this.running) return this.startCycle(opts)

    if(this.queued) {
      this.queued.opts = mergeOptions(this.queued.opts, opts)
    } else {
      let resolve!: Queued['resolve']
      let reject!: Queued['reject']
      const promise = new Promise<ReconcileReport[]>((res, rej) => { resolve = res; reject = rej })
      this.queued = { opts, promise, resolve, reject }
    }
    return this.queued.promise.then(reports => scoped(reports, opts.nodes))
  }

  private startCycle(opts: CycleOptions): Promise<ReconcileReport[]> {
    const cycle = this.cycle(opts).finally(() => {
      this.running = null
      const next = this.queued
      if(next) {
        this.queued = null
        this.startCycle(next.opts).then(next.resolve, next.reject)
      }
    })
    this.running = cycle
    return cycle.then(reports => scoped(reports, opts.nodes))
  }

  private async cycle(opts: CycleOptions): Promise<ReconcileReport[]> {
    await this.reloadConfig()

    const config = this.ctx.config()
    ensureSiteIdentities(this.ctx.db, config)
    for(const site of syncProtocols(this.ctx.db, config)) this.ctx.events.emit('identity-changed', site)

    const work: Promise<ReconcileReport>[] = []
    for(const site of config.sites) {
      const wanted = (role: NodeRole) => !opts.nodes || opts.nodes.has(nodeName(site.name, role))
      if(!wanted('local') && !wanted('remote')) continue

      let targets: ReturnType<typeof buildTargets>
      try {
        targets = buildTargets(this.ctx, site, this.deps.coordinatorVersion)
        this.renderErrors.delete(site.name)
      } catch(err) {
        const message = errorMessage(err)
        if(this.renderErrors.get(site.name) !== message) {
          this.renderErrors.set(site.name, message)
          this.alert(`площадка ${site.name}: не удалось построить конфигурацию узлов, изменения не применяются:\n${message}`)
        }
        for(const role of ['local', 'remote'] as const) {
          if(wanted(role)) work.push(Promise.resolve({ node: nodeName(site.name, role), outcome: 'error', message: `рендер: ${message}` }))
        }
        continue
      }
      if(wanted('local')) work.push(this.reconcileNode(targets.local, opts))
      if(wanted('remote')) work.push(this.reconcileNode(targets.remote, opts))
    }
    return Promise.all(work)
  }

  // R-C1: a broken config.yaml is reported once per distinct error set; the last valid one stays.
  private async reloadConfig() {
    let result: { ok: boolean, errors?: string[] }
    try {
      result = this.deps.reloadConfig()
    } catch(err) {
      result = { ok: false, errors: [errorMessage(err)] }
    }
    if(result.ok) {
      this.lastConfigErrors = null
      return
    }
    const errors = result.errors ?? ['неизвестная ошибка']
    const key = [...errors].sort().join('\n')
    if(key === this.lastConfigErrors) return
    this.lastConfigErrors = key
    this.alert(`config.yaml невалиден, действует последний валидный конфиг:\n${errors.join('\n')}`)
  }

  private getHost(node: string): HostRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM hosts WHERE node = ?').get(node) as HostRow | undefined
  }

  // Creates the row on first sight; a new address means a new machine, so its backoff starts over
  // and the old one is queued to be stopped (R-S3). Moving back to the old address cancels that.
  private syncHostAddress(target: NodeTarget): HostRow {
    const db = this.ctx.db
    const row = this.getHost(target.node)
    if(!row) {
      db.prepare('INSERT INTO hosts (node, address) VALUES (?, ?)').run(target.node, target.host)
    } else if(row.address !== target.host) {
      const retired = row.applied_hash ? row.address : row.retired_address
      db.prepare(`
        UPDATE hosts SET address = ?, applied_hash = NULL, consecutive_failures = 0, next_attempt_at = NULL, phase = 'pending',
          retired_address = ?, retired_at = ?
        WHERE node = ?
      `).run(target.host, retired === target.host ? null : retired, retired === target.host ? null : this.now().toISOString(), target.node)
    }
    return this.getHost(target.node)!
  }

  private async reconcileNode(target: NodeTarget, opts: CycleOptions): Promise<ReconcileReport> {
    const db = this.ctx.db
    const host = this.syncHostAddress(target)
    const forced = opts.force?.has(target.node) ?? false

    if(!forced && !opts.ignoreBackoff && host.next_attempt_at && Date.parse(host.next_attempt_at) > this.now().getTime()) {
      return { node: target.node, outcome: 'skipped', message: `повтор после ${host.next_attempt_at}` }
    }

    let lastPhase: ProvisionPhase = 'connecting'
    const setPhase = db.prepare('UPDATE hosts SET phase = ? WHERE node = ?')
    const provisionDeps: ProvisionDeps = {
      ...this.deps.provisionDeps,
      onPhase: phase => {
        lastPhase = phase
        setPhase.run(phase, target.node)
        this.deps.provisionDeps.onPhase?.(phase)
      },
    }

    try {
      const result = await this.lock(target.node).run(() =>
        this.deps.provision(provisionDeps, target, { upgrade: opts.upgrade, force: forced }))
      const prev = this.getHost(target.node)!
      db.prepare(`
        UPDATE hosts SET applied_hash = ?, phase = 'ready', last_ok_at = ?, consecutive_failures = 0, next_attempt_at = NULL
        WHERE node = ?
      `).run(target.hash, this.now().toISOString(), target.node)
      if(prev.consecutive_failures > 0) this.alert(`${target.node}: снова в порядке`)
      if(result.outcome === 'applied' && target.role === 'local') this.ctx.events.emit('local-applied', target.node)
      if(prev.retired_address) await this.retireOld(target, prev)
      return { node: target.node, outcome: result.outcome }
    } catch(err) {
      const message = errorMessage(err)
      const prev = this.getHost(target.node)!
      const failures = prev.consecutive_failures + 1
      const at = this.now()
      const next = new Date(at.getTime() + backoffMinutes(failures) * 60_000)
      db.prepare(`
        UPDATE hosts SET phase = 'error', last_error = ?, last_error_at = ?, consecutive_failures = ?, next_attempt_at = ?
        WHERE node = ?
      `).run(message, at.toISOString(), failures, next.toISOString(), target.node)
      // A host key mismatch needs /trust, so it is announced even mid-streak (e.g. after timeouts).
      const newMismatch = isHostKeyMismatch(err) && prev.last_error !== message
      if(failures === 1 || newMismatch) this.alert(this.failureAlert(target, err, lastPhase))
      return { node: target.node, outcome: 'error', message }
    }
  }

  // R-S3: the replaced host still has the node's keys and would keep resetting the new host's
  // sessions with every handshake, so it is stopped once the new one is up. A host that now
  // refuses our key or shows another host key is someone else's: nothing to stop.
  private async retireOld(target: NodeTarget, row: HostRow) {
    const retire = this.deps.retire
    const old = row.retired_address
    if(!retire || !old) return
    const clear = () => this.ctx.db.prepare('UPDATE hosts SET retired_address = NULL, retired_at = NULL WHERE node = ?').run(target.node)

    try {
      const result = await retire(this.deps.provisionDeps, { host: old, ssh: target.ssh }, target.addresses)
      clear()
      this.retireAlerted.delete(target.node)
      if(result === 'retired') this.alert(`${target.node}: на старом сервере ${old} остановлен AWG, его можно удалять`)
    } catch(err) {
      if(isHostKeyMismatch(err) || err instanceof SshAuthError || (err instanceof Error && err.name === 'SshAuthError')) {
        clear()
        return
      }
      const since = row.retired_at ? Date.parse(row.retired_at) : this.now().getTime()
      if(this.now().getTime() - since >= RETIRE_GIVE_UP_MS) clear()
      if(!this.retireAlerted.has(target.node)) {
        this.retireAlerted.add(target.node)
        this.alert(`${target.node}: не удалось остановить AWG на старом сервере ${old}: ${errorMessage(err)}\n`
          + 'Если он ещё работает, выключите его: у него те же ключи, и он мешает новому серверу. Координатор будет пробовать ещё сутки.')
      }
    }
  }

  private failureAlert(target: NodeTarget, err: unknown, phase: ProvisionPhase): string {
    if(isHostKeyMismatch(err)) {
      return `${target.node}: ключ SSH хоста ${target.host} изменился, координатор не подключается.\n`
        + `${errorMessage(err)}\nЕсли ОС на этой машине переустановлена — подтвердите: /trust ${target.node}`
    }
    const stage = phase === 'bootstrapping' || phase === 'rebooting' ? 'bootstrap' : 'apply'
    return `${target.node}: ошибка ${stage}: ${errorMessage(err)}`
  }

  // --- health (spec 8) ---

  async runHealth(): Promise<void> {
    if(this.healthRunning) return
    this.healthRunning = true
    try {
      await Promise.all(this.ctx.config().sites.map(site => this.checkSite(site)))
    } finally {
      this.healthRunning = false
    }
  }

  private async checkSite(site: SiteConfig) {
    const localName = nodeName(site.name, 'local')
    const remoteName = nodeName(site.name, 'remote')
    // A node being provisioned may legitimately be down (reboot, interface restart): no verdict now.
    if(this.lock(localName).busy || this.lock(remoteName).busy) return

    const probe = async (node: string, host: string, ssh: SiteConfig['local']['ssh']): Promise<NodeProbe> => {
      try {
        return await this.deps.probe(this.deps.provisionDeps, { node, host, ssh })
      } catch(err) {
        return { reachable: false, error: errorMessage(err) }
      }
    }
    const [local, remote] = await Promise.all([
      probe(localName, site.local.addresses.outer, site.local.ssh),
      probe(remoteName, site.remote.addresses.outer, site.remote.ssh),
    ])

    const at = this.now()
    this.probes.set(localName, { probe: local, at })
    this.probes.set(remoteName, { probe: remote, at })
    const result = evaluateSite(local, remote, Math.floor(at.getTime() / 1000))

    let debouncer = this.debouncers.get(site.name)
    if(!debouncer) {
      // No stored state yet: the first observation is the baseline, nothing to announce.
      debouncer = new Debouncer(readSiteNetwork(this.ctx.db, site.name) ?? result.network)
      this.debouncers.set(site.name, debouncer)
    }
    const from = debouncer.state
    const confirmed = debouncer.observe(result.network)

    persistSiteHealth(this.ctx.db, site.name, { ...result, network: debouncer.state }, at.toISOString())
    if(confirmed) await notifyTransition(this.nonBlockingCtx, site.name, from, confirmed, result.detail)
  }

  // --- geo (R-L2, R-L7) ---

  // Alerts only when the reason differs from the last one alerted for this country.
  private geoFailed(country: string, reason: string, text: string) {
    const prev = this.geoAttempts.get(country)
    this.geoAttempts.set(country, { failedAt: this.now().getTime(), alerted: reason })
    if(prev?.alerted !== reason) this.alert(text)
  }

  /** Returns the countries whose set changed; their LOCAL nodes get a cycle right away. */
  async refreshGeo(): Promise<string[]> {
    const fetchGeo = this.deps.fetchGeo
    if(!fetchGeo || this.geoRunning) return []
    this.geoRunning = true
    try {
      const sites = this.ctx.config().sites
      const countries = [...new Set(sites.map(site => site.local.country))]
      const updated: string[] = []
      for(const country of countries) {
        if(!isGeoSetStale(this.ctx.db, country, undefined, this.now())) continue
        const attempt = this.geoAttempts.get(country)
        if(attempt && this.now().getTime() - attempt.failedAt < GEO_RETRY_MS) continue

        let cidrs: string[]
        try {
          cidrs = await fetchGeo(country)
        } catch(err) {
          const kept = getGeoSet(this.ctx.db, country) ? 'остаётся прежний набор' : 'набора пока нет'
          const reason = errorMessage(err)
          this.geoFailed(country, reason, `geo ${country}: не удалось скачать db-ip (${reason}), ${kept}`)
          continue
        }
        const result = updateGeoSet(this.ctx.db, country, cidrs, 'dbip-lite')
        if(!result.updated) {
          const reason = result.reason ?? 'unknown'
          this.geoFailed(country, reason, `geo ${country}: новая выгрузка отклонена (${reason}), остаётся прежний набор`)
          continue
        }
        this.geoAttempts.delete(country)
        updated.push(country)
      }
      if(updated.length) {
        for(const site of sites) {
          if(updated.includes(site.local.country)) this.eventNodes.add(nodeName(site.name, 'local'))
        }
        this.scheduleEventCycle()
      }
      return updated
    } finally {
      this.geoRunning = false
    }
  }
}
