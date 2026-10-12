import crypto from 'crypto'
import { Db, now } from '../db'

export type HostKeyVerdict = 'trusted' | 'pinned-new' | 'mismatch'

interface KnownHostRow {
  address: string
  host_key: string | null
  first_seen_at: string
  mismatch_key: string | null
}

// OpenSSH-style fingerprint so alerts can be compared with `ssh-keygen -lf` output.
export function hostKeyFingerprint(rawKey: Buffer): string {
  const digest = crypto.createHash('sha256').update(rawKey).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

// TOFU per address (R-P6): a new address is pinned silently (that is how a server gets
// replaced), a changed key on a known address is refused until /trust clears the pin.
export function checkHostKey(db: Db, address: string, keyFingerprint: string): HostKeyVerdict {
  const row = db.prepare('SELECT * FROM known_hosts WHERE address = ?').get(address) as KnownHostRow | undefined

  if(!row) {
    db.prepare('INSERT INTO known_hosts (address, host_key, first_seen_at) VALUES (?, ?, ?)')
      .run(address, keyFingerprint, now())
    return 'pinned-new'
  }

  if(row.host_key === null) {
    db.prepare('UPDATE known_hosts SET host_key = ?, first_seen_at = ?, mismatch_key = NULL WHERE address = ?')
      .run(keyFingerprint, now(), address)
    return 'pinned-new'
  }

  if(row.host_key === keyFingerprint) {
    return 'trusted'
  }

  db.prepare('UPDATE known_hosts SET mismatch_key = ? WHERE address = ?').run(keyFingerprint, address)
  return 'mismatch'
}

export function getKnownHost(db: Db, address: string): KnownHostRow | undefined {
  return db.prepare('SELECT * FROM known_hosts WHERE address = ?').get(address) as KnownHostRow | undefined
}

// /trust <node>: forget the pinned key so the next connection pins whatever it sees.
export function trustAddress(db: Db, address: string) {
  db.prepare('UPDATE known_hosts SET host_key = NULL, mismatch_key = NULL WHERE address = ?').run(address)
}
