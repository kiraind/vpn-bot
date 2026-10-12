import { describe, expect, it } from 'vitest'
import { createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto'
import { genKeyPair, genPresharedKey, publicKeyFromPrivate } from './wgKeys'

const hexToB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64')
const b64ToB64url = (b64: string) => Buffer.from(b64, 'base64').toString('base64url')

// RFC 7748 section 6.1 test vectors
const ALICE_PRIV = hexToB64('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
const ALICE_PUB = hexToB64('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')
const BOB_PRIV = hexToB64('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb')
const BOB_PUB = hexToB64('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')

describe('publicKeyFromPrivate', () => {
  it('matches RFC 7748 vectors', () => {
    expect(publicKeyFromPrivate(ALICE_PRIV)).toBe(ALICE_PUB)
    expect(publicKeyFromPrivate(BOB_PRIV)).toBe(BOB_PUB)
  })

  it('rejects malformed keys', () => {
    expect(() => publicKeyFromPrivate('abc')).toThrow()
    expect(() => publicKeyFromPrivate(Buffer.alloc(31).toString('base64'))).toThrow()
  })
})

describe('genKeyPair', () => {
  it('produces 32-byte base64 keys that agree with each other', () => {
    const kp = genKeyPair()
    expect(Buffer.from(kp.privateKey, 'base64')).toHaveLength(32)
    expect(Buffer.from(kp.publicKey, 'base64')).toHaveLength(32)
    expect(kp.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    expect(publicKeyFromPrivate(kp.privateKey)).toBe(kp.publicKey)
  })

  it('derives the same public key as the independent JWK path', () => {
    const kp = genKeyPair()
    const key = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: b64ToB64url(kp.privateKey), x: b64ToB64url(kp.publicKey) }, format: 'jwk' })
    const jwk = createPublicKey(key).export({ format: 'jwk' })
    expect(jwk.x).toBe(b64ToB64url(kp.publicKey))
  })

  it('pairs produce a shared secret', () => {
    const a = genKeyPair()
    const b = genKeyPair()
    const toKeys = (kp: { privateKey: string, publicKey: string }) => ({
      privateKey: createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: b64ToB64url(kp.privateKey), x: b64ToB64url(kp.publicKey) }, format: 'jwk' }),
      publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64ToB64url(kp.publicKey) }, format: 'jwk' }),
    })
    const ka = toKeys(a), kb = toKeys(b)
    expect(diffieHellman({ privateKey: ka.privateKey, publicKey: kb.publicKey }))
      .toEqual(diffieHellman({ privateKey: kb.privateKey, publicKey: ka.publicKey }))
  })

  it('is random', () => {
    expect(genKeyPair().privateKey).not.toBe(genKeyPair().privateKey)
  })
})

describe('genPresharedKey', () => {
  it('is 32 random bytes in base64', () => {
    const psk = genPresharedKey()
    expect(Buffer.from(psk, 'base64')).toHaveLength(32)
    expect(psk).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    expect(genPresharedKey()).not.toBe(psk)
  })
})
