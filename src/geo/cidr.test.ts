import { describe, expect, it } from 'vitest'
import { cidrToRange, intToIp, ipToInt, mergeCidrs, rangeToCidrs } from './cidr'

describe('ipToInt/intToIp', () => {
  it('round-trips including high addresses', () => {
    for(const ip of ['0.0.0.0', '1.2.3.4', '128.0.0.1', '255.255.255.255']) {
      expect(intToIp(ipToInt(ip))).toBe(ip)
    }
    expect(ipToInt('255.255.255.255')).toBe(2 ** 32 - 1)
    expect(ipToInt('1.0.0.0')).toBe(16777216)
  })

  it('rejects junk', () => {
    expect(() => ipToInt('256.0.0.1')).toThrow()
    expect(() => ipToInt('::1')).toThrow()
    expect(() => intToIp(2 ** 32)).toThrow()
  })
})

describe('rangeToCidrs', () => {
  it('covers aligned ranges with one block', () => {
    expect(rangeToCidrs('1.0.0.0', '1.0.0.255')).toEqual(['1.0.0.0/24'])
    expect(rangeToCidrs('0.0.0.0', '255.255.255.255')).toEqual(['0.0.0.0/0'])
    expect(rangeToCidrs('10.0.0.5', '10.0.0.5')).toEqual(['10.0.0.5/32'])
  })

  it('splits odd ranges minimally', () => {
    expect(rangeToCidrs('1.0.0.1', '1.0.0.6')).toEqual(['1.0.0.1/32', '1.0.0.2/31', '1.0.0.4/31', '1.0.0.6/32'])
    expect(rangeToCidrs('192.168.0.0', '192.168.2.255')).toEqual(['192.168.0.0/23', '192.168.2.0/24'])
    expect(rangeToCidrs('255.255.255.254', '255.255.255.255')).toEqual(['255.255.255.254/31'])
  })
})

describe('mergeCidrs', () => {
  it('merges adjacent, overlapping and duplicate blocks', () => {
    expect(mergeCidrs(['10.0.1.0/24', '10.0.0.0/24', '10.0.0.128/25', '10.0.0.0/24'])).toEqual(['10.0.0.0/23'])
    expect(mergeCidrs(['1.0.0.0/24', '1.0.1.0/24', '1.0.2.0/24'])).toEqual(['1.0.0.0/23', '1.0.2.0/24'])
    expect(mergeCidrs(['8.8.8.8', '1.1.1.1/32'])).toEqual(['1.1.1.1/32', '8.8.8.8/32'])
    expect(mergeCidrs([])).toEqual([])
  })

  it('normalizes host bits', () => {
    expect(cidrToRange('10.0.0.77/24')).toEqual([ipToInt('10.0.0.0'), ipToInt('10.0.0.255')])
    expect(mergeCidrs(['10.0.0.77/24'])).toEqual(['10.0.0.0/24'])
  })
})
