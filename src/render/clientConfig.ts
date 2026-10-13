import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import type { ObfuscationParams } from '../types'

export interface ClientRenderInput {
  config: { id: string; name: string; address: string; privateKey: string; presharedKey: string }
  server: { publicKey: string; params: ObfuscationParams; endpointHost: string; listenPort: number }
  dns: string[]
  mtu: number
  /** What the app calls the server (Config.serverName, vpn:// description). */
  serverName: string
}

const ALLOWED_IPS = ['0.0.0.0/0', '::/0']
const KEEPALIVE = 25

// Known AWG keys in the order awg-quick/AmneziaVPN print them; anything else follows alphabetically.
const PARAM_ORDER = [
  'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4',
  'I1', 'I2', 'I3', 'I4', 'I5',
  'HeaderProtectionKey', 'ContentPaddingAddition', 'RekeyAfterTime', 'RekeyTimeout',
  'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts', 'RandomTrailers', 'DisableCookies',
]

function orderedParams(params: ObfuscationParams): [string, string][] {
  const rank = (k: string) => {
    const i = PARAM_ORDER.indexOf(k)
    return i === -1 ? PARAM_ORDER.length : i
  }
  return Object.entries(params)
    .filter(([, v]) => v !== '')
    .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

export function renderClientConf(input: ClientRenderInput): string {
  const { config, server } = input
  return [
    '[Interface]',
    `Address = ${config.address}/32`,
    // AmneziaVPN's .conf import only recognises a DNS line with two addresses, so a single one is repeated
    `DNS = ${(input.dns.length === 1 ? [input.dns[0], input.dns[0]] : input.dns).join(', ')}`,
    `PrivateKey = ${config.privateKey}`,
    `MTU = ${input.mtu}`,
    ...orderedParams(server.params).map(([k, v]) => `${k} = ${v}`),
    '',
    '[Peer]',
    `PublicKey = ${server.publicKey}`,
    `PresharedKey = ${config.presharedKey}`,
    // ::/0 pulls IPv6 into the tunnel where it is dropped, so it can't leak around it (R-B6/AC-N5)
    `AllowedIPs = ${ALLOWED_IPS.join(', ')}`,
    `Endpoint = ${server.endpointHost}:${server.listenPort}`,
    `PersistentKeepalive = ${KEEPALIVE}`,
    '',
  ].join('\n')
}

/**
 * Hashing the rendered text itself guarantees: revision changes iff the text changes. The server
 * name is not in the text but apps show it, so it is hashed too and a rename reaches them (R-A8).
 */
export function clientRevision(input: ClientRenderInput): string {
  return createHash('sha256').update(renderClientConf(input)).update(`\0${input.serverName}`).digest('hex').slice(0, 8)
}

/** "🇳🇱 Нидерланды": regional-indicator flag plus the Russian country name. */
export function countryServerName(code: string): string {
  const flag = String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65))
  const name = new Intl.DisplayNames(['ru'], { type: 'region' }).of(code.toUpperCase()) ?? code
  return `${flag} ${name}`
}

/** Qt qCompress(): 4-byte big-endian uncompressed length, then a zlib stream. */
export function qCompress(data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  return Buffer.concat([len, deflateSync(data, { level: 8 })])
}

/**
 * AmneziaVPN import key: "vpn://" + base64url(qCompress(JSON)), no padding.
 *
 * The JSON mirrors what the app itself builds when importing a native AWG .conf, so the
 * key behaves exactly like importing our .conf file (amnezia-client sources):
 * - client/core/controllers/selfhosted/importController.cpp: extractConfigFromData (vpn:// ->
 *   fromBase64(Base64UrlEncoding|OmitTrailingEquals) -> qUncompress -> "containers" => Amnezia JSON)
 *   and extractWireGuardConfig (containers[0] = { container: "amnezia-awg", awg: { last_config,
 *   isThirdPartyConfig, port (string), transport_proto } }, defaultContainer, description, dns1/dns2, hostName)
 * - client/core/controllers/selfhosted/exportController.cpp: generateVpnUrl / qCompress(json, 8)
 * - client/core/models/protocols/awgProtocolConfig.cpp: AwgServerConfig/AwgClientConfig::fromJson
 *   (awg.port read as string, last_config.port as int, mtu/persistent_keep_alive as strings)
 * - client/core/utils/constants/configKeys.h: key names
 * Note: upstream processAmneziaConfig() overwrites last_config.mtu with the platform default
 * (1376 on desktop) for every imported Amnezia JSON, so the fork must skip that for R-M1 to hold.
 */
export function renderVpnKey(input: ClientRenderInput): string {
  const { config, server } = input
  const params = Object.fromEntries(orderedParams(server.params))
  const lastConfig = {
    config: renderClientConf(input),
    hostName: server.endpointHost,
    port: server.listenPort,
    client_ip: `${config.address}/32`,
    client_priv_key: config.privateKey,
    psk_key: config.presharedKey,
    server_pub_key: server.publicKey,
    allowed_ips: ALLOWED_IPS,
    persistent_keep_alive: String(KEEPALIVE),
    mtu: String(input.mtu),
    ...params,
  }
  const container = 'amnezia-awg'
  const json = {
    containers: [{
      container,
      awg: {
        ...params,
        isThirdPartyConfig: true,
        last_config: JSON.stringify(lastConfig),
        port: String(server.listenPort),
        transport_proto: 'udp',
      },
    }],
    defaultContainer: container,
    description: input.serverName,
    dns1: input.dns[0] ?? '',
    dns2: input.dns[1] ?? input.dns[0] ?? '',
    hostName: server.endpointHost,
  }
  const packed = qCompress(Buffer.from(JSON.stringify(json), 'utf8'))
  return 'vpn://' + packed.toString('base64url')
}
