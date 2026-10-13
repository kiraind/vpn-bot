import { describe, expect, it } from 'vitest'
import { getProfile } from './index'
import { AWG3_PARAM_KEYS, generateAwg3Params } from './awg3'

describe('awg3 profile', () => {
  it('is returned by getProfile with every key it declares', () => {
    const profile = getProfile('awg3')
    expect(profile.name).toBe('awg3')
    expect(Object.keys(profile.generateParams()).sort()).toEqual([...AWG3_PARAM_KEYS].sort())
  })

  it('generates what the kernel module accepts with header protection', () => {
    for(let i = 0; i < 200; i++) {
      const p = getProfile('awg3').generateParams()
      const jc = Number(p.Jc)
      expect(jc).toBeGreaterThanOrEqual(4)
      expect(jc).toBeLessThan(7)
      for(const s of ['S1', 'S2', 'S3', 'S4']) expect(Number(p[s])).toBeGreaterThanOrEqual(12)
      expect([p.H1, p.H2, p.H3, p.H4]).toEqual(['1', '2', '3', '4'])
      expect(Buffer.from(p.HeaderProtectionKey, 'base64')).toHaveLength(32)
      for(const k of ['RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts']) {
        const [lo, hi] = p[k].split('-').map(Number)
        expect(lo).toBeLessThan(hi)
        expect(hi).toBeLessThanOrEqual(0xffff)
      }
      expect(p.RandomTrailers).toBe('on')
      expect(p.DisableCookies).toBe('on')
    }
  })

  it('draws a fresh header protection key each time', () => {
    const a = generateAwg3Params()
    const b = generateAwg3Params()
    expect(a.HeaderProtectionKey).not.toBe(b.HeaderProtectionKey)
  })
})
