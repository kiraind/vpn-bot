import type { LocalIdentity, RemoteIdentity } from '../../types'

// Everything a node's desired state is rendered from (section 7.1: `(config, db) → files`).
// Built by the reconciler from config.yaml + DB; the render functions themselves are pure.

export interface ClientPeer {
  publicKey: string
  presharedKey: string
  /** Client tunnel address without prefix, e.g. 10.66.0.2. */
  address: string
}

export interface LocalRenderInput {
  node: string                 // e.g. 'main/local'
  identity: LocalIdentity
  /** awgt server side (REMOTE): public key, PSK, port and obfuscation params shared by both tunnel ends. */
  remote: RemoteIdentity['awgt']
  addresses: { client: string, outer: string, tunnel: string }
  sshPort: number              // ssh.port of this node; input chain must keep it open
  remoteTunnelAddress: string  // REMOTE.tunnel, the awgt Endpoint host
  clientSubnet: string         // e.g. 10.66.0.0/16; awgc gets the first host address
  tunnelSubnet: string         // e.g. 10.255.0.0/30; LOCAL = .1, REMOTE = .2
  tunnelMtu: number
  peers: ClientPeer[]          // active client configs only
  geoHome: string[]            // country CIDRs ∪ routing.alwaysDirect
  forceRemote: string[]        // routing.alwaysRemote
}

export interface RemoteRenderInput {
  node: string                 // e.g. 'main/remote'
  identity: RemoteIdentity
  localAwgtPublicKey: string
  addresses: { outer: string, tunnel: string }
  sshPort: number
  localTunnelAddress: string   // LOCAL.tunnel, the only allowed source for the awgt port
  tunnelSubnet: string
  tunnelMtu: number
}

// Fixed on-node layout shared by renderers, scripts and the health check.
export const NODE_PATHS = {
  awgDir: '/etc/amnezia/amneziawg',
  nftables: '/etc/nftables.conf',
  sysctl: '/etc/sysctl.d/90-vpn-node.conf',
  stateDir: '/etc/vpn-node',
  marker: '/etc/vpn-node/node.json',
  routingScript: '/etc/vpn-node/routing.sh',
  routingUnit: '/etc/systemd/system/vpn-routing.service',
} as const

export const MARKS = {
  tunnelSource: '0x51',   // awgt's own UDP packets → table 151 (src LOCAL.tunnel)
  viaRemote: '0x52',      // client traffic for REMOTE → table 152 (dev awgt)
  tunnelTable: 151,
  remoteTable: 152,
} as const

export const NFT_TABLE = 'vpn'
