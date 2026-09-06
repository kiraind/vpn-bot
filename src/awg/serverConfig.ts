import { awgConfigPath } from '../config'
import { runInContainer } from './exec'
import { parseConf, ConfSection } from './conf'

export interface ServerConfig {
  subnet: string // e.g. "10.8.1." — prefix shared by all client addresses
  listenPort: string
  publicKey: string
  extra: ConfSection // Jc, Jmin, Jmax, S1-S4, H1-H4, HeaderProtectionKey, ... — copied verbatim into client configs
}

export async function getServerConfig(): Promise<ServerConfig> {
  const text = await runInContainer(['cat', awgConfigPath])
  const { interface: iface } = parseConf(text)

  const { PrivateKey, Address, ListenPort, ...extra } = iface

  const publicKey = (await runInContainer(['awg', 'pubkey'], PrivateKey)).trim()

  const [ip] = Address.split('/')
  const subnet = `${ip.split('.').slice(0, 3).join('.')}.`

  return {
    subnet,
    listenPort: ListenPort,
    publicKey,
    extra
  }
}
