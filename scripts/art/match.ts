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
      .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+(st|nd|rd|th)$/.test(t)),
  )
}

const shared = (a: Set<string>, b: Set<string>): number => {
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n
}
const subset = (a: Set<string>, b: Set<string>): boolean => a.size > 0 && shared(a, b) === a.size
const artistKey = (artist: string): string => [...tokens(artist)].sort().join(' ')

/** Score one candidate for one release. `artistReleaseCount` = releases in the season by this artist. */
export function scoreCandidate(release: RawRelease, candidate: ArtCandidate, artistReleaseCount: number): number {
  const rArtist = tokens(release.artist)
  const rTitle = tokens(release.title)
  if (rTitle.size === 0) return 0

  if (candidate.artist !== undefined && candidate.title !== undefined) {
    const a = rArtist.size ? shared(tokens(candidate.artist), rArtist) / rArtist.size : 0
    const t = shared(tokens(candidate.title), rTitle) / rTitle.size
    return 0.4 * a + 0.6 * t
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
    return artistReleaseCount === 1 ? MATCH.artistOnlyUnique : MATCH.artistOnlyShared
  }
  // 4. Partial artist (e.g. "gilmour.jpg"): a suggestion at most.
  if (subset(f, rArtist)) return MATCH.partialArtist
  // 3. Title only: must cover every title token to be acceptable.
  if (artistHit === 0 && titleHit >= 1) {
    const score = titleHit / rTitle.size
    return titleHit === rTitle.size ? score : Math.min(score, MATCH.titlePartialCap)
  }
  return 0
}

/** Same file in two folders, or the same site photo, counts once. */
const imageKey = (c: ArtCandidate): string =>
  c.photoId !== undefined ? `photo:${c.photoId}` : [...tokens(c.label)].sort().join(' ')

/** Ids that differ only by a -2/-3 suffix are one title in two formats. */
const baseId = (id: string): string => id.replace(/-\d+$/, '')

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
  const unique = candidates.filter((c) => {
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

  // One image, one release (except -2/-3 format variants of one title).
  const byImage = new Map<string, string[]>()
  for (const [id, c] of result.accepted) byImage.set(imageKey(c), [...(byImage.get(imageKey(c)) ?? []), id])
  for (const ids of byImage.values()) {
    if (new Set(ids.map(baseId)).size > 1) for (const id of ids) demote(result, id)
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
