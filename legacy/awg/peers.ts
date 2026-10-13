import { awgConfigPath, awgInterface } from '../config'
import { runInContainer } from './exec'
import { parseConf, serializeConf, ParsedConf } from './conf'

export async function genKeyPair(): Promise<{ privateKey: string, publicKey: string }> {
  const privateKey = (await runInContainer(['awg', 'genkey'])).trim()
  const publicKey = (await runInContainer(['awg', 'pubkey'], privateKey)).trim()

  return { privateKey, publicKey }
}

export async function genPresharedKey(): Promise<string> {
  return (await runInContainer(['awg', 'genpsk'])).trim()
}

async function readConf() {
  const text = await runInContainer(['cat', awgConfigPath])

  return parseConf(text)
}

async function writeConf(conf: ParsedConf) {
  await runInContainer(['sh', '-c', `cat > ${awgConfigPath}`], serializeConf(conf))
}

async function reload(): Promise<void> {
  await runInContainer(['bash', '-c', `awg syncconf ${awgInterface} <(awg-quick strip ${awgConfigPath})`])
}

export async function addPeer(publicKey: string, presharedKey: string, address: string): Promise<void> {
  const conf = await readConf()

  conf.peers.push({
    PublicKey: publicKey,
    PresharedKey: presharedKey,
    AllowedIPs: `${address}/32`
  })

  await writeConf(conf)
  await reload()
}

export async function removePeer(publicKey: string): Promise<void> {
  const conf = await readConf()

  conf.peers = conf.peers.filter(peer => peer.PublicKey !== publicKey)

  await writeConf(conf)
  await reload()
}
