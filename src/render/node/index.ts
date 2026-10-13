import { createHash } from 'node:crypto'
import type { RenderedFile } from '../../types'
import type { LocalRenderInput, RemoteRenderInput } from './input'
import { NODE_PATHS } from './input'
import { renderAwgc, renderLocalAwgt, renderRemoteAwgt } from './awgConf'
import { renderLocalNft, renderRemoteNft } from './nftables'
import { renderRoutingScript, renderRoutingUnit, renderSysctl } from './system'

export function renderLocal(input: LocalRenderInput): RenderedFile[] {
  return [
    { path: `${NODE_PATHS.awgDir}/awgc.conf`, mode: 0o600, content: renderAwgc(input) },
    { path: `${NODE_PATHS.awgDir}/awgt.conf`, mode: 0o600, content: renderLocalAwgt(input) },
    { path: NODE_PATHS.nftables, mode: 0o644, content: renderLocalNft(input) },
    { path: NODE_PATHS.sysctl, mode: 0o644, content: renderSysctl() },
    { path: NODE_PATHS.routingScript, mode: 0o755, content: renderRoutingScript(input) },
    { path: NODE_PATHS.routingUnit, mode: 0o644, content: renderRoutingUnit() },
  ]
}

/** REMOTE needs no policy routing (R-R2), so no routing script/unit. */
export function renderRemote(input: RemoteRenderInput): RenderedFile[] {
  return [
    { path: `${NODE_PATHS.awgDir}/awgt.conf`, mode: 0o600, content: renderRemoteAwgt(input) },
    { path: NODE_PATHS.nftables, mode: 0o644, content: renderRemoteNft(input) },
    { path: NODE_PATHS.sysctl, mode: 0o644, content: renderSysctl() },
  ]
}

/** sha256 over files (sorted by path) plus `extra` (e.g. the node script version). */
export function desiredHash(files: RenderedFile[], extra: string): string {
  const h = createHash('sha256')
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  // Length-prefix every field so no concatenation of different inputs can collide.
  const field = (s: string) => {
    const b = Buffer.from(s, 'utf8')
    h.update(`${b.length}:`)
    h.update(b)
  }
  for(const f of sorted) {
    field(f.path)
    field(f.mode.toString(8))
    field(f.content)
  }
  field(extra)
  return h.digest('hex')
}
