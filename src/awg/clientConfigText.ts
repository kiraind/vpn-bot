import { awgDns, awgEndpointHost } from '../config'
import { ServerConfig } from './serverConfig'
import { ClientRecord } from '../store/clients'

export function buildClientConfig(client: ClientRecord, server: ServerConfig): string {
  const interfaceLines = [
    `Address = ${client.address}/32`,
    `DNS = ${awgDns}`,
    `PrivateKey = ${client.privateKey}`,
    ...Object.entries(server.extra).map(([key, value]) => `${key} = ${value}`)
  ]

  const peerLines = [
    `PublicKey = ${server.publicKey}`,
    `PresharedKey = ${client.presharedKey}`,
    `AllowedIPs = 0.0.0.0/0, ::/0`,
    `Endpoint = ${awgEndpointHost}:${server.listenPort}`,
    `PersistentKeepalive = 25-35`
  ]

  return [
    '[Interface]',
    ...interfaceLines,
    '',
    '[Peer]',
    ...peerLines
  ].join('\n')
}
