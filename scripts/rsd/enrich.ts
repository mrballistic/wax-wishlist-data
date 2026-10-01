import { type ArtCandidate, matchReleases, normalize } from '../art/match.js'
import type { RawRelease, Release } from '../types.js'

import type { SiteEntry, SiteIndex } from './site-index.js'

/**
 * Fill empty release fields (description, tracklist, quantity, UPC, RSD link)
 * from recordstoreday.com's listing. Only the art matcher's accepted pairs are
 * used ("never guess"), and a non-empty value is never overwritten.
 *
 * Candidates are keyed by the site's release id, not its photo id: two
 * different releases can share a placeholder photo, and the matcher dedupes by
 * photo id. Site rows identical in artist, title and format (colour variants)
 * are collapsed here to the lowest release id so they don't fail each other's
 * margin; the label carries that id so the matcher's text dedupe never merges
 * an LP row into a CD row of the same title.
 */

const UPC = /^\d{8,14}$/

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

function siteCandidates(entries: SiteEntry[]): {
  candidates: ArtCandidate[]
  byKey: Map<string, SiteEntry>
} {
  const best = new Map<string, SiteEntry>()
  for (const e of entries) {
    const k = [normalize(e.artist), normalize(e.title), normalize(e.format)].join('|')
    const prev = best.get(k)
    if (!prev || Number(prev.releaseId) > Number(e.releaseId)) best.set(k, e)
  }
  const byKey = new Map<string, SiteEntry>()
  const candidates: ArtCandidate[] = [...best.values()].map((e) => {
    const key = `release:${e.releaseId}`
    byKey.set(key, e)
    return {
      source: 'rsd-site',
      key,
      // Unused for text enrichment; the matcher's type wants them.
      imageUrl: e.pageUrl,
      thumbUrl: e.pageUrl,
      label: `${e.artist} – ${e.title} – ${e.format} – ${e.releaseId}`,
      artist: e.artist,
      title: e.title,
      photoId: undefined,
      format: e.format,
    }
  })
  return { candidates, byKey }
}

/** The fields this entry can fill on this release; empty when it fills none. */
function fill(release: Release, e: SiteEntry): Partial<Release> {
  const out: Partial<Release> = {}
  const description = typeof e.description === 'string' ? e.description.trim() : ''
  if (isEmpty(release.description) && description !== '') out.description = description
  const tracklist = Array.isArray(e.tracklist)
    ? e.tracklist
        .filter((l): l is string => typeof l === 'string')
        .map((l) => l.trim())
        .filter((l) => l !== '')
    : []
  if (isEmpty(release.tracklist) && tracklist.length > 0) out.tracklist = tracklist
  if (isEmpty(release.quantity) && Number.isInteger(e.quantity) && (e.quantity ?? 0) > 0)
    out.quantity = e.quantity
  if (isEmpty(release.upc) && typeof e.upc === 'string' && UPC.test(e.upc)) out.upc = e.upc
  if (isEmpty(release.rsdUrl) && typeof e.pageUrl === 'string' && URL.canParse(e.pageUrl))
    out.rsdUrl = e.pageUrl
  return out
}

export function enrichFromSite(
  releases: Release[],
  index: SiteIndex,
  season: RawRelease[],
): { releases: Release[]; changed: number } {
  try {
    const { candidates, byKey } = siteCandidates(index.entries)
    const { accepted } = matchReleases(releases, candidates, season)
    let changed = 0
    const out = releases.map((r) => {
      const c = accepted.get(r.id)
      const e = c ? byKey.get(c.key) : undefined
      if (!e) return r
      const filled = fill(r, e)
      if (Object.keys(filled).length === 0) return r
      changed += 1
      return { ...r, ...filled }
    })
    return { releases: out, changed }
  } catch {
    return { releases, changed: 0 }
  }
}
