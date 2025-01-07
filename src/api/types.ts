export interface WGClient {
  id: string
  name: string
  enabled: boolean
  address: string
  publicKey: string
  createdAt: string
  updatedAt: string
  downloadableConfig: boolean
  persistentKeepalive: 'on' | 'off'
  latestHandshakeAt: string
  transferRx: number
  transferTx: number
}
