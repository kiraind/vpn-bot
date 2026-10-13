import fs from 'fs'
import path from 'path'
import { utils } from 'ssh2'

export const DEFAULT_SSH_KEY_DIR = '/var/lib/vpn-coordinator/ssh'

export interface CoordinatorKey {
  privateKey: string
  publicKey: string
}

// The coordinator's own SSH identity (spec 7.2 step 2). Generated once and kept forever:
// after bootstrap the nodes only accept this key, so losing it means re-bootstrapping (R-S5).
export function ensureCoordinatorKey(dir = DEFAULT_SSH_KEY_DIR): CoordinatorKey {
  const privatePath = path.join(dir, 'id_ed25519')
  const publicPath = path.join(dir, 'id_ed25519.pub')

  if(fs.existsSync(privatePath) && fs.existsSync(publicPath)) {
    return {
      privateKey: fs.readFileSync(privatePath, 'utf8'),
      publicKey: fs.readFileSync(publicPath, 'utf8').trim(),
    }
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const pair = utils.generateKeyPairSync('ed25519', { comment: 'vpn-coordinator' })
  const publicKey = pair.public.trim()

  // Write the public half first: a crash in between leaves no private key, so the next
  // start regenerates both instead of pairing a new private key with a stale public one.
  fs.writeFileSync(publicPath, `${publicKey}\n`, { mode: 0o644 })
  fs.writeFileSync(privatePath, pair.private, { mode: 0o600 })
  fs.chmodSync(privatePath, 0o600)

  return { privateKey: pair.private, publicKey }
}
