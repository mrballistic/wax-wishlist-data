# Art Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Near-full album art within a day of an RSD list drop by adding two official RSD art tiers (recordstoreday.com product images via Bright Data, and distributor art packs in RSD's S3 bucket), a shared careful matcher, a per-season suggestions file, a daily art refresh, and one-click batch acceptance in art-admin.

**Architecture:** `scripts/art/` holds a pure matcher (`match.ts`), image normalization, the Bright Data Unlocker client, and two "indexed" sources that match a whole season at once (`rsd-bucket.ts`, `rsd-site.ts`). `runArtCascade` gains a pre-pass that prepares indexed sources for the releases still missing art, then tries tiers in order: manual → existing file → rsd-site → rsd-bucket → discogs → musicbrainz. Unmatched releases with near-misses are written to `releases/<season>/art-candidates.json`, which art-admin reads to offer one-click Accept with a single batched commit.

**Tech Stack:** TypeScript (ESM, Node 24, tsx), Zod 3.23.8, sharp, Vitest 2 + msw 2, GitHub Actions; art-admin: Next.js 16, React 19, @octokit/rest, sharp, vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-art-coverage-design.md`

## Global Constraints

- App contract frozen: no change to `scripts/types.ts` schemas (`ReleaseSchema` etc.), `artFilename` always `<id>.jpg`; apps read only `releases.json` and `art/`. (`ArtTier`/`ArtSource` in types.ts are internal and may change.)
- Never overwrite an existing art file; manual art always wins (existing cascade rules).
- Never guess: below the acceptance bar a candidate is a suggestion, never a published image.
- Matcher constants (spec): accept ≥ 0.85, margin ≥ 0.15 over the next distinct candidate, suggest ≥ 0.5, artist-only unique 0.9 / shared 0.6, partial artist 0.5, title-only must cover every title token (else capped at 0.8), photo-id check after ≥ 10 accepted site matches with max distance 20,000 from the median, top 3 suggestions.
- New-tier images normalized with sharp to JPEG ≤ 800×800, never upscaled, EXIF rotate, mozjpeg quality 85.
- Bright Data: `POST https://api.brightdata.com/request`, `Authorization: Bearer <BRIGHT_DATA_KEY>`, body `{ zone, url, format: 'raw' }`, 60 s timeout, ≤ 400 requests per run; missing key/zone disables the `rsd-site` tier. Broadtime images (`https://img.broadtime.com/Photo/<id>:800`) are fetched directly, never via Bright Data.
- Bucket images: `.jpg .jpeg .png .webp .tif .tiff` under `<year>/`, excluding paths containing `/logos/` (case-insensitive), `__MACOSX/`, `.DS_Store`; skip images over 25 MB.
- Art never blocks a publish; every new-tier failure is logged and leaves the slot for later.
- Tests: no network (msw `onUnhandledRequest: 'error'`); resolve `fetch` per call, never at factory time (msw patches fetch after module load).
- Code style: ESM `.js` import suffixes, `import/order` alphabetized with blank lines between groups, no `any`, no `!`, `consistent-type-imports`. Write Unicode ranges in regexes as `\uXXXX` escapes. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm validate` before each commit.
- Commits end with a Co-Authored-By line for the model that wrote them.
- Secrets never printed (`.env` holds `GEMINI_API_KEY`, and `BRIGHT_DATA_KEY` / `BRIGHT_DATA_ZONE` once Todd adds them).

## Review Focus

1. **The same image in two bucket folders** (`01-ALL ART COMBINED/X copy.jpg` and `Redeye Art 25/X.jpg`). Expected: counted once, so it doesn't tie with itself and block acceptance. Test: Task 1, "duplicate files count as one image".
2. **An artist with two releases in a season and an artist-only filename** (`Charles Mingus_Cover.jpg`). Expected: suggestion, never accepted. Test: Task 1 labelled fixture.
3. **One image best-matching two different releases.** Expected: neither accepted (both suggested), except `-2`/`-3` format variants of one title. Test: Task 1.
4. **A WebP from broadtime, or a PNG/TIFF from the bucket.** Expected: written as a real JPEG in `<id>.jpg`. Test: Task 2 (normalize) and Task 3 (cascade writes JPEG bytes).
5. **Bright Data unconfigured or failing mid-run.** Expected: `rsd-site` skipped or stopped with one log line; other tiers still fill slots; no exception escapes the cascade. Tests: Task 4 and Task 8.

---

### Task 1: Shared art matcher

**Files:**
- Create: `scripts/art/match.ts`
- Test: `tests/art/match.test.ts`
- Fixtures (already committed with this plan): `tests/fixtures/art/bucket-2025-keys.json` (545 real 2025 bucket keys, XML-decoded), `tests/fixtures/art/bucket-2025-labelled.json` (19 hand-checked filename↔release pairs: 13 `accept`, 2 `suggest`, 4 `notAccepted`)

**Interfaces:**
- Produces: `type CandidateSource = 'rsd-site' | 'rsd-bucket'`; `interface ArtCandidate { source; key: string; imageUrl: string; thumbUrl: string; label: string; artist?: string; title?: string; photoId?: number }`; `interface ScoredCandidate extends ArtCandidate { score: number }`; `interface MatchResult { accepted: Map<string, ScoredCandidate>; suggestions: Map<string, ScoredCandidate[]> }`; `MATCH` constants; `normalize(s)`, `tokens(s)`, `scoreCandidate(release, candidate, artistReleaseCount)`, `matchReleases(releases, candidates, season)`.

- [ ] **Step 1: Write the failing tests**

`tests/art/match.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  type ArtCandidate,
  MATCH,
  matchReleases,
  normalize,
  scoreCandidate,
  tokens,
} from '../../scripts/art/match.js'
import type { RawRelease } from '../../scripts/types.js'
import { loadRaw, makeRelease, REPO_ROOT } from '../helpers/releases.js'

