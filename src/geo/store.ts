import { now, type Db } from '../db'

export interface GeoSet {
  cidrs: string[]
  fetchedAt: string
  count: number
}

interface GeoRow {
  cidrs: string
  count: number
  fetched_at: string
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function getGeoSet(db: Db, country: string): GeoSet | null {
  const row = db.prepare('SELECT cidrs, count, fetched_at FROM geo_sets WHERE country = ?')
    .get(country.toUpperCase()) as GeoRow | undefined
  if(!row) return null
  return { cidrs: JSON.parse(row.cidrs) as string[], count: row.count, fetchedAt: row.fetched_at }
}

// R-L7: an empty or suspiciously small download (< 50% of the previous set) keeps the old set.
export function updateGeoSet(db: Db, country: string, cidrs: string[], source: string): { updated: boolean, reason?: string } {
  const cc = country.toUpperCase()
  if(cidrs.length === 0) return { updated: false, reason: 'empty set' }

  const prev = getGeoSet(db, cc)
  if(prev && cidrs.length < prev.count * 0.5) {
    return { updated: false, reason: `new set too small: ${cidrs.length} < 50% of ${prev.count}` }
  }

  db.prepare(`
    INSERT INTO geo_sets (country, cidrs, count, source, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(country) DO UPDATE SET
      cidrs = excluded.cidrs, count = excluded.count, source = excluded.source, fetched_at = excluded.fetched_at
  `).run(cc, JSON.stringify(cidrs), cidrs.length, source, now())
  return { updated: true }
}

export function isGeoSetStale(db: Db, country: string, maxAgeMs = WEEK_MS, at: Date = new Date()): boolean {
  const set = getGeoSet(db, country)
  if(!set) return true
  return at.getTime() - Date.parse(set.fetchedAt) > maxAgeMs
}
