import { describe, expect, it } from 'vitest'
import { localInput, remoteInput, remoteParams } from './testFixtures'
import { paramLines, renderAwgc, renderLocalAwgt, renderRemoteAwgt } from './awgConf'

describe('paramLines', () => {
  it('uses canonical AWG order, unknown keys last alphabetically', () => {
    expect(paramLines(remoteParams)).toEqual([
      'Jc = 4', 'Jmin = 10', 'Jmax = 50', 'S1 = 11', 'S2 = 12', 'H1 = 21', 'H2 = 22', 'I1 = <b 0x01>', 'Zz = x',
    ])
  })
})

describe('renderAwgc', () => {
  it('renders interface and peers sorted numerically by address', () => {
    expect(renderAwgc(localInput)).toBe(`[Interface]
PrivateKey = cPriv
Address = 10.66.0.1/16
ListenPort = 51820
Jc = 3
S1 = 5

[Peer]
PublicKey = p2
PresharedKey = k2
AllowedIPs = 10.66.0.2/32

[Peer]
PublicKey = p10
PresharedKey = k10
AllowedIPs = 10.66.0.10/32

[Peer]
PublicKey = p256
PresharedKey = k256
AllowedIPs = 10.66.1.0/32
`)
  })

  it('is independent of peer input order', () => {
    const shuffled = { ...localInput, peers: [...localInput.peers].reverse() }
    expect(renderAwgc(shuffled)).toBe(renderAwgc(localInput))
  })

  it('renders without peers', () => {
    expect(renderAwgc({ ...localInput, peers: [] })).not.toContain('[Peer]')
  })
})

describe('renderLocalAwgt', () => {
  it('renders tunnel client with REMOTE params', () => {
    expect(renderLocalAwgt(localInput)).toBe(`[Interface]
PrivateKey = tPriv
Address = 10.255.0.1/30
MTU = 1380
Table = off
FwMark = 0x51
${paramLines(remoteParams).join('\n')}
PostUp = ip route replace default dev awgt table 152
PostDown = ip route del default dev awgt table 152 || true

[Peer]
PublicKey = rPub
PresharedKey = tPsk
Endpoint = 2.2.2.20:40000
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
`)
  })
})

describe('renderRemoteAwgt', () => {
  it('renders tunnel server without Endpoint', () => {
    const out = renderRemoteAwgt(remoteInput)
    expect(out).toBe(`[Interface]
PrivateKey = rPriv
Address = 10.255.0.2/30
ListenPort = 40000
MTU = 1380
${paramLines(remoteParams).join('\n')}

[Peer]
PublicKey = tPub
PresharedKey = tPsk
AllowedIPs = 10.255.0.1/32
`)
    expect(out).not.toContain('Endpoint')
  })

  it('shares obfuscation params with the LOCAL end', () => {
    const p = (s: string) => s.split('\n').filter(l => /^(J|S|H|I)\w* = /.test(l))
    expect(p(renderRemoteAwgt(remoteInput))).toEqual(p(renderLocalAwgt(localInput)))
  })
})