const bucket = (key: string): ArtCandidate => ({
  source: 'rsd-bucket',
  key,
  imageUrl: key,
  thumbUrl: key,
  label: key.split('/').pop() ?? key,
})
const site = (artist: string, title: string, photoId: number): ArtCandidate => ({
  source: 'rsd-site',
  key: `photo:${photoId}`,
  imageUrl: `https://img.broadtime.com/Photo/${photoId}:800`,
  thumbUrl: `https://img.broadtime.com/Photo/${photoId}:360`,
  label: `${artist} – ${title}`,
  artist,
  title,
  photoId,
})
const rel = (id: string, artist: string, title: string): RawRelease => makeRelease(0, { id, artist, title })

describe('normalize / tokens', () => {
  it('strips accents, punctuation, extensions, noise words and barcodes', () => {
    expect(normalize('Françoise Hardy copy.JPG')).toBe('francoise hardy')
    expect(normalize('7 Doors Of Death (OST)_652799000213.jpg')).toBe('7 doors of death ost')
    expect(normalize('Cover Vinyl_Dada_Puzzle_With Sticker.jpg')).toBe('vinyl dada puzzle')
  })

  it('drops stopwords, ordinals and single characters', () => {
    expect([...tokens('The Sword – Warp Riders (15th Anniversary Edition) LP')]).toEqual(['sword', 'warp', 'riders'])
  })
})

describe('scoreCandidate', () => {
  const mingus = rel('m', 'Charles Mingus', 'Mingus At Monterey')
  it('scores artist + title filenames', () => {
    expect(scoreCandidate(mingus, bucket('x/Charles Mingus - Mingus at Monterey copy.jpg'), 2)).toBeCloseTo(1)
  })
  it('scores an artist-only filename by how many releases the artist has', () => {
    expect(scoreCandidate(mingus, bucket('x/Charles Mingus_Cover.jpg'), 1)).toBe(MATCH.artistOnlyUnique)
    expect(scoreCandidate(mingus, bucket('x/Charles Mingus_Cover.jpg'), 2)).toBe(MATCH.artistOnlyShared)
  })
  it('caps a partial title-only filename below acceptance', () => {
    const carla = rel('c', 'Carla Thomas', 'Sweet Sweetheart')
    expect(scoreCandidate(carla, bucket('x/Sweet copy.jpeg'), 1)).toBeLessThan(MATCH.accept)
  })
  it('scores site entries 0.4 artist + 0.6 title', () => {
    expect(scoreCandidate(mingus, site('Charles Mingus', 'Mingus At Monterey', 1), 1)).toBeCloseTo(1)
    expect(scoreCandidate(mingus, site('Someone Else', 'Mingus At Monterey', 1), 1)).toBeCloseTo(0.6)
  })
})

describe('matchReleases', () => {
  it('duplicate files count as one image', () => {
    const r = rel('bte', 'Better Than Ezra', 'How Does Your Garden Grow?')
    const res = matchReleases(
      [r],
      [bucket('a/Better Than Ezra - How Does Your Garden Grow copy.jpg'), bucket('b/Better Than Ezra - How Does Your Garden Grow.jpg')],
      [r],
    )
    expect(res.accepted.get('bte')?.key).toBe('a/Better Than Ezra - How Does Your Garden Grow copy.jpg')
  })

  it('suggests instead of accepting when two candidates are too close', () => {
    const r = rel('x', 'Band', 'Album Name')
    const res = matchReleases([r], [bucket('a/Band - Album Name.jpg'), bucket('a/Band - Album Name Live.png'), bucket('a/Band Album Name Tour.jpg')], [r])
    expect(res.accepted.has('x')).toBe(false)
    expect(res.suggestions.get('x')?.length).toBeGreaterThan(0)
  })

  it('never accepts one image for two different releases, but allows -2 format variants', () => {
    const a = rel('band-album', 'Band', 'Album')
    const b = rel('band-album-2', 'Band', 'Album')
    const c = rel('other-album', 'Other', 'Album')
    const img = site('Band', 'Album', 5)
    expect(matchReleases([a, b], [img], [a, b]).accepted.size).toBe(2)
    const conflicted = matchReleases([a, c], [site('Band Other', 'Album', 6)], [a, c])
    expect(conflicted.accepted.size).toBe(0)
  })

  it('demotes site matches whose photo id is far from the season median', () => {
    const releases = Array.from({ length: 11 }, (_, i) => rel(`r${i}`, `Artist ${i} Name`, `Title ${i} Words`))
    const cands = releases.map((r, i) => site(r.artist, r.title, i === 10 ? 999_999_999 : 418_467_310_000 + i))
    const res = matchReleases(releases, cands, releases)
    expect(res.accepted.size).toBe(10)
    expect(res.accepted.has('r10')).toBe(false)
    expect(res.suggestions.get('r10')?.[0]?.photoId).toBe(999_999_999)
  })
})

