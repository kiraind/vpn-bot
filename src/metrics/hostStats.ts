import { execFile } from 'child_process'

// Host load figures for /metrics (CPU, RAM, disk, network), read from /proc by a shell snippet so
// the same code covers LOCAL/REMOTE (appended to the health probe, no agent on the nodes) and the
// coordinator's own host. Each output line is `__<key>__ <values>`.

export const HOST_STATS_SCRIPT = [
  'echo "__cpu__ $(head -n1 /proc/stat)"',
  'echo "__clk__ $(getconf CLK_TCK)"',
  'echo "__ncpu__ $(nproc)"',
  'echo "__load__ $(cat /proc/loadavg)"',
  'echo "__uptime__ $(cat /proc/uptime)"',
  `awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {print "__mem__ " $1 " " $2}' /proc/meminfo`,
  `df -P -B1 / | awk 'NR==2 {print "__disk__ " $2 " " $4}'`,
  // "  eth0: 123 ..." or "eth0:123 ..." (no space once counters get wide): split off the colon first.
  `awk 'NR>2 {sub(/:/, " "); print "__net__ " $1 " " $2 " " $10}' /proc/net/dev`,
].join('; ')

const CPU_MODES = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'] as const

export interface HostStats {
  /** Cumulative CPU time over all cores per mode, seconds since boot. */
  cpuSeconds?: Record<string, number>
  cpus?: number
  load?: [number, number, number]
  uptimeSec?: number
  memTotalBytes?: number
  memAvailableBytes?: number
  swapTotalBytes?: number
  swapFreeBytes?: number
  /** Root filesystem. */
  diskTotalBytes?: number
  diskAvailableBytes?: number
  /** Per network device, cumulative since boot. */
  net: Record<string, { rxBytes: number, txBytes: number }>
}

export const STATS_LINE = /^__([a-z]+)__(?: (.*))?$/

function nums(text: string): number[] {
  return text.trim().split(/\s+/).map(Number)
}

const ok = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n)

/** Parses the script's lines; other lines are ignored. Undefined when no stats lines were found. */
export function parseHostStats(lines: string[]): HostStats | undefined {
  const stats: HostStats = { net: {} }
  let cpuTicks: number[] | undefined
  let clk = 100
  let found = false

  for(const raw of lines) {
    const m = STATS_LINE.exec(raw.replace(/\r$/, ''))
    if(!m) continue
    const [, key, rest = ''] = m

    switch(key) {
      case 'cpu': {
        // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
        const parts = rest.trim().split(/\s+/)
        if(parts[0] === 'cpu') cpuTicks = parts.slice(1).map(Number)
        break
      }
      case 'clk': {
        const n = Number(rest)
        if(n > 0) clk = n
        break
      }
      case 'ncpu': {
        const n = Number(rest)
        if(n > 0) stats.cpus = n
        break
      }
      case 'load': {
        const [a, b, c] = nums(rest)
        if(ok(a) && ok(b) && ok(c)) stats.load = [a, b, c]
        break
      }
      case 'uptime': {
        const [up] = nums(rest)
        if(ok(up)) stats.uptimeSec = up
        break
      }
      case 'mem': {
        const [name, kb] = rest.trim().split(/\s+/)
        const bytes = Number(kb) * 1024
        if(!Number.isFinite(bytes)) break
        if(name === 'MemTotal:') stats.memTotalBytes = bytes
        if(name === 'MemAvailable:') stats.memAvailableBytes = bytes
        if(name === 'SwapTotal:') stats.swapTotalBytes = bytes
        if(name === 'SwapFree:') stats.swapFreeBytes = bytes
        break
      }
      case 'disk': {
        const [total, avail] = nums(rest)
        if(ok(total) && ok(avail)) {
          stats.diskTotalBytes = total
          stats.diskAvailableBytes = avail
        }
        break
      }
      case 'net': {
        const [dev, rx, tx] = rest.trim().split(/\s+/)
        if(dev && ok(Number(rx)) && ok(Number(tx))) stats.net[dev] = { rxBytes: Number(rx), txBytes: Number(tx) }
        break
      }
      default:
        continue
    }
    found = true
  }

  if(cpuTicks) {
    const cpuSeconds: Record<string, number> = {}
    CPU_MODES.forEach((mode, i) => {
      if(ok(cpuTicks![i])) cpuSeconds[mode] = cpuTicks![i] / clk
    })
    stats.cpuSeconds = cpuSeconds
  }

  return found ? stats : undefined
}

/** The coordinator's own host, same figures as the nodes. */
export function readLocalHostStats(timeoutMs = 5000): Promise<HostStats | undefined> {
  return new Promise(resolve => {
    execFile('bash', ['-c', HOST_STATS_SCRIPT], { timeout: timeoutMs }, (_err, stdout) => {
      resolve(parseHostStats(String(stdout ?? '').split('\n')))
    })
  })
}
