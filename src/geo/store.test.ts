import { describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { getGeoSet, isGeoSetStale, updateGeoSet } from './store'

const cidrs = (n: number) => Array.from({ length: n }, (_, i) => `10.0.${i}.0/24`)

describe('geo store', () => {
  it('stores and reads a set', () => {
    const db = openDb(':memory:')
    expect(getGeoSet(db, 'RU')).toBeNull()
    expect(updateGeoSet(db, 'ru', cidrs(10), 'test')).toEqual({ updated: true })
    const set = getGeoSet(db, 'RU')!
    expect(set.count).toBe(10)
    expect(set.cidrs).toEqual(cidrs(10))
    expect(typeof set.fetchedAt).toBe('string')
  })

  it('refuses empty or < 50% sets and keeps the old one (R-L7)', () => {
    const db = openDb(':memory:')
    expect(updateGeoSet(db, 'RU', [], 'test').updated).toBe(false)
    updateGeoSet(db, 'RU', cidrs(10), 'test')
    const small = updateGeoSet(db, 'RU', cidrs(4), 'test')
    expect(small.updated).toBe(false)
    expect(small.reason).toMatch(/too small/)
    expect(updateGeoSet(db, 'RU', [], 'test').updated).toBe(false)
    expect(getGeoSet(db, 'RU')!.count).toBe(10)
    expect(updateGeoSet(db, 'RU', cidrs(5), 'test').updated).toBe(true)
    expect(getGeoSet(db, 'RU')!.count).toBe(5)
  })

  it('reports staleness', () => {
    const db = openDb(':memory:')
    expect(isGeoSetStale(db, 'RU')).toBe(true)
    updateGeoSet(db, 'RU', cidrs(1), 'test')
    expect(isGeoSetStale(db, 'RU')).toBe(false)
    expect(isGeoSetStale(db, 'RU', 7 * 24 * 3600 * 1000, new Date(Date.now() + 8 * 24 * 3600 * 1000))).toBe(true)
  })
})