describe('matchReleases — real April 2025 bucket art', () => {
  let season: RawRelease[]
  let candidates: ArtCandidate[]
  let labelled: { kind: 'accept' | 'suggest' | 'notAccepted'; key: string; releaseId: string }[]
  beforeAll(async () => {
    season = await loadRaw('2025-april')
    const keys = JSON.parse(await readFile(join(REPO_ROOT, 'tests/fixtures/art/bucket-2025-keys.json'), 'utf8')) as string[]
    candidates = keys.filter((k) => /\.(jpe?g|png|webp|tiff?)$/i.test(k)).map(bucket)
    labelled = JSON.parse(await readFile(join(REPO_ROOT, 'tests/fixtures/art/bucket-2025-labelled.json'), 'utf8'))
  })

  it('agrees with every hand-checked label', () => {
    const res = matchReleases(season, candidates, season)
    const sameImage = (a: string, b: string) => normalize(a.split('/').pop() ?? '') === normalize(b.split('/').pop() ?? '')
    for (const l of labelled) {
      const acc = res.accepted.get(l.releaseId)
      if (l.kind === 'accept') expect(acc && sameImage(acc.key, l.key), `${l.releaseId} should accept ${l.key}`).toBe(true)
      if (l.kind === 'suggest') {
        expect(acc, `${l.releaseId} must not be accepted`).toBeUndefined()
        expect(res.suggestions.get(l.releaseId)?.length ?? 0).toBeGreaterThan(0)
      }
      if (l.kind === 'notAccepted') expect(acc && sameImage(acc.key, l.key)).toBeFalsy()
    }
  })

  it('accepts a substantial share of the season (measured 154/309 on 2026-10-01)', () => {
    const res = matchReleases(season, candidates, season)
    expect(res.accepted.size).toBeGreaterThanOrEqual(140)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/art/match.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `scripts/art/match.ts`**

This code was prototyped and checked against the labelled fixture on 2026-10-01 (0 label disagreements after correcting one label; 154 accepted / 78 suggested of 309; a manual review of half the accepted pairs found no wrong matches).

```ts
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
    .replace(/[̀-ͯ]/g, '')
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
```

- [ ] **Step 4: Run tests** — `pnpm vitest run tests/art/match.test.ts` → PASS. If a normalize expectation in Step 1 is off by a word because of the noise list, fix the test expectation only when the new value is still correct; never loosen the labelled-fixture test.

- [ ] **Step 5: Checks and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add scripts/art/match.ts tests/art/match.test.ts tests/fixtures/art
git commit -m "feat(art): shared matcher for RSD art candidates"
```

---

### Task 2: Image normalization and the `rsd-bucket` source

**Files:**
- Create: `scripts/art/normalize.ts`, `scripts/art/indexed-source.ts`, `scripts/art/rsd-bucket.ts`
- Modify: `scripts/watch/bucket.ts` (generalize listing)
- Test: `tests/art/normalize.test.ts`, `tests/art/rsd-bucket.test.ts`, `tests/watch/bucket.test.ts` (keep passing)

**Interfaces:**
- Consumes: `matchReleases`, `ArtCandidate`, `ScoredCandidate` (Task 1); `BucketObject`, `parseListing`, `BucketError`, `objectUrl`, `BUCKET_URL` (`scripts/watch/bucket.ts`).
- Produces:
  - `normalize.ts`: `ART_MAX_DIMENSION = 800`, `ART_JPEG_QUALITY = 85`, `normalizeArtImage(input: Buffer): Promise<Buffer>` (JPEG bytes).
  - `bucket.ts`: `listKeys(prefix: string, keep: (key: string) => boolean, fetchImpl?: typeof fetch): Promise<BucketObject[]>`; `listPdfs` re-implemented as `listKeys(prefix, isPdf, fetchImpl)` with unchanged behaviour.
  - `indexed-source.ts`: `interface IndexedArtSource { name: 'rsd-site' | 'rsd-bucket'; prepare(missing: RawRelease[], season: RawRelease[]): Promise<void>; accepted(releaseId: string): ScoredCandidate | null; suggestions(releaseId: string): ScoredCandidate[] }` — `prepare` never throws (logs and leaves the source empty).
  - `rsd-bucket.ts`: `isArtImageKey(key: string): boolean`, `MAX_BUCKET_IMAGE_BYTES = 25 * 1024 * 1024`, `createRsdBucketSource(opts: { year: string; list?: (prefix: string) => Promise<BucketObject[]>; log?: (line: string) => void }): IndexedArtSource`.

- [ ] **Step 1: Failing tests**

`tests/art/normalize.test.ts`: build a 1600×1200 WebP and a 300×300 PNG with `sharp({ create: … })`; assert `normalizeArtImage` returns JPEG bytes (first bytes `0xff 0xd8`), the WebP becomes 800×600 (aspect kept, longest side 800), the PNG stays 300×300 (never upscaled); and a buffer of garbage rejects.

`tests/art/rsd-bucket.test.ts`:
- `isArtImageKey`: true for `2025/Artwork RSD 2025/UMG - RSD 2025/x.JPG`, `.png`, `.tiff`, `.webp`; false for `2026/Logos/rsd.png`, `2025/x/__MACOSX/._a.jpg`, `2025/x/.DS_Store`, `2025/x/list.pdf`, `2025/x/` (folder).
- `createRsdBucketSource({ year: '2025', list })` with `list` returning objects built from `tests/fixtures/art/bucket-2025-keys.json` (size 1000 each) and one object with size 30 MB: after `prepare(season, season)` for 2025-april, `accepted('alison-moyet-hometime')?.imageUrl` equals `objectUrl('2025/Artwork RSD 2025/01-ALL ART COMBINED/Alison Moyet copy.png')`; `suggestions('charles-mingus-in-argentina-the-buenos-aires-concerts')` non-empty; the 30 MB key is never a candidate; `list` was called once with `'2025/'`.
- `list` throwing `BucketError` → `prepare` resolves, `accepted(anything)` is null, and `log` was called with a line mentioning the error.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/art` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`scripts/art/normalize.ts`:

```ts
import sharp from 'sharp'

/** Same cap as the season bundle: covers the app's largest art at @2x. */
export const ART_MAX_DIMENSION = 800
export const ART_JPEG_QUALITY = 85

/** Any image sharp can decode → a JPEG no larger than 800×800, EXIF orientation applied. */
export async function normalizeArtImage(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: ART_MAX_DIMENSION, height: ART_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: ART_JPEG_QUALITY, mozjpeg: true })
    .toBuffer()
}
```

`scripts/watch/bucket.ts`: rename the body of `listPdfs` into `export async function listKeys(prefix, keep, fetchImpl = fetch)` using `page.objects.filter((o) => keep(o.key))`, and define `export async function listPdfs(prefix: string, fetchImpl: typeof fetch = fetch) { return listKeys(prefix, (k) => k.toLowerCase().endsWith('.pdf'), fetchImpl) }`. Existing bucket tests must pass unchanged.

`scripts/art/indexed-source.ts`:

```ts
import type { RawRelease } from '../types.js'

import type { ScoredCandidate } from './match.js'

/**
 * An art source that matches a whole season at once (so it can enforce
 * one-image-one-release), then answers per release.
 */
export interface IndexedArtSource {
  name: 'rsd-site' | 'rsd-bucket'
  /** Build the index for `missing` (releases still without art). Never throws. */
  prepare(missing: RawRelease[], season: RawRelease[]): Promise<void>
  accepted(releaseId: string): ScoredCandidate | null
  suggestions(releaseId: string): ScoredCandidate[]
}
```

`scripts/art/rsd-bucket.ts`:

```ts
import type { RawRelease } from '../types.js'
import { listKeys, objectUrl } from '../watch/bucket.js'
import type { BucketObject } from '../watch/sources.js'

import type { IndexedArtSource } from './indexed-source.js'
import { type ArtCandidate, matchReleases, type MatchResult, type ScoredCandidate } from './match.js'

export const MAX_BUCKET_IMAGE_BYTES = 25 * 1024 * 1024

export function isArtImageKey(key: string): boolean {
  const lower = key.toLowerCase()
  if (!/\.(jpe?g|png|webp|tiff?)$/.test(lower)) return false
  return !lower.includes('/logos/') && !lower.includes('__macosx/') && !lower.endsWith('.ds_store')
}

export interface RsdBucketOptions {
  /** Season year, e.g. "2026" — the bucket prefix. */
  year: string
  list?: (prefix: string) => Promise<BucketObject[]>
  log?: (line: string) => void
}

/** Tier: distributor art packs RSD sometimes uploads next to the list PDF. Free, no credentials. */
export function createRsdBucketSource(opts: RsdBucketOptions): IndexedArtSource {
  const list = opts.list ?? ((prefix: string) => listKeys(prefix, isArtImageKey))
  const log = opts.log ?? ((line: string) => console.log(line))
  let result: MatchResult = { accepted: new Map(), suggestions: new Map() }
  return {
    name: 'rsd-bucket',
    async prepare(missing: RawRelease[], season: RawRelease[]): Promise<void> {
      if (missing.length === 0) return
      try {
        const objects = (await list(`${opts.year}/`)).filter(
          (o) => isArtImageKey(o.key) && o.size <= MAX_BUCKET_IMAGE_BYTES,
        )
        const candidates: ArtCandidate[] = objects.map((o) => ({
          source: 'rsd-bucket',
          key: o.key,
          imageUrl: objectUrl(o.key),
          thumbUrl: objectUrl(o.key),
          label: o.key.slice(o.key.lastIndexOf('/') + 1),
        }))
        result = matchReleases(missing, candidates, season)
        log(`rsd-bucket: ${candidates.length} images under ${opts.year}/, ${result.accepted.size} matched`)
      } catch (err) {
        log(`rsd-bucket: skipped (${err instanceof Error ? err.message : String(err)})`)
      }
    },
    accepted: (id: string): ScoredCandidate | null => result.accepted.get(id) ?? null,
    suggestions: (id: string): ScoredCandidate[] => result.suggestions.get(id) ?? [],
  }
}
```

- [ ] **Step 4: Run tests** — `pnpm vitest run tests/art tests/watch/bucket.test.ts` → PASS.

- [ ] **Step 5: Checks and commit** — `feat(art): JPEG normalization and RSD bucket art source`.

---

### Task 3: Cascade integration and `art-candidates.json`

**Files:**
- Modify: `scripts/types.ts` (only `ArtTier`), `scripts/fetch-art.ts`, `scripts/watch/publish.ts`, `scripts/validate.ts`
- Create: `scripts/art/candidates.ts`
- Test: `tests/fetch-art.test.ts` (extend), `tests/art/candidates.test.ts`

**Interfaces:**
- Consumes: `IndexedArtSource` (Task 2), `normalizeArtImage` (Task 2), `createRsdBucketSource` (Task 2), `ScoredCandidate` (Task 1).
- Produces:
  - `ArtTier = 'manual' | 'rsd-site' | 'rsd-bucket' | 'discogs' | 'musicbrainz' | 'none'`.
  - `CascadeOptions` gains `seasonId?: string` (enables the RSD tiers; year = its first 4 chars) and `indexedSources?: IndexedArtSource[]` (test override; replaces the defaults).
  - `CascadeSummary` gains `suggestions: Map<string, ScoredCandidate[]>` (releases that ended with no art).
  - `buildDefaultIndexedSources(options): IndexedArtSource[]` — `[createRsdBucketSource({ year })]` when `seasonId` is set, else `[]` (Task 8 prepends the site source).
  - `candidates.ts`: `ArtCandidatesSchema` (Zod), `type ArtCandidatesFile`, `writeArtCandidates(seasonDir: string, suggestions: Map<string, ScoredCandidate[]>): Promise<'written' | 'deleted' | 'unchanged'>`.

Behaviour (all existing tests keep passing; update only the coverage-summary expectations for the new lines):

1. Pre-pass: for every release, resolve manual hit and existing-file status exactly as today; collect `pending` = releases with neither.
2. If not `dryRun` (or if `indexedSources` were passed explicitly), call each indexed source's `prepare(pendingNotYetAccepted, releases)` in order (`rsd-site` then `rsd-bucket`), where `pendingNotYetAccepted` excludes releases an earlier indexed source accepted. In dry-run with default sources, skip them (no network), like Discogs/MusicBrainz today.
3. Main loop per pending release: tiers in order — each indexed source's `accepted(id)` (as an `ArtLookupResult` with `tier: source.name`, `sourceUrl: candidate.imageUrl`, `artFilename: <id>.jpg`), then Discogs, then MusicBrainz.
4. Materializing an `rsd-*` hit: fetch `sourceUrl`, then `normalizeArtImage(bytes)`, then write `<id>.jpg`. Any failure (non-2xx, decode error) demotes to the next tier for that release — not straight to `none` — so a broken RSD image still lets Discogs try. Discogs/MusicBrainz materialization stays as today.
5. For releases ending with `none`, `summary.suggestions` gets the top 3 by score across all indexed sources' `suggestions(id)`, deduped by `imageUrl`.
6. `formatCoverageSummary` adds `  RSD site:` and `  RSD bucket:` lines (same alignment style) and includes both in `Coverage`.
7. `fetch-art.ts` CLI and `publish.ts`'s `fetchArt` pass `seasonId`, and after a non-dry run call `writeArtCandidates(resolve(repoRoot, 'releases', seasonId), summary.suggestions)` and log the outcome.
8. `validate.ts`: for each `releases/<season>/art-candidates.json` that exists, validate with `ArtCandidatesSchema` (ENOENT = skip; other errors = Problem).

`scripts/art/candidates.ts`:

```ts
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import type { ScoredCandidate } from './match.js'

const CandidateSchema = z
  .object({
    source: z.enum(['rsd-site', 'rsd-bucket']),
    imageUrl: z.string().url(),
    thumbUrl: z.string().url(),
    label: z.string().min(1),
    score: z.number().min(0).max(1),
  })
  .strict()

export const ArtCandidatesSchema = z.array(
  z.object({ releaseId: z.string().min(1), candidates: z.array(CandidateSchema).min(1).max(3) }).strict(),
)
export type ArtCandidatesFile = z.infer<typeof ArtCandidatesSchema>

export const ART_CANDIDATES_FILE = 'art-candidates.json'

/**
 * Write the season's suggestions for art-admin, sorted by release id. Deletes
 * the file when nothing is left to suggest. Returns what happened.
 */
export async function writeArtCandidates(
  seasonDir: string,
  suggestions: Map<string, ScoredCandidate[]>,
): Promise<'written' | 'deleted' | 'unchanged'> {
  const path = resolve(seasonDir, ART_CANDIDATES_FILE)
  const entries: ArtCandidatesFile = [...suggestions]
    .filter(([, cs]) => cs.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([releaseId, cs]) => ({
      releaseId,
      candidates: cs.slice(0, 3).map((c) => ({
        source: c.source,
        imageUrl: c.imageUrl,
        thumbUrl: c.thumbUrl,
        label: c.label,
        score: Math.round(c.score * 100) / 100,
      })),
    }))
  let existing: string | null = null
  try {
    existing = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (entries.length === 0) {
    if (existing === null) return 'unchanged'
    await unlink(path)
    return 'deleted'
  }
  const next = `${JSON.stringify(ArtCandidatesSchema.parse(entries), null, 2)}\n`
  if (next === existing) return 'unchanged'
  await writeFile(path, next, 'utf8')
  return 'written'
}
```

- [ ] **Step 1: Failing tests**
  - `tests/art/candidates.test.ts`: writes sorted entries with rounded scores; deletes an existing file when suggestions are empty; returns `'unchanged'` when content is identical; rejects (schema) a non-URL imageUrl.
  - `tests/fetch-art.test.ts` additions (use `indexedSources` with in-memory fakes implementing `IndexedArtSource`, `fetchImpl` returning a real PNG made with sharp, and a temp `artDir`):
    - an `rsd-site` fake hit wins over a Discogs hit; the written file is JPEG (`ff d8`), `counts['rsd-site'] === 1`.
    - a manual hit and an existing file still win over indexed sources (indexed `prepare` receives neither release).
    - an `rsd-bucket` hit whose image fetch returns 404 falls through to the Discogs fake.
    - a release with no hit and fake suggestions ends `none` with `summary.suggestions.get(id)` holding ≤ 3 candidates sorted by score.
    - dry-run with default sources doesn't call `prepare`.
  - `formatCoverageSummary` test updated for the two new lines.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement per the behaviour list above.**
- [ ] **Step 4: Run tests** — `pnpm vitest run tests/fetch-art.test.ts tests/art` → PASS; then the full suite.
- [ ] **Step 5: Verify locally without network side effects** — `pnpm tsx scripts/fetch-art.ts 2025-november --dry-run` prints the summary with the new lines.
- [ ] **Step 6: Checks and commit** — `feat(art): RSD tiers in the cascade and art-candidates.json`.

---

### Task 4: Bright Data Web Unlocker client

**Files:**
- Create: `scripts/art/brightdata.ts`
- Test: `tests/art/brightdata.test.ts`

**Interfaces:**
- Produces: `UNLOCKER_ENDPOINT = 'https://api.brightdata.com/request'`, `UNLOCKER_MAX_REQUESTS = 400`, `class UnlockerBudgetError extends Error`, `interface Unlocker { fetchPage(url: string): Promise<string>; requestsMade(): number }`, `createUnlocker(opts: { apiKey: string; zone: string; fetchImpl?: typeof fetch; maxRequests?: number }): Unlocker`, `unlockerFromEnv(env?: NodeJS.ProcessEnv): Unlocker | null` (null unless both `BRIGHT_DATA_KEY` and `BRIGHT_DATA_ZONE` are set).

```ts
export const UNLOCKER_ENDPOINT = 'https://api.brightdata.com/request'
export const UNLOCKER_MAX_REQUESTS = 400
const TIMEOUT_MS = 60_000

export class UnlockerBudgetError extends Error {
  override name = 'UnlockerBudgetError'
}

export interface Unlocker {
  /** The page's HTML via Bright Data Web Unlocker. Throws on any failure. */
  fetchPage(url: string): Promise<string>
  requestsMade(): number
}

export interface UnlockerOptions {
  apiKey: string
  zone: string
  fetchImpl?: typeof fetch
  maxRequests?: number
}

export function createUnlocker(opts: UnlockerOptions): Unlocker {
  const max = opts.maxRequests ?? UNLOCKER_MAX_REQUESTS
  let made = 0
  return {
    async fetchPage(url: string): Promise<string> {
      if (made >= max) throw new UnlockerBudgetError(`Bright Data budget of ${max} requests reached`)
      made += 1
      // Resolved per call: msw patches global fetch after module load.
      const fetchImpl = opts.fetchImpl ?? fetch
      const res = await fetchImpl(UNLOCKER_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ zone: opts.zone, url, format: 'raw' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        const detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 160)
        throw new Error(`Bright Data returned HTTP ${res.status} for ${url}: ${detail}`)
      }
      const body = await res.text()
      if (!body.trim()) throw new Error(`Bright Data returned an empty page for ${url}`)
      return body
    },
    requestsMade: () => made,
  }
}

export function unlockerFromEnv(env: NodeJS.ProcessEnv = process.env): Unlocker | null {
  const apiKey = env['BRIGHT_DATA_KEY']
  const zone = env['BRIGHT_DATA_ZONE']
  return apiKey && zone ? createUnlocker({ apiKey, zone }) : null
}
```

- [ ] **Step 1: Failing tests (msw):** request shape (POST to the endpoint, `Authorization: Bearer k`, JSON body `{ zone: 'z', url, format: 'raw' }`) and returned HTML; HTTP 403 → throws with "HTTP 403" and never contains the api key string; empty body → throws; the `maxRequests: 2` third call throws `UnlockerBudgetError` without a request; `unlockerFromEnv({})` and `({ BRIGHT_DATA_KEY: 'k' })` → null, both set → non-null.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Checks and commit** — `feat(art): Bright Data Web Unlocker client`.

---

### Task 5: Daily art refresh and secrets in workflows

**Files:**
- Create: `scripts/art-refresh-target.ts`
- Modify: `.github/workflows/refresh-art.yml`, `.github/workflows/watch-rsd.yml`, `.github/workflows/ingest.yml`
- Test: `tests/art/refresh-target.test.ts`

**Interfaces:**
- Produces: `refreshTarget(current: { id: string; date: string }, today: string): string | null` — the season id when `current.date >= today`, else null; CLI prints the id or nothing (exit 0).

- [ ] **Step 1: Failing test** — date after today → id; equal → id; before → null.
- [ ] **Step 2–4:** implement (`scripts/art-refresh-target.ts` reads `current.json` with `CurrentSeasonSchema`, `today` from `process.env.OVERRIDE_TODAY ?? new Date().toISOString().slice(0, 10)`; guarded CLI entry like `register-season.ts`'s `isInvokedAsCli`).
- [ ] **Step 5: `refresh-art.yml`:** add `schedule: - cron: '0 14 * * *'`; make the `season-id` input optional; `concurrency: { group: refresh-art, cancel-in-progress: false }`; `timeout-minutes: 60`; permissions add `actions: write`. A "Pick season" step: if `inputs.season-id` is non-empty use it, else `pnpm -s tsx scripts/art-refresh-target.ts`; if empty, print "No upcoming season; skipping." and skip later steps (step output + `if:`). Pass `BRIGHT_DATA_KEY` / `BRIGHT_DATA_ZONE` secrets to the fetch step. Commit `releases/$SEASON_ID/` (art plus `art-candidates.json`) with the existing retry loop. Keepalive step identical in shape to `auto-status.yml`'s (`if: always()`, `gh api -X PUT .../actions/workflows/refresh-art.yml/enable`). Inputs reach shell only via `env:`.
- [ ] **Step 6:** add `BRIGHT_DATA_KEY` and `BRIGHT_DATA_ZONE` (`${{ secrets.… }}`) to the env of the step that runs the cascade in `watch-rsd.yml` and `ingest.yml`.
- [ ] **Step 7: Checks** — `actionlint .github/workflows/*.yml`, `pnpm lint && pnpm typecheck && pnpm test`. Commit `feat(art): daily art refresh for the upcoming season`.

---

### Task 6: art-admin suggestions and batch save (repo `../wax-wishlist-art-admin`)

**Files (in `/Users/todd.greco/current_work/rsd-app/wax-wishlist-art-admin`):**
- Modify: `package.json` (add `sharp`, devDeps `vitest`), `lib/types.ts`, `lib/github.ts`, `app/actions.ts`, `app/page.tsx`, `app/components/ReleaseRow.tsx`, `README.md`
- Create: `lib/candidates.ts`, `lib/image.ts`, `lib/batch.ts`, `vitest.config.ts`, `tests/candidates.test.ts`, `tests/batch.test.ts`

**Interfaces:**
- Consumes: `releases/<season>/art-candidates.json` shape from Task 3 (`[{ releaseId, candidates: [{ source, imageUrl, thumbUrl, label, score }] }]`).
- Produces:
  - `lib/candidates.ts`: `parseCandidates(json: unknown): Map<string, Candidate[]>` (drops malformed entries, never throws); `fetchCandidates(seasonId): Promise<Map<…>>` (raw.githubusercontent.com, 404 → empty map).
  - `lib/image.ts`: `toJpeg(bytes: Uint8Array): Promise<Uint8Array>` — sharp, ≤800×800, `withoutEnlargement`, rotate, JPEG quality 85.
  - `lib/github.ts`: `commitFiles(files: { path: string; bytes: Uint8Array }[], message: string): Promise<string>` — Git Data API: `git.getRef('heads/<branch>')` → `git.getCommit` → `git.createBlob` (base64) per file → `git.createTree({ base_tree, tree })` → `git.createCommit({ parents: [head] })` → `git.updateRef`; returns the commit sha. Existing `uploadArt` removed once unused.
  - `lib/batch.ts`: `collectRows(formData: FormData): { releaseId: string; seasonId: string; filename: string; url: string }[]` — for each `releaseId` in the form, the URL is the pasted `url:<id>` value if non-empty, else the accepted candidate's `imageUrl` when checkbox `accept:<id>` is on, else the row is skipped.
  - `app/actions.ts`: `saveBatch(prev, formData): Promise<{ ok: boolean; message: string; rows: { releaseId: string; ok: boolean; message: string }[] }>` — auth check, `collectRows`, fetch each URL (http(s) only, `image/*`, non-empty, ≤10 MB), `toJpeg`, then one `commitFiles(..., 'art: add N images')` for all successes; per-row failures reported; `revalidatePath('/')`.

- [ ] **Step 1:** `npm install sharp && npm install -D vitest`; `vitest.config.ts` with `test.include: ['tests/**/*.test.ts']`; add `"test": "vitest run"` script.
- [ ] **Step 2: Failing tests** — `tests/candidates.test.ts`: valid file → map with candidates; malformed entries dropped; non-array → empty map. `tests/batch.test.ts`: `collectRows` precedence (pasted URL beats accepted suggestion; unchecked + empty skipped); `commitFiles` with a fake Octokit (object with `git.getRef/getCommit/createBlob/createTree/createCommit/updateRef` vi.fn()s) creates one blob per file, one tree with `base_tree`, one commit with the right parent and message, and updates the ref to the new sha.
- [ ] **Step 3: Implement** the lib functions, then the UI: `page.tsx` loads `listMissing()` and `fetchCandidates(season.id)` in parallel and renders one `<form action={saveBatch}>` around all rows with a single **Save** button (client component using `useActionState`, showing the summary and per-row messages). `ReleaseRow` shows, when it has candidates: the top candidate's `thumbUrl` image (fixed 96px square), label, score, an `accept:<id>` checkbox, links to the other candidates; plus the existing URL input renamed `url:<id>`, and hidden `seasonId:<id>` / `filename:<id>` / `candidate:<id>` (top imageUrl) fields. Keep the existing styling conventions in `globals.css`.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run build` all clean.
- [ ] **Step 5:** README "How it works" updated (suggestions, batch save, JPEG normalization). Commit in the art-admin repo: `feat: one-click suggestions and batch save`. Do not push (Vercel deploys from main; the controller asks Todd first).

---

### Task 7: Record recordstoreday.com fixtures (needs the Bright Data key)

**Precondition:** `.env` in the data repo has `BRIGHT_DATA_KEY` and `BRIGHT_DATA_ZONE`. If not, report BLOCKED immediately (the controller asks Todd).

**Files:**
- Create: `scripts/art/record-rsd-pages.ts` (dev tool), `tests/fixtures/rsd-site/*.html`, `tests/fixtures/rsd-site/README.md`

- [ ] **Step 1:** Write `record-rsd-pages.ts <url> <out-file>`: uses `unlockerFromEnv()` to fetch one page and saves the HTML. Never prints the key. Run with `pnpm tsx --env-file=.env scripts/art/record-rsd-pages.ts …`.
- [ ] **Step 2: Discover** (budget: at most 30 Unlocker requests in total for this task): fetch `https://recordstoreday.com/` and find links to the special-release listings (April and Black Friday). Identify: the listing URL pattern per event (e.g. a query or path naming the event/year); whether the listing shows every release on one page or paginates; whether it includes artist, title and an `img.broadtime.com/Photo/<id>` URL per release; the release-page URL pattern and where artist, title and photo id appear on it.
- [ ] **Step 3: Record** the listing for the most recent April event (2026) — all pages if paginated, capped at 5 pages — and 2 release pages (include the a-ha *Analogue* page if found; its photo id should be `418467310484`). Save under `tests/fixtures/rsd-site/` with descriptive names.
- [ ] **Step 4: Document** in `tests/fixtures/rsd-site/README.md`: the URLs fetched, the listing URL pattern for April vs Black Friday (and how to build it from a season id like `2026-november`), pagination, the selectors/patterns for artist, title, photo id, and release links, and the request count used.
- [ ] **Step 5:** Commit `test(art): recorded recordstoreday.com pages for the site parser` (fixtures + README + script). If the site turns out to need something Web Unlocker can't do (e.g. content rendered only by JavaScript with no data in the HTML), stop and report NEEDS_CONTEXT with the evidence.

---

### Task 8: `rsd-site` source

**Files:**
- Create: `scripts/art/rsd-site.ts`
- Modify: `scripts/fetch-art.ts` (`buildDefaultIndexedSources` prepends the site source)
- Test: `tests/art/rsd-site.test.ts`

**Interfaces:**
- Consumes: `Unlocker`, `unlockerFromEnv`, `UnlockerBudgetError` (Task 4); `ArtCandidate`, `matchReleases` (Task 1); `IndexedArtSource` (Task 2); fixtures + README (Task 7).
- Produces: `interface SiteEntry { artist: string; title: string; photoId: number; pageUrl: string }`; `listingUrls(seasonId: string): string[]` (per the Task 7 README); `parseListing(html: string, pageUrl: string): { entries: SiteEntry[]; releasePageUrls: string[]; nextPageUrl: string | null }`; `parseReleasePage(html: string, pageUrl: string): SiteEntry | null`; `photoUrl(photoId: number, size?: 360 | 800): string`; `createRsdSiteSource(opts: { seasonId: string; unlocker: Unlocker | null; log?: (line: string) => void }): IndexedArtSource`.

Behaviour:
- `prepare(missing, season)`: unlocker null → log once "rsd-site: Bright Data not configured; skipping" and return. Otherwise fetch the listing page(s) (following `nextPageUrl`, at most 10 pages), parse entries. If entries lack photo ids or are missing for some releases, fetch release pages only for listing links whose text plausibly matches a still-unmatched release (score ≥ `MATCH.suggest` against the link text), stopping at the Unlocker budget. Convert entries to candidates (`source: 'rsd-site'`, `key: photo:<id>`, `imageUrl: photoUrl(id, 800)`, `thumbUrl: photoUrl(id, 360)`, `artist`, `title`, `photoId`) and run `matchReleases(missing, candidates, season)`. Any thrown error (including `UnlockerBudgetError`) is caught: log it, keep whatever was matched so far.
- Photo ids are parsed only from `img.broadtime.com/Photo/<digits>` URLs.

- [ ] **Step 1: Failing tests** against the Task 7 fixtures: `parseListing` on the recorded listing returns the expected number of entries (count them from the fixture and hard-code it) and includes the a-ha entry with photo id 418467310484 (or another entry verified by eye from the fixture); `parseReleasePage` on each recorded release page returns the right artist/title/photo id; `listingUrls('2026-april')` and `listingUrls('2026-november')` match the README; `createRsdSiteSource` with a fake `Unlocker` serving the fixtures matches a-ha *Analogue* in 2026-april; with `unlocker: null` it logs once and accepts nothing; a fake unlocker that throws `UnlockerBudgetError` on its second call keeps first-page matches.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** wire into `buildDefaultIndexedSources`: `[createRsdSiteSource({ seasonId, unlocker: unlockerFromEnv() }), createRsdBucketSource({ year })]` when `seasonId` is set.
- [ ] **Step 6: Checks and commit** — `feat(art): recordstoreday.com product image tier via Bright Data`.

---

### Task 9: Live check and docs

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-01-art-coverage-design.md` (status line only)

- [ ] **Step 1: Live check** (spends a few Unlocker requests; free image downloads): copy the repo's `releases/2026-april/` to a temp repo root (with `seasons.json`, `current.json`, `manual-art/` empty) and empty its `art/` directory; run the cascade non-dry against that temp root with `seasonId: '2026-april'` via a throwaway script (not committed) using `--env-file=.env`. Record per-tier counts, suggestion count, Unlocker requests used, and run time.
- [ ] **Step 2: Spot-check accuracy:** for 20 random releases accepted by `rsd-site` (or all, if fewer), compare the downloaded image with the hand-verified file in the real `releases/2026-april/art/<id>.jpg` (view both, or compare perceptual similarity with sharp by resizing both to 16×16 greyscale and checking the mean absolute difference). Record mismatches with their scores. If any accepted match is wrong, report it with the score — do not change thresholds without the controller's ruling.
- [ ] **Step 3:** Same live check for `rsd-bucket` against 2025-april (art emptied in a temp copy): accepted count and 20-image spot check against the existing Discogs/manual art where present.
- [ ] **Step 4: README** — "Album art" section: tier order, the two RSD tiers and what each needs, `art-candidates.json`, the daily refresh, Bright Data secrets (with the zone hardening advice: dedicated zone, target domain restricted to recordstoreday.com, spend limit), and the art-admin batch flow.
- [ ] **Step 5:** Spec status → "Implemented (2026-10-xx)"; commit `docs(art): art coverage runbook and live-check results`.

---

## Execution order

Tasks 1–6 need no Bright Data key; run them first. Task 7 needs the key in `.env` — if it isn't there yet when Tasks 1–6 are done, the controller stops and asks Todd. Then Tasks 8–9.

## Self-review notes

- Spec coverage: cascade order and tiers (T2, T3, T8); matcher rules incl. duplicates, one-image-one-release, photo-id check (T1); JPEG normalization (T2, T3); `rsd-site` fetching, index, parsing, budget (T4, T7, T8); `rsd-bucket` (T2); suggestions file (T3) and validation (T3); daily refresh + secrets (T5); art-admin suggestions, batch save, normalization (T6); error handling (T2, T3, T4, T8); testing incl. live check (T9); rollout order (Execution order).
- Known unknowns, deliberately deferred to recorded data: site URL patterns and markup (T7 → T8). Task 8's tests are written against the recorded fixtures rather than fixed in this plan.
