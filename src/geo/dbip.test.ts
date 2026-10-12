import zlib from 'zlib'
import { describe, expect, it, vi } from 'vitest'
import { dbipUrl, fetchCountryCidrs, parseDbipCsv } from './dbip'

const FIXTURE = [
  '1.0.0.0,1.0.0.255,AU',
  '2.0.0.0,2.0.0.255,RU',
  '2.0.1.0,2.0.1.255,RU',
  '2.0.2.0,2.0.2.5,RU',
  '3.0.0.0,3.0.0.255,DE',
  '5.0.0.0,5.0.0.127,ru',
  '2a00:1::,2a00:1:ffff:ffff:ffff:ffff:ffff:ffff,RU',
  '::ffff:1.2.3.0,::ffff:1.2.3.255,RU',
  'garbage line',
  '',
].join('\r\n')

describe('dbipUrl', () => {
  it('uses UTC year and month', () => {
    expect(dbipUrl(new Date('2026-01-05T00:00:00Z'))).toBe('https://download.db-ip.com/free/dbip-country-lite-2026-01.csv.gz')
  })
})

describe('parseDbipCsv', () => {
  it('keeps only IPv4 ranges of the country, merged', () => {
    expect(parseDbipCsv(FIXTURE, 'RU')).toEqual([
      '2.0.0.0/23', '2.0.2.0/30', '2.0.2.4/31', '5.0.0.0/25',
    ])
    expect(parseDbipCsv(FIXTURE, 'de')).toEqual(['3.0.0.0/24'])
    expect(parseDbipCsv(FIXTURE, 'US')).toEqual([])
  })
})

describe('fetchCountryCidrs', () => {
  const gz = zlib.gzipSync(Buffer.from(FIXTURE))

  it('falls back to the previous month on 404', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if(String(url).includes('2026-01')) return new Response(null, { status: 404 })
      return new Response(gz, { status: 200 })
    })
    const cidrs = await fetchCountryCidrs('RU', { fetch: fetchMock as unknown as typeof fetch, now: new Date('2026-01-02T00:00:00Z') })
    expect(cidrs).toEqual(['2.0.0.0/23', '2.0.2.0/30', '2.0.2.4/31', '5.0.0.0/25'])
    expect(fetchMock.mock.calls.map(c => String(c[0]))).toEqual([
      'https://download.db-ip.com/free/dbip-country-lite-2026-01.csv.gz',
      'https://download.db-ip.com/free/dbip-country-lite-2025-12.csv.gz',
    ])
  })

  it('throws on other HTTP errors and on double 404', async () => {
    const err500 = vi.fn(async () => new Response(null, { status: 500 }))
    await expect(fetchCountryCidrs('RU', { fetch: err500 as unknown as typeof fetch })).rejects.toThrow(/500/)
    const err404 = vi.fn(async () => new Response(null, { status: 404 }))
    await expect(fetchCountryCidrs('RU', { fetch: err404 as unknown as typeof fetch })).rejects.toThrow(/404/)
  })

  it('rejects corrupt gzip', async () => {
    const bad = vi.fn(async () => new Response(Buffer.from('not gzip'), { status: 200 }))
    await expect(fetchCountryCidrs('RU', { fetch: bad as unknown as typeof fetch })).rejects.toThrow()
  })
})
