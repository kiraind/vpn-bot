import type { AppContext } from '../context'
import type { SiteConfig } from '../config/schema'
import type { NodeTarget } from '../provision/node'
import { SCRIPTS_VERSION } from '../provision/scripts'
import { getLocalIdentity, getRemoteIdentity } from '../services/identity'
import { activePeers } from '../services/configs'
import { getGeoSet } from '../geo/store'
import { mergeCidrs } from '../geo/cidr'
import { desiredHash, renderLocal, renderRemote } from '../render/node'
import type { LocalRenderInput, RemoteRenderInput } from '../render/node/input'
import { nodeName } from '../types'

// Desired state of a site's two nodes (spec 7.1 step 1): config.yaml + DB → files + hash.
// Pure given ctx: no network, no writes.

export interface SiteTargets {
  local: NodeTarget
  remote: NodeTarget
}

export function buildRenderInputs(ctx: AppContext, site: SiteConfig): { local: LocalRenderInput, remote: RemoteRenderInput } {
  const config = ctx.config()
  const localIdentity = getLocalIdentity(ctx.db, site.name)
  const remoteIdentity = getRemoteIdentity(ctx.db, site.name)
  const geo = getGeoSet(ctx.db, site.local.country)

  const local: LocalRenderInput = {
    node: nodeName(site.name, 'local'),
    identity: localIdentity,
    remote: remoteIdentity.awgt,
    addresses: { ...site.local.addresses },
    remoteTunnelAddress: site.remote.addresses.tunnel,
    clientSubnet: config.clients.subnet,
    tunnelSubnet: config.tunnel.subnet,
    tunnelMtu: config.tunnel.mtu,
    peers: activePeers(ctx.db),
    geoHome: mergeCidrs([...(geo?.cidrs ?? []), ...config.routing.alwaysDirect]),
    forceRemote: [...config.routing.alwaysRemote],
  }

  const remote: RemoteRenderInput = {
    node: nodeName(site.name, 'remote'),
    identity: remoteIdentity,
    localAwgtPublicKey: localIdentity.awgt.publicKey,
    addresses: { ...site.remote.addresses },
    localTunnelAddress: site.local.addresses.tunnel,
    tunnelSubnet: config.tunnel.subnet,
    tunnelMtu: config.tunnel.mtu,
  }

  return { local, remote }
}

export function buildTargets(ctx: AppContext, site: SiteConfig, coordinatorVersion: string): SiteTargets {
  const inputs = buildRenderInputs(ctx, site)
  const extra = `${SCRIPTS_VERSION}:${coordinatorVersion}`
  const localFiles = renderLocal(inputs.local)
  const remoteFiles = renderRemote(inputs.remote)
  const { client, outer, tunnel } = site.local.addresses

  return {
    local: {
      node: inputs.local.node,
      role: 'local',
      host: outer,
      ssh: site.local.ssh,
      addresses: [...new Set([client, outer, tunnel])],
      interfaces: ['awgc', 'awgt'],
      files: localFiles,
      hash: desiredHash(localFiles, extra),
    },
    remote: {
      node: inputs.remote.node,
      role: 'remote',
      host: site.remote.addresses.outer,
      ssh: site.remote.ssh,
      addresses: [...new Set([site.remote.addresses.outer, site.remote.addresses.tunnel])],
      interfaces: ['awgt'],
      files: remoteFiles,
      hash: desiredHash(remoteFiles, extra),
    },
  }
}
