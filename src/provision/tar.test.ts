import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packTar } from './tar'

function extract(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-test-'))
  execFileSync('tar', ['-xf', '-', '-p', '-C', dir], { input: buf })
  return dir
}

describe('packTar', () => {
  it('round-trips through system tar with contents and modes', () => {
    const longDir = 'files/' + Array.from({ length: 8 }, (_, i) => `segment-number-${i}`).join('/')
    const longPath = `${longDir}/a-rather-long-file-name-that-still-fits-into-the-name-field.conf`
    expect(longPath.length).toBeGreaterThan(200)
    const bin = Buffer.from([0, 1, 2, 255, 254, 10, 13])
    const entries = [
      { path: 'apply.sh', mode: 0o755, content: '#!/bin/bash\necho hi\n' },
      { path: 'files/etc/amnezia/amneziawg/awgc.conf', mode: 0o600, content: '[Interface]\nPrivateKey = a+/=\n' },
      { path: 'empty', mode: 0o644, content: '' },
      { path: 'exact512', mode: 0o644, content: 'x'.repeat(512) },
      { path: 'utf8.txt', mode: 0o640, content: 'привет\n' },
      { path: 'bin.dat', mode: 0o644, content: bin },
      { path: longPath, mode: 0o644, content: 'long\n' },
    ]
    const buf = packTar(entries)
    expect(buf.length % 512).toBe(0)
    const dir = extract(buf)
    try {
      for(const e of entries) {
        const p = path.join(dir, e.path)
        const want = typeof e.content === 'string' ? Buffer.from(e.content) : e.content
        expect(fs.readFileSync(p)).toEqual(want)
        expect(fs.statSync(p).mode & 0o7777).toBe(e.mode)
      }
      const listed = execFileSync('tar', ['-tf', '-'], { input: buf }).toString().trim().split('\n')
      expect(listed).toEqual(entries.map(e => e.path))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is deterministic', () => {
    const e = [{ path: 'a', mode: 0o644, content: 'x' }]
    expect(packTar(e)).toEqual(packTar(e))
  })

  it('rejects unsafe or too long paths', () => {
    expect(() => packTar([{ path: '/etc/passwd', mode: 0o644, content: '' }])).toThrow()
    expect(() => packTar([{ path: 'a/../b', mode: 0o644, content: '' }])).toThrow()
    expect(() => packTar([{ path: 'x'.repeat(101), mode: 0o644, content: '' }])).toThrow()
  })
})
