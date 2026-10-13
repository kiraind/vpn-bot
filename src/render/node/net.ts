// Tiny IPv4/CIDR helpers shared by the node renderers.

function ipToInt(ip: string): number {
  const parts = ip.split('.')
  if(parts.length !== 4) throw new Error(`invalid IPv4 address: ${ip}`)
  return parts.reduce((acc, p) => {
    const n = Number(p)
    if(!/^\d{1,3}$/.test(p) || n > 255) throw new Error(`invalid IPv4 address: ${ip}`)
    return acc * 256 + n
  }, 0)
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.')
}

function parseCidr(cidr: string): { base: number, len: number } {
  const [ip, lenStr] = cidr.split('/')
  const len = Number(lenStr)
  if(lenStr === undefined || !/^\d{1,2}$/.test(lenStr) || len > 32) throw new Error(`invalid CIDR: ${cidr}`)
  const size = 2 ** (32 - len)
  return { base: Math.floor(ipToInt(ip) / size) * size, len }
}

export function prefixLen(cidr: string): number {
  return parseCidr(cidr).len
}

/** n-th address of the subnet: subnetHost('10.255.0.0/30', 1) === '10.255.0.1'. */
export function subnetHost(cidr: string, n: number): string {
  const { base, len } = parseCidr(cidr)
  if(!Number.isInteger(n) || n < 0 || n >= 2 ** (32 - len)) throw new Error(`host ${n} out of range for ${cidr}`)
  return intToIp(base + n)
}
