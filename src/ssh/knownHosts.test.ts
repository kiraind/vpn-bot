import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { checkHostKey, getKnownHost, hostKeyFingerprint, trustAddress } from './knownHosts'

describe('knownHosts', () => {
  it('pins a new address, trusts the same key, flags a different one', () => {
    const db = openDb(':memory:')
    expect(checkHostKey(db, '203.0.113.11', 'SHA256:a')).toBe('pinned-new')
    expect(checkHostKey(db, '203.0.113.11', 'SHA256:a')).toBe('trusted')
    expect(checkHostKey(db, '203.0.113.11', 'SHA256:b')).toBe('mismatch')
    expect(getKnownHost(db, '203.0.113.11')).toMatchObject({ host_key: 'SHA256:a', mismatch_key: 'SHA256:b' })
    // still refused on retry, pin unchanged
    expect(checkHostKey(db, '203.0.113.11', 'SHA256:b')).toBe('mismatch')
  })

  it('keeps addresses independent', () => {
    const db = openDb(':memory:')
    checkHostKey(db, '203.0.113.11', 'SHA256:a')
    expect(checkHostKey(db, '198.51.100.20', 'SHA256:b')).toBe('pinned-new')
  })

  it('trustAddress makes the next connect re-pin', () => {
    const db = openDb(':memory:')
    checkHostKey(db, '203.0.113.11', 'SHA256:a')
    checkHostKey(db, '203.0.113.11', 'SHA256:b')
    trustAddress(db, '203.0.113.11')
    expect(checkHostKey(db, '203.0.113.11', 'SHA256:b')).toBe('pinned-new')
    expect(checkHostKey(db, '203.0.113.11', 'SHA256:b')).toBe('trusted')
    expect(getKnownHost(db, '203.0.113.11')?.mismatch_key).toBeNull()
  })

  it('fingerprints like OpenSSH', () => {
    expect(hostKeyFingerprint(Buffer.from('abc'))).toBe('SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0')
  })
})
