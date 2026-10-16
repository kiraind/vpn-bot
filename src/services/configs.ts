import { randomUUID } from 'node:crypto'
import type { AppContext } from '../context'
import type { Db } from '../db'
import { now } from '../db'
import type { SiteConfig } from '../config/schema'
import { genKeyPair, genPresharedKey } from '../crypto/wgKeys'
import { cidrToRange, intToIp, ipToInt } from '../geo/cidr'
import { clientRevision, countryServerName, renderClientConf, renderVpnKey, type ClientRenderInput } from '../render/clientConfig'
import type { ClientPeer } from '../render/node/input'
import type { ClientConfigRow, ConfigState, NetworkState } from '../types'
import { getLocalIdentity } from './identity'

// Client config issuance shared by the bot and the API (R-S2, section 9.2).

export const NAME_RE = /^[a-z0-9-]{1,32}$/

/** R-S2: first free host address among non-revoked configs; network, server (.1) and broadcast are skipped. */
export function allocateAddress(db: Db, subnet: string): string {
  const [start, end] = cidrToRange(subnet)
  const used = new Set(
    (db.prepare(`SELECT address FROM client_configs WHERE state != 'revoked'`).all() as { address: string }[])
      .map(row => ipToInt(row.address))
  )
  for(let ip = start + 2; ip < end; ip++) {
    if(!used.has(ip)) return intToIp(ip)
  }
  throw new Error('subnet exhausted')
}

export interface CreateConfigInput {
  tgId: number
  name: string
  issuedVia: 'bot' | 'api'
}

export type CreateConfigError = 'invalid_name' | 'name_taken' | 'not_member'

