import { normalize } from '../art/match.js'
import type { ExtractedRow } from '../extract/types.js'
import type { RawRelease } from '../types.js'

import type { SiteEntry } from './site-index.js'

/**
 * Row repair at ingest, before ids are assigned: recover rows the parser
 * dropped and fill blank label/format cells from recordstoreday.com. Exact
 * normalized matches only (the art matcher's `normalize`); anything ambiguous
 * is left alone. The PDF stays the source of truth for which releases exist:
 * repair never adds a row the PDF doesn't have.
 */

const key = (artist: string, title: string): string =>
  `${normalize(artist)}\u0000${normalize(title)}`

const complete = (r: ExtractedRow): boolean => Boolean(r.artist && r.title && r.label && r.format)

/** The single non-empty value all `values` agree on, or null. */
function agreed(values: string[]): string | null {
  const distinct = new Set(values.map((v) => v.trim()))
  if (distinct.size !== 1) return null
  const [only = ''] = distinct
  return only || null
}

export function repairRows(
  rows: ExtractedRow[],
  partial: ExtractedRow[],
  entries: SiteEntry[],
  log?: (line: string) => void,
): { rows: ExtractedRow[]; repaired: number } {
  // Site entries grouped by release: same normalized artist + title.
  const groups = new Map<string, SiteEntry[]>()
  // Normalized "artist title" → the release keys it could be.
  const fused = new Map<string, Set<string>>()
  for (const e of entries) {
    const k = key(e.artist, e.title)
    groups.set(k, [...(groups.get(k) ?? []), e])
    const f = normalize(`${e.artist} ${e.title}`)
    fused.set(f, (fused.get(f) ?? new Set()).add(k))
  }

  let filled = 0
  const fill = (r: ExtractedRow): ExtractedRow => {
    if (r.label && r.format) return r
    const group = groups.get(key(r.artist, r.title))
    if (!group) return r
    const out = { ...r }
    if (!out.label) {
      // Several site entries for one release (e.g. LP and SACD): take the
      // label they all share, or the one whose format matches the row's.
      const sameFormat = out.format
        ? group.filter((e) => normalize(e.format) === normalize(out.format))
        : []
      const label =
        agreed(group.map((e) => e.label)) ??
        (sameFormat.length > 0 ? agreed(sameFormat.map((e) => e.label)) : null)
      if (label) {
        out.label = label
        filled++
      }
    }
    if (!out.format) {
      const format = agreed(group.map((e) => e.format))
      if (format) {
        out.format = format
        filled++
      }
    }
    return out
  }

  const split = (r: ExtractedRow): ExtractedRow => {
    if (r.title || !r.artist) return r
    const candidates = fused.get(normalize(r.artist))
    if (candidates?.size !== 1) return r
    const [k = ''] = candidates
    const e = groups.get(k)?.[0]
    return e ? { ...r, artist: e.artist, title: e.title } : r
  }

  const recovered = partial.map((r) => fill(split(r))).filter(complete)
  const out = [...rows.map(fill), ...recovered]
  log?.(`repair: recovered ${recovered.length} rows, filled ${filled} fields`)
  return { rows: out, repaired: recovered.length }
}

/**
 * Repair entries from the season's previously published list, for a revision
 * when recordstoreday.com is unavailable: rows recovered before (fused or
 * blank-celled again in the new PDF) are recovered the same way. Only artist,
 * title, label and format carry over; the site-only fields stay empty.
 */
export function entriesFromReleases(releases: RawRelease[]): SiteEntry[] {
  return releases.map((r) => ({
    releaseId: r.id,
    artist: r.artist,
    title: r.title,
    photoId: 0,
    format: r.format,
    label: r.label,
    description: '',
    tracklist: [],
    quantity: null,
    upc: null,
    pageUrl: '',
  }))
}

/**
 * The entries to repair against: the site index when there is one, else the
 * previously published list on a revision, else none (repair is skipped).
 */
export function repairEntries(
  index: { entries: SiteEntry[] } | null,
  previousSameSeason: RawRelease[] | null,
): SiteEntry[] | null {
  if (index) return index.entries
  return previousSameSeason ? entriesFromReleases(previousSameSeason) : null
}
