import { describe, expect, it } from 'vitest'
import { getProfile } from './index'
import {
  AWG2_PARAM_KEYS, COOKIE_JUNK_SIZE_MAX, HEADER_MAX, HEADER_MIN, INIT_JUNK_SIZE_MAX, JMAX_LIMIT,
  JUNK_PACKET_SIZE_MIN, MESSAGE_SIZES, RESPONSE_JUNK_SIZE_MAX, generateAwg2Params, generateHeaderRanges,
} from './awg2'

const int = (value: string) => {
  expect(value).toMatch(/^\d+$/)
  return Number(value)
}

function parseRange(value: string): [number, number] {
  const match = /^(\d+)-(\d+)$/.exec(value)
  expect(match, `bad range ${value}`).not.toBeNull()
  return [Number(match![1]), Number(match![2])]
}

describe('awg2 profile', () => {
  it('is returned by getProfile', () => {
    const profile = getProfile('awg2')
    expect(profile.name).toBe('awg2')
    expect(profile.paramKeys).toEqual(AWG2_PARAM_KEYS)
    expect(Object.keys(profile.generateParams()).sort()).toEqual([...AWG2_PARAM_KEYS].sort())
  })

  it('throws on unknown profile', () => {
    expect(() => getProfile('awg9' as never)).toThrow(/unknown protocol/)
  })

  it('always generates a param set amneziawg accepts', () => {
    const seen = new Set<string>()
    for(let i = 0; i < 2000; i++) {
      const params = getProfile('awg2').generateParams()
      seen.add(params.H1)

      const jc = int(params.Jc)
      const jmin = int(params.Jmin)
      const jmax = int(params.Jmax)
      expect(jc).toBeGreaterThanOrEqual(4)
      expect(jc).toBeLessThanOrEqual(6)
      expect(jmin).toBeLessThanOrEqual(jmax)
      expect(jmax).toBeLessThanOrEqual(JMAX_LIMIT)

      const [s1, s2, s3, s4] = [params.S1, params.S2, params.S3, params.S4].map(int)
      expect(s1).toBeGreaterThanOrEqual(JUNK_PACKET_SIZE_MIN)
      expect(s1).toBeLessThan(INIT_JUNK_SIZE_MAX)
      expect(s2).toBeGreaterThanOrEqual(JUNK_PACKET_SIZE_MIN)
      expect(s2).toBeLessThan(RESPONSE_JUNK_SIZE_MAX)
      expect(s3).toBeGreaterThanOrEqual(JUNK_PACKET_SIZE_MIN)
      expect(s3).toBeLessThan(COOKIE_JUNK_SIZE_MAX)
      expect(s1 + 56).not.toBe(s2)
      expect(new Set([s1, s2, s3, s4]).size).toBe(4)
      // padded message sizes must stay distinguishable
      const sizes = [
        s1 + MESSAGE_SIZES.init,
        s2 + MESSAGE_SIZES.response,
        s3 + MESSAGE_SIZES.cookie,
        s4 + MESSAGE_SIZES.transport,
      ]
      expect(new Set(sizes).size).toBe(4)

      const ranges = [params.H1, params.H2, params.H3, params.H4].map(parseRange)
      for(const [start, end] of ranges) {
        expect(start).toBeGreaterThanOrEqual(HEADER_MIN)
        expect(start).toBeLessThan(end)
        expect(end).toBeLessThanOrEqual(HEADER_MAX)
      }
      const sorted = [...ranges].sort((a, b) => a[0] - b[0])
      for(let k = 1; k < sorted.length; k++) expect(sorted[k][0]).toBeGreaterThan(sorted[k - 1][1])
    }
    expect(seen.size).toBeGreaterThan(1990)
  })

  it('handles extreme rng outputs', () => {
    const low = generateHeaderRanges((min) => min).map(parseRange)
    const high = generateHeaderRanges((_min, max) => max - 1).map(parseRange)
    for(const ranges of [low, high]) {
      for(const [start, end] of ranges) {
        expect(start).toBeGreaterThanOrEqual(HEADER_MIN)
        expect(start).toBeLessThan(end)
        expect(end).toBeLessThanOrEqual(HEADER_MAX)
      }
      const sorted = [...ranges].sort((a, b) => a[0] - b[0])
      for(let k = 1; k < sorted.length; k++) expect(sorted[k][0]).toBeGreaterThan(sorted[k - 1][1])
    }
  })

  it('rerolls S2/S3 on collisions', () => {
    // scripted rng: S1=36, then S2=92 (36+148 == 92+92) and S2=36 rejected before S2=40;
    // S3=36 and S3=12 (S4) rejected before S3=20
    const script = [36, 92, 36, 40, 36, 12, 20]
    const rand = (min: number, max: number) => script.length ? script.shift()! : min + Math.floor((max - min) / 2)
    const params = generateAwg2Params(rand)
    expect([params.S1, params.S2, params.S3, params.S4]).toEqual(['36', '40', '20', '12'])
  })
})
