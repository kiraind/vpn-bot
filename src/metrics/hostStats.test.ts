import { describe, expect, it } from 'vitest'
import { parseHostStats, readLocalHostStats } from './hostStats'

const SAMPLE = [
  '__cpu__ cpu  1000 50 300 8000 100 0 20 30 0 0',
  '__clk__ 100',
  '__ncpu__ 2',
  '__load__ 0.15 0.10 0.05 1/123 4567',
  '__uptime__ 12345.67 20000.00',
  '__mem__ MemTotal: 2000000',
  '__mem__ MemAvailable: 1500000',
  '__mem__ SwapTotal: 0',
  '__mem__ SwapFree: 0',
  '__disk__ 20000000000 15000000000',
  '__net__ lo 10 10',
  '__net__ eth0 123456 654321',
  'awgc\tnot a stats line',
]

describe('parseHostStats', () => {
  it('parses every figure', () => {
    expect(parseHostStats(SAMPLE)).toEqual({
      cpuSeconds: { user: 10, nice: 0.5, system: 3, idle: 80, iowait: 1, irq: 0, softirq: 0.2, steal: 0.3 },
      cpus: 2,
      load: [0.15, 0.1, 0.05],
      uptimeSec: 12345.67,
      memTotalBytes: 2000000 * 1024,
      memAvailableBytes: 1500000 * 1024,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
      diskTotalBytes: 20000000000,
      diskAvailableBytes: 15000000000,
      net: { lo: { rxBytes: 10, txBytes: 10 }, eth0: { rxBytes: 123456, txBytes: 654321 } },
    })
  })

  it('returns undefined without stats lines and skips garbage values', () => {
    expect(parseHostStats(['', 'awgc\tx'])).toBeUndefined()
    expect(parseHostStats(['__load__ ', '__ncpu__ 4'])).toEqual({ cpus: 4, net: {} })
  })

  it('reads this host with the real script', async () => {
    const stats = await readLocalHostStats()
    expect(stats?.cpus).toBeGreaterThan(0)
    expect(stats?.memTotalBytes).toBeGreaterThan(0)
    expect(stats?.cpuSeconds?.idle).toBeGreaterThan(0)
    expect(stats?.diskTotalBytes).toBeGreaterThan(0)
    expect(Object.keys(stats?.net ?? {})).toContain('lo')
  })
})
