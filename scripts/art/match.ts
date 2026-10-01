import type { RawRelease } from '../types.js'

export type CandidateSource = 'rsd-site' | 'rsd-bucket'

/** An image that might be a release's art. Site entries have artist/title; bucket files only a name. */
export interface ArtCandidate {
  source: CandidateSource
  /** Stable identity: the bucket key, or `photo:<id>` for site images. */
  key: string
  imageUrl: string
  thumbUrl: string
  /** Text the match was made on (filename, or "Artist – Title"). */
  label: string
  artist?: string
  title?: string
  photoId?: number
  /** Site entries: the listing's format cell, e.g. "2 x LP". */
  format?: string
}

export interface ScoredCandidate extends ArtCandidate {
  score: number
}

export interface MatchResult {
  accepted: Map<string, ScoredCandidate>
  suggestions: Map<string, ScoredCandidate[]>
}

/** Thresholds from the design spec; change them there first. */
export const MATCH = {
  accept: 0.85,
  margin: 0.15,
  suggest: 0.5,
  artistOnlyUnique: 0.9,
  artistOnlyShared: 0.6,
  partialArtist: 0.5,
  titlePartialCap: 0.8,
  maxSuggestions: 3,
  photoIdMinMatches: 10,
  photoIdMaxDistance: 20_000,
} as const

const EPS = 1e-9

