import { Readable } from 'stream'
import readline from 'readline'
import zlib from 'zlib'
import { ipToInt, isIpv4, rangesToCidrs, type Range } from './cidr'

// db-ip "IP to Country Lite" (CC BY), monthly CSV: `start,end,CC` per line, IPv4 and
// IPv6 mixed. Only IPv4 is used (Q-B6).

export function dbipUrl(date: Date): string {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `https://download.db-ip.com/free/dbip-country-lite-${yyyy}-${mm}.csv.gz`
}

// Returns the IPv4 range of the line if it belongs to `country`, else null.
export function parseDbipLine(line: string, country: string): Range | null {
  const parts = line.trim().split(',')
  if(parts.length < 3) return null

  const [start, end, cc] = parts.map(p => p.trim().replace(/^"|"$/g, ''))
  if(cc.toUpperCase() !== country || !isIpv4(start) || !isIpv4(end)) return null

  const s = ipToInt(start)
  const e = ipToInt(end)
  return s <= e ? [s, e] : null
}

export async function parseDbipLines(lines: AsyncIterable<string> | Iterable<string>, country: string): Promise<string[]> {
  const cc = country.toUpperCase()
  const ranges: Range[] = []
  for await (const line of lines) {
    const range = parseDbipLine(line, cc)
    if(range) ranges.push(range)
  }
  return rangesToCidrs(ranges)
}

export function parseDbipCsv(text: string, country: string): string[] {
  const cc = country.toUpperCase()
  const ranges: Range[] = []
  for(const line of text.split('\n')) {
    const range = parseDbipLine(line, cc)
    if(range) ranges.push(range)
  }
  return rangesToCidrs(ranges)
}

export interface FetchCountryOpts {
  fetch?: typeof fetch
  now?: Date
}

// Downloads the current month's file, falling back to the previous month on 404 (the
// new file appears some time into the month). Streams gunzip -> lines: the unpacked
// file is tens of MB and we only keep one country's ranges.
export async function fetchCountryCidrs(country: string, opts: FetchCountryOpts = {}): Promise<string[]> {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? new Date()
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))

  let res: Response | null = null
  for(const url of [dbipUrl(now), dbipUrl(prev)]) {
    res = await doFetch(url)
    if(res.status !== 404) {
      if(!res.ok) throw new Error(`db-ip download failed: ${url} -> HTTP ${res.status}`)
      break
    }
  }
  if(!res || !res.ok || !res.body) throw new Error(`db-ip download failed: HTTP ${res?.status ?? 'n/a'}`)

  const gunzip = zlib.createGunzip()
  const source = Readable.fromWeb(res.body as import('stream/web').ReadableStream<Uint8Array>)
  source.on('error', err => gunzip.destroy(err))
  const lines = readline.createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity })

  return parseDbipLines(lines, country)
}
