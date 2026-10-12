import { MARKS, NFT_TABLE, type LocalRenderInput, type RemoteRenderInput } from './input'
import { subnetHost } from './net'

// Renders the whole /etc/nftables.conf. `flush ruleset` + full definition in one file means
// `nft -f` swaps everything (geo sets included, R-L7) in a single atomic transaction.

// Destinations always treated as "home" (never routed via REMOTE).
export const PRIVATE_RANGES = [
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10',
  '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4',
]

const ICMPV6_TYPES = [
  'destination-unreachable', 'packet-too-big', 'time-exceeded', 'parameter-problem',
  'echo-request', 'echo-reply', 'nd-router-solicit', 'nd-router-advert',
  'nd-neighbor-solicit', 'nd-neighbor-advert',
]

const ELEMENTS_PER_LINE = 8

function bareIp(addr: string): string {
  return addr.split('/')[0]
}

function renderSet(name: string, elements: string[]): string[] {
  const unique = [...new Set(elements.map(e => e.trim()).filter(Boolean))]
  const lines = [
    `  set ${name} {`,
    '    type ipv4_addr',
    '    flags interval',
    '    auto-merge',
  ]
  if(unique.length) {
    const rows: string[] = []
    for(let i = 0; i < unique.length; i += ELEMENTS_PER_LINE) rows.push(unique.slice(i, i + ELEMENTS_PER_LINE).join(', '))
    lines.push(`    elements = {\n      ${rows.join(',\n      ')}\n    }`)
  }
  lines.push('  }')
  return lines
}

function chain(name: string, hook: string, rules: string[]): string[] {
  return [`  chain ${name} {`, `    ${hook}`, ...rules.map(r => `    ${r}`), '  }']
}

function inputChain(outer: string, awgRule: string): string[] {
  return chain('input', 'type filter hook input priority filter; policy drop;', [
    'iifname "lo" accept',
    'ct state invalid drop',
    'ct state established,related accept',
    'meta l4proto icmp accept',
    `meta l4proto ipv6-icmp icmpv6 type { ${ICMPV6_TYPES.join(', ')} } accept`,
    `ip daddr ${bareIp(outer)} tcp dport 22 accept`,
    awgRule,
  ])
}

function ruleset(body: string[][]): string {
  const lines = ['#!/usr/sbin/nft -f', '', 'flush ruleset', '', `table inet ${NFT_TABLE} {`]
  body.forEach((block, i) => {
    if(i) lines.push('')
    lines.push(...block)
  })
  lines.push('}', '')
  return lines.join('\n')
}

export function renderLocalNft(input: LocalRenderInput): string {
  const mark = MARKS.viaRemote
  const tunnelSrc = subnetHost(input.tunnelSubnet, 1)
  const clients = input.clientSubnet
  return ruleset([
    renderSet('geo_home', input.geoHome),
    renderSet('force_remote', input.forceRemote),
    renderSet('private', PRIVATE_RANGES),
    inputChain(input.addresses.outer,
      `ip daddr ${bareIp(input.addresses.client)} udp dport ${input.identity.awgc.listenPort} accept`),
    // R-L3: unmarked = home (main table), 0x52 = via REMOTE (table 152).
    chain('prerouting', 'type filter hook prerouting priority mangle; policy accept;', [
      `iifname "awgc" ip daddr @force_remote meta mark set ${mark} return`,
      'iifname "awgc" ip daddr @geo_home return',
      'iifname "awgc" ip daddr @private return',
      `iifname "awgc" meta mark set ${mark}`,
    ]),
    chain('forward', 'type filter hook forward priority filter; policy drop;', [
      'meta nfproto ipv6 drop',
      // R-L6 fail-closed: REMOTE-bound traffic never leaks via the uplink, whatever routing does.
      `meta mark ${mark} oifname != "awgt" drop`,
      'iifname "awgc" oifname "awgc" drop',
      'tcp flags syn tcp option maxseg size set rt mtu',
      'ct state established,related accept',
      'iifname "awgc" accept',
    ]),
    // R-L4: matching "not a tunnel" instead of the NIC name keeps the render host-agnostic.
    chain('postrouting', 'type nat hook postrouting priority srcnat; policy accept;', [
      `oifname "awgt" ip saddr ${clients} snat ip to ${tunnelSrc}`,
      `oifname != { "awgt", "awgc" } ip saddr ${clients} snat ip to ${bareIp(input.addresses.outer)}`,
    ]),
  ])
}

export function renderRemoteNft(input: RemoteRenderInput): string {
  return ruleset([
    inputChain(input.addresses.outer,
      `ip saddr ${bareIp(input.localTunnelAddress)} ip daddr ${bareIp(input.addresses.tunnel)} udp dport ${input.identity.awgt.listenPort} accept`),
    chain('forward', 'type filter hook forward priority filter; policy drop;', [
      'meta nfproto ipv6 drop',
      'tcp flags syn tcp option maxseg size set rt mtu',
      'ct state established,related accept',
      'iifname "awgt" accept',
    ]),
    chain('postrouting', 'type nat hook postrouting priority srcnat; policy accept;', [
      `oifname != "awgt" ip saddr ${input.tunnelSubnet} snat ip to ${bareIp(input.addresses.outer)}`,
    ]),
  ])
}
