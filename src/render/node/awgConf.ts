import type { ObfuscationParams } from '../../types'
import type { ClientPeer, LocalRenderInput, RemoteRenderInput } from './input'
import { prefixLen, subnetHost } from './net'

// Canonical AWG param order; anything unknown follows alphabetically so output stays deterministic.
const PARAM_ORDER = [
  'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1', 'I2', 'I3', 'I4', 'I5',
  'HeaderProtectionKey', 'ContentPaddingAddition', 'RekeyAfterTime', 'RekeyTimeout',
  'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts', 'RandomTrailers', 'DisableCookies',
]

export function paramLines(params: ObfuscationParams): string[] {
  const rank = (k: string) => {
    const i = PARAM_ORDER.indexOf(k)
    return i === -1 ? PARAM_ORDER.length : i
  }
  return Object.keys(params)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(k => `${k} = ${params[k]}`)
}

function ipToNum(ip: string): number {
  return ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0)
}

function sortPeers(peers: ClientPeer[]): ClientPeer[] {
  return [...peers].sort((a, b) => ipToNum(a.address) - ipToNum(b.address))
}

const hostCidr = (subnet: string, n: number) => `${subnetHost(subnet, n)}/${prefixLen(subnet)}`

const toText = (lines: string[]) => lines.join('\n') + '\n'

/** LOCAL awgc: the client-facing server interface. */
export function renderAwgc(input: LocalRenderInput): string {
  const { awgc } = input.identity
  const lines = [
    '[Interface]',
    `PrivateKey = ${awgc.privateKey}`,
    `Address = ${hostCidr(input.clientSubnet, 1)}`,
    `ListenPort = ${awgc.listenPort}`,
    ...paramLines(awgc.params),
  ]
  for(const p of sortPeers(input.peers)) {
    lines.push(
      '',
      '[Peer]',
      `PublicKey = ${p.publicKey}`,
      `PresharedKey = ${p.presharedKey}`,
      `AllowedIPs = ${p.address}/32`,
    )
  }
  return toText(lines)
}

/** LOCAL awgt: tunnel client towards REMOTE. Table = off — routing is done by table 152 (R-L3). */
export function renderLocalAwgt(input: LocalRenderInput): string {
  const { remote } = input
  return toText([
    '[Interface]',
    `PrivateKey = ${input.identity.awgt.privateKey}`,
    `Address = ${hostCidr(input.tunnelSubnet, 1)}`,
    `MTU = ${input.tunnelMtu}`,
    'Table = off',
    'FwMark = 0x51',
    // AWG requires both tunnel ends to use identical S/H params, so LOCAL takes REMOTE's.
    ...paramLines(remote.params),
    'PostUp = ip route replace default dev awgt table 152',
    'PostDown = ip route del default dev awgt table 152 || true',
    '',
    '[Peer]',
    `PublicKey = ${remote.publicKey}`,
    `PresharedKey = ${remote.presharedKey}`,
    `Endpoint = ${input.remoteTunnelAddress}:${remote.listenPort}`,
    'AllowedIPs = 0.0.0.0/0',
    'PersistentKeepalive = 25',
  ])
}

/** REMOTE awgt: tunnel server. No Endpoint — WireGuard replies from the address it was reached on (R-R2). */
export function renderRemoteAwgt(input: RemoteRenderInput): string {
  const { awgt } = input.identity
  return toText([
    '[Interface]',
    `PrivateKey = ${awgt.privateKey}`,
    `Address = ${hostCidr(input.tunnelSubnet, 2)}`,
    `ListenPort = ${awgt.listenPort}`,
    `MTU = ${input.tunnelMtu}`,
    ...paramLines(awgt.params),
    '',
    '[Peer]',
    `PublicKey = ${input.localAwgtPublicKey}`,
    `PresharedKey = ${awgt.presharedKey}`,
    `AllowedIPs = ${subnetHost(input.tunnelSubnet, 1)}/32`,
  ])
}
