import { describe, expect, it } from 'vitest'
import { LOGIN_CODE_ALPHABET, genDeviceToken, genLoginCode, hashSecret, normalizeLoginCode } from './tokens'

describe('genLoginCode', () => {
  it('is 6 chars from the alphabet', () => {
    for(let i = 0; i < 200; i++) expect(genLoginCode()).toMatch(new RegExp(`^[${LOGIN_CODE_ALPHABET}]{6}$`))
  })

  it('alphabet has no lookalikes', () => {
    for(const c of '0O1IL') expect(LOGIN_CODE_ALPHABET).not.toContain(c)
    expect(new Set(LOGIN_CODE_ALPHABET).size).toBe(LOGIN_CODE_ALPHABET.length)
  })

  it('is random', () => {
    const codes = new Set(Array.from({ length: 100 }, genLoginCode))
    expect(codes.size).toBeGreaterThan(95)
  })
})

describe('normalizeLoginCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeLoginCode('  ab3k9z\n')).toBe('AB3K9Z')
  })
})

describe('genDeviceToken', () => {
  it('is 32 bytes base64url', () => {
    const t = genDeviceToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(t, 'base64url')).toHaveLength(32)
    expect(genDeviceToken()).not.toBe(t)
  })
})

describe('hashSecret', () => {
  it('is sha256 hex', () => {
    expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hashSecret('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})
