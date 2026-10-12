import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localInput } from './testFixtures'
import { renderRoutingScript, renderRoutingUnit, renderSysctl } from './system'

describe('renderSysctl', () => {
  it('enables forwarding, loose rp_filter, no ipv6 forwarding', () => {
    const s = renderSysctl()
    expect(s).toContain('net.ipv4.ip_forward = 1')
    expect(s).toContain('net.ipv4.conf.all.rp_filter = 2')
    expect(s).toContain('net.ipv4.conf.default.rp_filter = 2')
    expect(s).toContain('net.ipv6.conf.all.forwarding = 0')
  })
})

describe('renderRoutingScript', () => {
  const s = renderRoutingScript(localInput)

  it('is a strict bash script', () => {
    expect(s.startsWith('#!/bin/bash\n')).toBe(true)
    expect(s).toContain('set -euo pipefail')
    expect(() => execFileSync('bash', ['-n'], { input: s })).not.toThrow()
  })

  it('adds fwmark rules only if missing', () => {
    expect(s).toContain('add_rule 0x51 151')
    expect(s).toContain('add_rule 0x52 152')
    expect(s).toMatch(/if ! ip -4 rule show \| grep -qE .*\n\s+ip -4 rule add fwmark "\$mark" lookup "\$table"/)
  })

  it('routes tunnel packets from LOCAL.tunnel via the main default gateway', () => {
    expect(s).toContain(`TUNNEL_SRC='1.1.1.12'`)
    expect(s).toContain('ip -4 route show default')
    expect(s).toContain('ip -4 route replace default via "$GW" dev "$DEV" $ONLINK src "$TUNNEL_SRC" table 151')
  })

  it('keeps the onlink flag of the main default route', () => {
    expect(s).toContain(`ONLINK='onlink'`)
    expect(s).toContain('if($i=="onlink")')
  })

  // Runs the real script against a stubbed `ip` that logs its argv.
  function runWithDefault(defLine: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'routing-test-'))
    try {
      const log = join(dir, 'ip.log')
      writeFileSync(join(dir, 'ip'), `#!/bin/bash
echo "$*" >> '${log}'
if [ "$*" = '-4 route show default' ]; then echo '${defLine}'; fi
exit 0
`)
      chmodSync(join(dir, 'ip'), 0o755)
      const script = join(dir, 'routing.sh')
      writeFileSync(script, s)
      execFileSync('bash', [script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
      return readFileSync(log, 'utf8').trim().split('\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('passes onlink through to table 151 when the default route has it', () => {
    const calls = runWithDefault('default via 10.0.0.1 dev eth0 onlink')
    expect(calls).toContain('-4 route replace default via 10.0.0.1 dev eth0 onlink src 1.1.1.12 table 151')
    expect(calls).toContain('-4 rule add fwmark 0x51 lookup 151')
  })

  it('omits onlink when the default route lacks it', () => {
    const calls = runWithDefault('default via 10.0.0.1 dev eth0 proto dhcp metric 100')
    expect(calls).toContain('-4 route replace default via 10.0.0.1 dev eth0 src 1.1.1.12 table 151')
  })

  it('fails closed in table 152', () => {
    expect(s).toContain('ip -4 route replace unreachable default metric 4278198272 table 152')
  })
})

describe('renderRoutingUnit', () => {
  it('is a oneshot ordered before awg-quick@awgt', () => {
    const u = renderRoutingUnit()
    for(const line of [
      'Type=oneshot', 'RemainAfterExit=yes', 'After=network-online.target', 'Wants=network-online.target',
      'Before=awg-quick@awgt.service', 'WantedBy=multi-user.target', 'ExecStart=/etc/vpn-node/routing.sh',
    ]) expect(u).toContain(line)
  })
})
