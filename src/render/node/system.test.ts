import { execFileSync } from 'node:child_process'
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
    expect(s).toContain('ip -4 route replace default via "$GW" dev "$DEV" src "$TUNNEL_SRC" table 151')
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
