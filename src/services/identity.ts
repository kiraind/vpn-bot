import { randomInt } from 'node:crypto'
import type { Db } from '../db'
import { now } from '../db'
import type { CoordinatorConfig, ProtocolName } from '../config/schema'
import { genKeyPair, genPresharedKey } from '../crypto/wgKeys'
import { getProfile } from '../protocol'
import type { LocalIdentity, NodeIdentity, NodeRole, RemoteIdentity, ServerInterfaceIdentity } from '../types'
import { nodeName } from '../types'

// Node identity (R-S3): keys, ports and obfuscation params are generated once per site and
// survive host replacement, so after swapping a host clients only see a new Endpoint.

export const PORT_MIN = 20000
export const PORT_MAX = 60000

function randomPort(): number {
  return randomInt(PORT_MIN, PORT_MAX + 1)
}

function serverInterface(protocol: ProtocolName): ServerInterfaceIdentity {
  return { ...genKeyPair(), listenPort: randomPort(), protocol, params: getProfile(protocol).generateParams() }
}

export function newLocalIdentity(config: CoordinatorConfig): LocalIdentity {
  return { role: 'local', awgc: serverInterface(config.clients.protocol), awgt: genKeyPair() }
}

export function newRemoteIdentity(config: CoordinatorConfig): RemoteIdentity {
  return { role: 'remote', awgt: { ...serverInterface(config.tunnel.protocol), presharedKey: genPresharedKey() } }
}

function readIdentity(db: Db, name: string): NodeIdentity | null {
  const row = db.prepare('SELECT identity FROM nodes WHERE name = ?').get(name) as { identity: string } | undefined
  return row ? JSON.parse(row.identity) as NodeIdentity : null
}

function writeIdentity(db: Db, name: string, identity: NodeIdentity) {
  db.prepare('UPDATE nodes SET identity = ? WHERE name = ?').run(JSON.stringify(identity), name)
}

/** Creates missing `<site>/local` and `<site>/remote` identities; never touches existing ones. */
export function ensureSiteIdentities(db: Db, config: CoordinatorConfig): string[] {
  const insert = db.prepare('INSERT OR IGNORE INTO nodes (name, role, identity, created_at) VALUES (?, ?, ?, ?)')
  return db.transaction(() => {
    const created: string[] = []
    for(const site of config.sites) {
      const make: [NodeRole, () => NodeIdentity][] = [
        ['local', () => newLocalIdentity(config)],
        ['remote', () => newRemoteIdentity(config)],
      ]
      for(const [role, build] of make) {
        const name = nodeName(site.name, role)
        if(readIdentity(db, name)) continue
        insert.run(name, role, JSON.stringify(build()), now())
        created.push(name)
      }
    }
    return created
  })()
}

export function getLocalIdentity(db: Db, site: string): LocalIdentity {
  const identity = readIdentity(db, nodeName(site, 'local'))
  if(!identity || identity.role !== 'local') throw new Error(`no local identity for site ${site}`)
  return identity
}

export function getRemoteIdentity(db: Db, site: string): RemoteIdentity {
  const identity = readIdentity(db, nodeName(site, 'remote'))
  if(!identity || identity.role !== 'remote') throw new Error(`no remote identity for site ${site}`)
  return identity
}

/** R-O3: a profile switch in config regenerates that interface's params. Returns changed sites. */
export function syncProtocols(db: Db, config: CoordinatorConfig): string[] {
  return db.transaction(() => {
    const changed: string[] = []
    for(const site of config.sites) {
      let touched = false
      const local = readIdentity(db, nodeName(site.name, 'local'))
      if(local?.role === 'local' && local.awgc.protocol !== config.clients.protocol) {
        local.awgc.protocol = config.clients.protocol
        local.awgc.params = getProfile(config.clients.protocol).generateParams()
        writeIdentity(db, nodeName(site.name, 'local'), local)
        touched = true
      }
      const remote = readIdentity(db, nodeName(site.name, 'remote'))
      if(remote?.role === 'remote' && remote.awgt.protocol !== config.tunnel.protocol) {
        remote.awgt.protocol = config.tunnel.protocol
        remote.awgt.params = getProfile(config.tunnel.protocol).generateParams()
        writeIdentity(db, nodeName(site.name, 'remote'), remote)
        touched = true
      }
      if(touched) changed.push(site.name)
    }
    return changed
  })()
}

/** R-O4: fresh params in the interface's current profile; keys and ports stay. */
export function rotateParams(db: Db, site: string, which: 'tunnel' | 'clients') {
  db.transaction(() => {
    if(which === 'clients') {
      const local = getLocalIdentity(db, site)
      local.awgc.params = getProfile(local.awgc.protocol).generateParams()
      writeIdentity(db, nodeName(site, 'local'), local)
    } else {
      const remote = getRemoteIdentity(db, site)
      remote.awgt.params = getProfile(remote.awgt.protocol).generateParams()
      writeIdentity(db, nodeName(site, 'remote'), remote)
    }
  })()
}
