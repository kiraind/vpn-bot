import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { ensureCoordinatorKey } from './keys'

describe('ensureCoordinatorKey', () => {
  it('generates once with tight permissions, then reuses', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vpnc-ssh-')), 'ssh')
    const first = ensureCoordinatorKey(dir)
    expect(first.publicKey).toMatch(/^ssh-ed25519 \S+ vpn-coordinator$/)
    expect(first.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(fs.statSync(path.join(dir, 'id_ed25519')).mode & 0o777).toBe(0o600)
    expect(ensureCoordinatorKey(dir)).toEqual(first)
    fs.rmSync(path.dirname(dir), { recursive: true })
  })
})
