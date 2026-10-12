import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import type { KeyPair } from '../types'

// PKCS#8 / SPKI DER headers for X25519 (OID 1.3.101.110); the raw 32-byte key follows
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

function rawKey(b64: string, what: string): Buffer {
  const raw = Buffer.from(b64, 'base64')
  if(raw.length !== 32 || raw.toString('base64') !== b64.trim()) throw new Error(`invalid ${what}: expected base64 of 32 bytes`)
  return raw
}

// Same format as `wg genkey | wg pubkey`: base64 of the raw 32-byte X25519 keys
export function genKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length)
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length)
  return { privateKey: priv.toString('base64'), publicKey: pub.toString('base64') }
}

export function publicKeyFromPrivate(priv: string): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, rawKey(priv, 'private key')]), format: 'der', type: 'pkcs8' })
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' })
  return der.subarray(SPKI_PREFIX.length).toString('base64')
}

export function genPresharedKey(): string {
  return randomBytes(32).toString('base64')
}
