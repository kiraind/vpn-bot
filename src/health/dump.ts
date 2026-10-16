// Parser for `awg show all dump` (tab-separated, one line per interface followed by its peers).
//
// Interface line: iface, private-key, public-key, listen-port, [AWG obfuscation columns...], fwmark
// Peer line:      iface, public-key, preshared-key, endpoint, allowed-ips, latest-handshake,
//                 rx-bytes, tx-bytes, persistent-keepalive
//
// amneziawg-tools inserts a version-dependent number of obfuscation columns (jc, jmin, s1.., h1..,
// i1..) into the interface line, so its width is not fixed. We key off ordering instead: the tool
// always prints an interface line before that interface's peers, so the first line for a new
// interface name is the interface line and every later line with that name is a peer.

export interface DumpPeer {
  publicKey: string
  endpoint: string | null
  /** Unix seconds; 0 = never. */
  latestHandshake: number
  /** Bytes received from / sent to this peer since the interface came up (counters reset with it). */
  rxBytes: number
  txBytes: number
}

export interface DumpInterface {
  publicKey: string
  listenPort: number
  peers: DumpPeer[]
}

export interface ParsedDump {
  interfaces: Record<string, DumpInterface>
}

const PEER_FIELDS = 9

function intOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10)

  return Number.isFinite(n) ? n : fallback
}

export function parseAwgDump(text: string): ParsedDump {
  const interfaces: Record<string, DumpInterface> = {}

  for(const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')

    if(line.trim() === '') {
      continue
    }

    const fields = line.split('\t')
    const name = fields[0]
    const iface = interfaces[name]

    if(!iface) {
      interfaces[name] = {
        publicKey: fields[2] ?? '',
        listenPort: intOr(fields[3], 0),
        peers: [],
      }
      continue
    }

    // Tolerate future extra trailing peer columns, but skip truncated/garbage lines.
    if(fields.length < PEER_FIELDS) {
      continue
    }

    const endpoint = fields[3]
    iface.peers.push({
      publicKey: fields[1],
      endpoint: endpoint && endpoint !== '(none)' ? endpoint : null,
      latestHandshake: intOr(fields[5], 0),
      rxBytes: intOr(fields[6], 0),
      txBytes: intOr(fields[7], 0),
    })
  }

  return { interfaces }
}

/** Most recent handshake of any peer on `iface` (unix s), 0 if none or the interface is absent. */
export function latestHandshake(dump: ParsedDump, iface: string): number {
  const peers = dump.interfaces[iface]?.peers ?? []

  return peers.reduce((max, peer) => Math.max(max, peer.latestHandshake), 0)
}
