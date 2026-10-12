import { describe, expect, it } from 'vitest'
import { prefixLen, subnetHost } from './net'

describe('net helpers', () => {
  it('computes subnet hosts', () => {
    expect(subnetHost('10.255.0.0/30', 1)).toBe('10.255.0.1')
    expect(subnetHost('10.255.0.0/30', 2)).toBe('10.255.0.2')
    expect(subnetHost('10.66.0.0/16', 1)).toBe('10.66.0.1')
    expect(subnetHost('10.66.5.7/16', 258)).toBe('10.66.1.2')
  })
  it('rejects out of range and bad input', () => {
    expect(() => subnetHost('10.255.0.0/30', 4)).toThrow()
    expect(() => subnetHost('10.255.0/30', 1)).toThrow()
    expect(() => subnetHost('10.255.0.0/33', 1)).toThrow()
  })
  it('returns prefix length', () => {
    expect(prefixLen('10.66.0.0/16')).toBe(16)
    expect(prefixLen('0.0.0.0/0')).toBe(0)
  })
})