const STOPWORDS = new Set(
  'the a an of and in on at to for with feat featuring live edition deluxe anniversary remastered vinyl lp ep cd picture disc sticker packshot art artwork 1lp 2lp'.split(
    ' ',
  ),
)
const NOISE = /\b(copy|cover|front|final|us only|rsd(?:\s?\d{2,4})?|without|with sticker)\b/g

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.(jpe?g|png|webp|tiff?)$/i, '')
    .replace(/&/g, ' and ')
    .replace(/[_\-–—/]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\b\d{8,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokens(s: string): Set<string> {
  return new Set(
    normalize(s)
      .split(' ')
      // Single letters are noise; single digits ("Vol. 1" vs "Vol. 2") are not.
      .filter((t) => (t.length > 1 || /^\d$/.test(t)) && !STOPWORDS.has(t) && !/^\d+(st|nd|rd|th)$/.test(t)),
  )
}

const shared = (a: Set<string>, b: Set<string>): number => {
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n
}
const subset = (a: Set<string>, b: Set<string>): boolean => a.size > 0 && shared(a, b) === a.size
const artistKey = (artist: string): string => [...tokens(artist)].sort().join(' ')
/**
 * Format words, keeping lp/cd/ep/vinyl (which `tokens()` drops as stopwords) but
 * not quantity: "2 x LP" vs "2 x CD" must differ, "2 x LP" vs "LP" must not.
 */
const formatTokens = (format: string): Set<string> =>
  new Set(
    normalize(format)
      .split(' ')
      .filter((t) => t !== '' && t !== 'x' && !/^\d+$/.test(t)),
  )

/** Score one candidate for one release. `artistReleaseCount` = releases in the season by this artist. */
export function scoreCandidate(release: RawRelease, candidate: ArtCandidate, artistReleaseCount: number): number {
  const rArtist = tokens(release.artist)
  const rTitle = tokens(release.title)
  if (rTitle.size === 0) return 0

  if (candidate.artist !== undefined && candidate.title !== undefined) {
    const cArtist = tokens(candidate.artist)
    const a = rArtist.size ? shared(cArtist, rArtist) / Math.max(cArtist.size, rArtist.size) : 0
    const t = shared(tokens(candidate.title), rTitle) / rTitle.size
    const text = 0.4 * a + 0.6 * t
    // Same title in several formats (2 x LP vs CD): let the format pick the photo.
    const cFormat = formatTokens(candidate.format ?? '')
    const rFormat = formatTokens(release.format)
    if (cFormat.size === 0 || rFormat.size === 0) return text
    return 0.85 * text + 0.15 * (shared(cFormat, rFormat) / Math.max(cFormat.size, rFormat.size))
  }

  const f = tokens(candidate.label)
  if (f.size === 0) return 0
  const artistHit = shared(f, rArtist)
  const titleHit = shared(f, rTitle)
  const halfArtist = Math.ceil(rArtist.size / 2)

  // 1. Artist + title.
  if (rArtist.size && artistHit >= halfArtist && titleHit >= 1) {
    return 0.4 * (artistHit / rArtist.size) + 0.6 * (titleHit / rTitle.size)
  }
  // 2. Artist only, covering at least half the artist: trusted only when unambiguous.
  if (subset(f, rArtist) && f.size >= halfArtist) {
    return artistReleaseCount === 1 && f.size === rArtist.size ? MATCH.artistOnlyUnique : MATCH.artistOnlyShared
  }
  // 4. Partial artist (e.g. "gilmour.jpg"): a suggestion at most.
  if (subset(f, rArtist)) return MATCH.partialArtist
  // 3. Title only: must cover every title token to be acceptable.
  if (artistHit === 0 && titleHit >= 1) {
    const score = titleHit / rTitle.size
    const leftover = [...f].filter((t) => !rArtist.has(t) && !rTitle.has(t))
    return titleHit === rTitle.size && leftover.length === 0 ? score : Math.min(score, MATCH.titlePartialCap)
  }
  return 0
}

/** Same file in two folders, or the same site photo, counts once. */
const imageKey = (c: ArtCandidate): string =>
  c.photoId !== undefined ? `photo:${c.photoId}` : [...tokens(c.label)].sort().join(' ')

const titleKey = (title: string): string => [...tokens(title)].sort().join(' ')

/**
 * Two releases are format variants of one title (e.g. `x` and `x-2`, LP and CD)
 * only when their ids differ solely by a trailing -2..-9 suffix and their titles
 * normalize identically. "…-vol-1" and "…-vol-2" are different releases.
 */
const variantKey = (r: Pick<RawRelease, 'id' | 'title'>): string =>
  `${r.id.replace(/-[2-9]$/, '')}|${titleKey(r.title)}`

/**
 * Site rows identical in artist, title and format are colour variants of one
 * release; keep the lowest photo id so they don't fail each other's margin.
 */
function collapseSiteVariants(candidates: ArtCandidate[]): ArtCandidate[] {
  const best = new Map<string, ArtCandidate>()
  const out: ArtCandidate[] = []
  for (const c of candidates) {
    if (c.artist === undefined || c.title === undefined || c.photoId === undefined) {
      out.push(c)
      continue
    }
    const k = [normalize(c.artist), normalize(c.title), normalize(c.format ?? '')].join('|')
    const prev = best.get(k)
    if (!prev || (prev.photoId ?? Infinity) > c.photoId) best.set(k, c)
  }
  return [...out, ...best.values()]
}

function demote(result: MatchResult, releaseId: string): void {
  const c = result.accepted.get(releaseId)
  if (!c) return
  result.accepted.delete(releaseId)
  result.suggestions.set(releaseId, [c, ...(result.suggestions.get(releaseId) ?? [])].slice(0, MATCH.maxSuggestions))
}

/**
 * Match `releases` (those still missing art) against `candidates`. `season`
 * is the season's full release list, used to count releases per artist.
 */
export function matchReleases(releases: RawRelease[], candidates: ArtCandidate[], season: RawRelease[]): MatchResult {
  const artistCounts = new Map<string, number>()
  for (const r of season) artistCounts.set(artistKey(r.artist), (artistCounts.get(artistKey(r.artist)) ?? 0) + 1)

  const seen = new Set<string>()
  const unique = collapseSiteVariants(candidates).filter((c) => {
    const k = imageKey(c)
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })

  const result: MatchResult = { accepted: new Map(), suggestions: new Map() }
  for (const r of releases) {
    const count = artistCounts.get(artistKey(r.artist)) ?? 1
    const ranked = unique
      .map((c) => ({ ...c, score: scoreCandidate(r, c, count) }))
      .filter((c) => c.score >= MATCH.suggest - EPS)
      .sort((a, b) => b.score - a.score)
    const [best, second] = ranked
    if (best && best.score >= MATCH.accept - EPS && best.score - (second?.score ?? 0) >= MATCH.margin - EPS) {
      result.accepted.set(r.id, best)
    } else if (ranked.length > 0) {
      result.suggestions.set(r.id, ranked.slice(0, MATCH.maxSuggestions))
    }
  }

  const byId = new Map<string, RawRelease>()
  for (const r of [...season, ...releases]) byId.set(r.id, r)
  const variantOf = (id: string): string => {
    const r = byId.get(id)
    return r ? variantKey(r) : id
  }

  // An image that fits another release in the season at least as well belongs to that one.
  for (const [id, c] of [...result.accepted]) {
    const owned = season.some(
      (o) =>
        variantKey(o) !== variantOf(id) &&
        scoreCandidate(o, c, artistCounts.get(artistKey(o.artist)) ?? 1) >= c.score - EPS,
    )
    if (owned) demote(result, id)
  }

  // One image, one release (except -2..-9 format variants of one title).
  const byImage = new Map<string, string[]>()
  for (const [id, c] of result.accepted) byImage.set(imageKey(c), [...(byImage.get(imageKey(c)) ?? []), id])
  for (const ids of byImage.values()) {
    if (new Set(ids.map(variantOf)).size > 1) for (const id of ids) demote(result, id)
  }

  // Site photo ids come in season-sized upload batches; an outlier is suspect.
  const photoIds = [...result.accepted.values()].flatMap((c) => (c.photoId !== undefined ? [c.photoId] : []))
  if (photoIds.length >= MATCH.photoIdMinMatches) {
    const sorted = [...photoIds].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    for (const [id, c] of [...result.accepted]) {
      if (c.photoId !== undefined && Math.abs(c.photoId - median) > MATCH.photoIdMaxDistance) demote(result, id)
    }
  }
  return result
}
