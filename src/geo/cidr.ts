// IPv4-only helpers (Q-B6). Addresses are handled as plain non-negative numbers
// (0..2^32-1) instead of int32 bit ops, which would go negative above 127.255.255.255.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const SPACE = 2 ** 32

export type Range = [number, number]

export function isIpv4(ip: string): boolean {
  const m = IPV4.exec(ip)
  return !!m && m.slice(1).every(o => Number(o) <= 255)
}

export function ipToInt(ip: string): number {
  const m = IPV4.exec(ip.trim())
  if(!m) throw new Error(`invalid IPv4 address: ${ip}`)

  let n = 0
  for(const part of m.slice(1)) {
    const octet = Number(part)
    if(octet > 255) throw new Error(`invalid IPv4 address: ${ip}`)
    n = n * 256 + octet
  }
  return n
}

export function intToIp(n: number): string {
  if(!Number.isInteger(n) || n < 0 || n >= SPACE) throw new Error(`invalid IPv4 integer: ${n}`)
  return [n / 2 ** 24, n / 2 ** 16, n / 2 ** 8, n].map(v => Math.floor(v) % 256).join('.')
}

export function cidrToRange(cidr: string): Range {
  const [ip, bitsStr = '32'] = cidr.trim().split('/')
  const bits = Number(bitsStr)
  if(!/^\d{1,2}$/.test(bitsStr) || bits > 32) throw new Error(`invalid CIDR: ${cidr}`)

  const size = 2 ** (32 - bits)
  const start = Math.floor(ipToInt(ip) / size) * size
  return [start, start + size - 1]
}

// Minimal CIDR cover of the inclusive range [start, end]: greedily take the largest
// aligned block that starts at `start` and doesn't overshoot `end`.
export function rangeToCidrs(start: string | number, end: string | number): string[] {
  let s = typeof start === 'string' ? ipToInt(start) : start
  const e = typeof end === 'string' ? ipToInt(end) : end
  if(s > e) throw new Error(`invalid range: ${start}-${end}`)

  const out: string[] = []
  while(s <= e) {
    let bits = 32
    while(bits > 0) {
      const size = 2 ** (33 - bits)
      if(s % size !== 0 || s + size - 1 > e) break
      bits -= 1
    }
    out.push(`${intToIp(s)}/${bits}`)
    s += 2 ** (32 - bits)
  }
  return out
}

// Sorts and merges overlapping/adjacent ranges.
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Range[] = []
  for(const [s, e] of sorted) {
    const last = out[out.length - 1]
    if(last && s <= last[1] + 1) {
      if(e > last[1]) last[1] = e
    } else {
      out.push([s, e])
    }
  }
  return out
}

export function rangesToCidrs(ranges: Range[]): string[] {
  return mergeRanges(ranges).flatMap(([s, e]) => rangeToCidrs(s, e))
}

export function mergeCidrs(cidrs: string[]): string[] {
  return rangesToCidrs(cidrs.map(cidrToRange))
}
