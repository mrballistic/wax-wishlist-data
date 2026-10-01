import {
  type ArtCandidate,
  formatTokens,
  MATCH,
  matchReleases,
  normalize,
  type ScoredCandidate,
} from '../art/match.js'
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

/** `""`, `null`, absent and `[]` count as empty; a non-empty value is never overwritten. */
export const isEmpty = (v: unknown): boolean =>
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

const EPS = 1e-9

const sameTokens = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((t) => b.has(t))

/**
 * Enrichment-only tie-break (the art matcher is unchanged). A release with no
 * accepted pair whose top suggestions tie at or above the accept threshold
 * takes the tied candidate whose format equals its own, when that is the only
 * tied candidate with a format at all, every other tied one has none (the
 * site left the Format line blank), and no other release took it. E.g. a
 * David Johansen LP tying between the site's LP row and a format-less row.
 */
function breakFormatTies(
  releases: Release[],
  accepted: Map<string, ScoredCandidate>,
  suggestions: Map<string, ScoredCandidate[]>,
): Map<string, ScoredCandidate> {
  const out = new Map(accepted)
  const taken = new Set([...accepted.values()].map((c) => c.key))
  for (const r of releases) {
    if (out.has(r.id)) continue
    const ranked = suggestions.get(r.id) ?? []
    const [top] = ranked
    if (!top || top.score < MATCH.accept - EPS) continue
    const tied = ranked.filter((c) => top.score - c.score <= EPS)
    // A real tie, fully visible (suggestions are capped).
    if (tied.length < 2 || tied.length >= MATCH.maxSuggestions) continue
    const own = formatTokens(r.format)
    if (own.size === 0) continue
    const withFormat = tied.filter((c) => formatTokens(c.format ?? '').size > 0)
    const [pick] = withFormat
    if (withFormat.length !== 1 || !pick) continue
    if (!sameTokens(formatTokens(pick.format ?? ''), own) || taken.has(pick.key)) continue
    out.set(r.id, pick)
    taken.add(pick.key)
  }
  return out
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
    const matched = matchReleases(releases, candidates, season)
    const accepted = breakFormatTies(releases, matched.accepted, matched.suggestions)
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