export function createConfig(ctx: AppContext, input: CreateConfigInput): ClientConfigRow | { error: CreateConfigError } {
  if(!NAME_RE.test(input.name)) return { error: 'invalid_name' }

  const keys = genKeyPair()
  const psk = genPresharedKey()
  const row = ctx.db.transaction((): ClientConfigRow | { error: CreateConfigError } => {
    // Checked inside the transaction: a suspension racing with /add must not leave an active peer behind
    const user = ctx.db.prepare('SELECT status, revoked_at FROM users WHERE tg_id = ?').get(input.tgId) as
      { status: string, revoked_at: string | null } | undefined
    if(!user || user.status !== 'active' || user.revoked_at) return { error: 'not_member' }
    if(findConfigByName(ctx.db, input.tgId, input.name)) return { error: 'name_taken' }
    const id = randomUUID()
    ctx.db.prepare(`
      INSERT INTO client_configs (id, tg_id, name, address, private_key, public_key, preshared_key, state, issued_via, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, input.tgId, input.name, allocateAddress(ctx.db, ctx.config().clients.subnet),
      keys.privateKey, keys.publicKey, psk, input.issuedVia, now())
    return getConfig(ctx.db, id)!
  })()

  if('error' in row) return row
  ctx.events.emit('peers-changed')
  return row
}

/** Only the owner's own live configs can be revoked. */
export function revokeConfig(ctx: AppContext, tgId: number, id: string): boolean {
  const changes = ctx.db.prepare(`
    UPDATE client_configs SET state = 'revoked', revoked_at = ? WHERE id = ? AND tg_id = ? AND state != 'revoked'
  `).run(now(), id, tgId).changes
  if(changes > 0) ctx.events.emit('peers-changed')
  return changes > 0
}

export type RenameConfigError = 'invalid_name' | 'name_taken' | 'not_found'

/**
 * R-A11: renames the owner's own live (non-revoked) config. The name is in neither the rendered
 * conf nor clientRevision, so nothing reaches the nodes and the revision stays the same.
 */
export function renameConfig(ctx: AppContext, tgId: number, id: string, name: string): ClientConfigRow | { error: RenameConfigError } {
  if(!NAME_RE.test(name)) return { error: 'invalid_name' }
  return ctx.db.transaction((): ClientConfigRow | { error: RenameConfigError } => {
    const row = getOwnConfig(ctx.db, tgId, id)
    if(!row || row.state === 'revoked') return { error: 'not_found' }
    if(row.name === name) return row
    if(findConfigByName(ctx.db, tgId, name)) return { error: 'name_taken' }
    ctx.db.prepare('UPDATE client_configs SET name = ? WHERE id = ?').run(name, id)
    return getConfig(ctx.db, id)!
  })()
}

function getConfig(db: Db, id: string): ClientConfigRow | null {
  return (db.prepare('SELECT * FROM client_configs WHERE id = ?').get(id) as ClientConfigRow | undefined) ?? null
}

export function findConfigByName(db: Db, tgId: number, name: string): ClientConfigRow | null {
  return (db.prepare(`SELECT * FROM client_configs WHERE tg_id = ? AND name = ? AND state != 'revoked'`)
    .get(tgId, name) as ClientConfigRow | undefined) ?? null
}

/** Any state, so the API can still answer `revoked`; null when it's someone else's. */
export function getOwnConfig(db: Db, tgId: number, id: string): ClientConfigRow | null {
  const row = getConfig(db, id)
  return row && row.tg_id === tgId ? row : null
}

export function listConfigs(db: Db, tgId: number): ClientConfigRow[] {
  return db.prepare(`SELECT * FROM client_configs WHERE tg_id = ? AND state != 'revoked' ORDER BY created_at, name`)
    .all(tgId) as ClientConfigRow[]
}

/** Peers for LOCAL's awgc: suspended configs keep their row but lose their peer (R-B1). */
export function activePeers(db: Db): ClientPeer[] {
  return (db.prepare(`SELECT public_key, preshared_key, address FROM client_configs WHERE state = 'active' ORDER BY address`)
    .all() as { public_key: string, preshared_key: string, address: string }[])
    .map(row => ({ publicKey: row.public_key, presharedKey: row.preshared_key, address: row.address }))
}

function defaultSite(ctx: AppContext): SiteConfig {
  return ctx.config().sites[0]
}

export function renderInputFor(ctx: AppContext, row: ClientConfigRow, site: SiteConfig = defaultSite(ctx)): ClientRenderInput {
  const config = ctx.config()
  const awgc = getLocalIdentity(ctx.db, site.name).awgc
  return {
    config: { id: row.id, name: row.name, address: row.address, privateKey: row.private_key, presharedKey: row.preshared_key },
    server: { publicKey: awgc.publicKey, params: awgc.params, endpointHost: site.local.addresses.client, listenPort: awgc.listenPort },
    dns: config.clients.dns,
    mtu: config.clients.mtu,
    serverName: site.remote.country ? countryServerName(site.remote.country) : site.name,
  }
}

export function currentRevision(ctx: AppContext, row: ClientConfigRow): string {
  return clientRevision(renderInputFor(ctx, row))
}

/** API `Config` (section 9.2). */
export function configView(ctx: AppContext, row: ClientConfigRow) {
  const input = renderInputFor(ctx, row)
  return {
    id: row.id,
    name: row.name,
    revision: clientRevision(input),
    createdAt: row.created_at,
    awg: renderClientConf(input),
    // The app names the server after this, not after the device (`name`); old builds ignore it (R-A10)
    serverName: input.serverName,
    vpnKey: renderVpnKey(input),
    endpoint: `${input.server.endpointHost}:${input.server.listenPort}`,
  }
}

/** API `ConfigSummary` (GET /v1/me). */
export function configSummary(ctx: AppContext, row: ClientConfigRow) {
  return { id: row.id, name: row.name, revision: currentRevision(ctx, row), state: row.state, createdAt: row.created_at }
}

export type ConfigStatusState = 'ok' | 'outdated' | Exclude<ConfigState, 'active'>

/** API `ConfigStatus`: R-A5 (outdated iff revision differs), R-A6 (network from the last health check). */
export function configStatus(ctx: AppContext, row: ClientConfigRow, clientRev: string | undefined) {
  const revision = currentRevision(ctx, row)
  const state: ConfigStatusState = row.state !== 'active' ? row.state : clientRev === revision ? 'ok' : 'outdated'
  const site = ctx.db.prepare('SELECT network, checked_at FROM sites WHERE name = ?')
    .get(defaultSite(ctx).name) as { network: NetworkState, checked_at: string | null } | undefined
  return { state, revision, network: site?.network ?? 'down' as NetworkState, checkedAt: site?.checked_at ?? null }
}

export function markDelivered(db: Db, id: string, revision: string, via: 'bot' | 'api') {
  if(via === 'api') {
    db.prepare('UPDATE client_configs SET delivered_revision = ?, api_fetched_at = ? WHERE id = ?').run(revision, now(), id)
  } else {
    db.prepare('UPDATE client_configs SET delivered_revision = ? WHERE id = ?').run(revision, id)
  }
}

/**
 * R-O5: bot-issued configs never picked up by the app whose last delivered revision is stale;
 * the bot resends these. A null delivered_revision (delivery still in flight or failed at /add)
 * is left alone so a concurrent /add isn't sent twice.
 */
export function staleBotConfigs(ctx: AppContext): ClientConfigRow[] {
  const rows = ctx.db.prepare(`
    SELECT * FROM client_configs
    WHERE state = 'active' AND issued_via = 'bot' AND api_fetched_at IS NULL AND delivered_revision IS NOT NULL
    ORDER BY created_at
  `).all() as ClientConfigRow[]
  return rows.filter(row => row.delivered_revision !== currentRevision(ctx, row))
}
