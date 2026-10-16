import { describe, expect, it } from 'vitest'
import { latestHandshake, parseAwgDump } from './dump'

const T = '\t'
const row = (...f: (string | number)[]) => f.join(T)

// awgc with AWG 2 obfuscation columns (jc jmin jmax s1-s4 h1-h4 i1-i5 + fwmark), awgt with the
// older shorter set; peer lines are always 9 columns.
const LOCAL_DUMP = [
  row('awgc', 'cPriv=', 'cPub=', 51820, 4, 10, 50, 37, 61, 12, 8, '1-100', '200-300', '400-500', '600-700', '', '', '', '', '', 'off'),
  row('awgc', 'peer1=', 'psk1=', '1.2.3.4:5555', '10.8.0.2/32', 1700000000, 100, 200, 'off'),
  row('awgc', 'peer2=', '(none)', '(none)', '10.8.0.3/32', 0, 0, 0, 'off'),
  row('awgt', 'tPriv=', 'tPub=', 0, 4, 10, 50, 37, 61, 1, 2, 3, 4, 'off'),
  row('awgt', 'remotePub=', 'psk=', '5.6.7.8:443', '0.0.0.0/0', 1700000100, 1, 2, 25),
  '',
].join('\n')

describe('parseAwgDump', () => {
  it('parses interfaces with varying obfuscation columns and their peers', () => {
    const dump = parseAwgDump(LOCAL_DUMP)

    expect(Object.keys(dump.interfaces)).toEqual(['awgc', 'awgt'])
    expect(dump.interfaces.awgc).toMatchObject({ publicKey: 'cPub=', listenPort: 51820 })
    expect(dump.interfaces.awgc.peers).toEqual([
      { publicKey: 'peer1=', endpoint: '1.2.3.4:5555', latestHandshake: 1700000000, rxBytes: 100, txBytes: 200 },
      { publicKey: 'peer2=', endpoint: null, latestHandshake: 0, rxBytes: 0, txBytes: 0 },
    ])
    expect(dump.interfaces.awgt.listenPort).toBe(0)
    expect(dump.interfaces.awgt.peers).toHaveLength(1)
  })

  it('handles interfaces without peers, CRLF and empty input', () => {
    expect(parseAwgDump('')).toEqual({ interfaces: {} })
    const dump = parseAwgDump(row('awgt', 'p=', 'P=', 443, 'off') + '\r\n')
    expect(dump.interfaces.awgt).toEqual({ publicKey: 'P=', listenPort: 443, peers: [] })
  })

  it('skips truncated peer lines and tolerates extra peer columns', () => {
    const dump = parseAwgDump([
      row('awgt', 'p=', 'P=', 443, 'off'),
      row('awgt', 'short='),
      row('awgt', 'x=', 'psk=', '(none)', '10.0.0.0/24', 42, 0, 0, 'off', 'extra'),
    ].join('\n'))
    expect(dump.interfaces.awgt.peers).toEqual([{ publicKey: 'x=', endpoint: null, latestHandshake: 42, rxBytes: 0, txBytes: 0 }])
  })

  it('latestHandshake picks the newest peer, 0 when absent', () => {
    const dump = parseAwgDump(LOCAL_DUMP)
    expect(latestHandshake(dump, 'awgc')).toBe(1700000000)
    expect(latestHandshake(dump, 'awgt')).toBe(1700000100)
    expect(latestHandshake(dump, 'nope')).toBe(0)
  })
})
