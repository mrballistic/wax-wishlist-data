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
    // The title must not repeat an artist token, or the filename would count as artist + title.
    const ah = rel('ah', 'Charles Mingus', 'Ah Um')
    expect(scoreCandidate(ah, bucket('x/Charles Mingus_Cover.jpg'), 1)).toBe(MATCH.artistOnlyUnique)
    expect(scoreCandidate(ah, bucket('x/Charles Mingus_Cover.jpg'), 2)).toBe(MATCH.artistOnlyShared)
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
    // Two different releases that fit one image equally well: neither is accepted.
    const d = rel('d1', 'Band', 'Album')
    const e = rel('e1', 'Band', 'Album')
    expect(matchReleases([d, e], [site('Band', 'Album', 6)], [d, e]).accepted.size).toBe(0)
    // A better owner elsewhere in the season keeps the image from a weaker release.
    expect(matchReleases([a, c], [site('Band', 'Album', 7)], [a, c]).accepted.has('other-album')).toBe(false)
  })

  it('does not accept a site entry whose artist has extra foreign tokens', () => {
    const a = rel('band-album', 'Band', 'Album')
    expect(scoreCandidate(a, site('Band Other', 'Album', 6), 1)).toBeCloseTo(0.8)
    const res = matchReleases([a], [site('Band Other', 'Album', 6)], [a])
    expect(res.accepted.size).toBe(0)
    expect(res.suggestions.get('band-album')?.length).toBe(1)
  })

  it('caps a filename that carries a foreign artist even if the title matches exactly', () => {
    const r = rel('gh', 'Artist X', 'Greatest Hits')
    const score = scoreCandidate(r, bucket('x/Other Band - Greatest Hits.jpg'), 1)
    expect(score).toBeLessThanOrEqual(MATCH.titlePartialCap)
    expect(scoreCandidate(r, bucket('x/Greatest Hits.jpg'), 1)).toBeCloseTo(1)
  })

  it('gives a partial-artist filename the shared score even for a unique artist', () => {
    const r = rel('bk', 'Black Keys', 'Brothers')
    expect(scoreCandidate(r, bucket('x/Black.jpg'), 1)).toBe(MATCH.artistOnlyShared)
    expect(scoreCandidate(r, bucket('x/Black Keys.jpg'), 1)).toBe(MATCH.artistOnlyUnique)
  })

  it('does not take an image that belongs to another release in the season, even one that already has art', () => {
    const pink = rel('pink-animals', 'Pink', 'Animals')
    const floyd = rel('pink-floyd-animals', 'Pink Floyd', 'Animals')
    const res = matchReleases([pink], [bucket('x/Pink Floyd - Animals.jpg')], [pink, floyd])
    expect(res.accepted.has('pink-animals')).toBe(false)
  })

  it('demotes site matches whose photo id is far from the season median', () => {
    const releases = Array.from({ length: 11 }, (_, i) => rel(`r${i}`, `Band${i}`, `Album${i}`))
    const cands = releases.map((r, i) => site(r.artist, r.title, i === 10 ? 999_999_999 : 418_467_310_000 + i))
    const res = matchReleases(releases, cands, releases)
    expect(res.accepted.size).toBe(10)
    expect(res.accepted.has('r10')).toBe(false)
    expect(res.suggestions.get('r10')?.[0]?.photoId).toBe(999_999_999)
  })
})

describe('matchReleases — site formats', () => {
  const siteF = (artist: string, title: string, photoId: number, format: string): ArtCandidate => ({
    ...site(artist, title, photoId),
    format,
  })
  const relF = (id: string, artist: string, title: string, format: string): RawRelease =>
    makeRelease(0, { id, artist, title, format })

  it('blends a 0.15 format score into site scores when both sides have a format', () => {
    const r = relF('x', 'Jeff Buckley', "Live À L'Olympia", '2 x LP')
    expect(scoreCandidate(r, siteF('Jeff Buckley', "Live À L'Olympia", 1, '2 x LP'), 1)).toBeCloseTo(1)
    expect(scoreCandidate(r, siteF('Jeff Buckley', "Live À L'Olympia", 2, 'CD'), 1)).toBeCloseTo(0.85)
    expect(scoreCandidate(r, siteF('Jeff Buckley', "Live À L'Olympia", 3, 'LP'), 1)).toBeCloseTo(0.85 + 0.15 / 3)
    expect(scoreCandidate(r, siteF('Jeff Buckley', "Live À L'Olympia", 4, ''), 1)).toBeCloseTo(1)
  })

  it('gives each Jeff Buckley format its own photo (fixture rows 19910 / 19911)', async () => {
    const season = await loadRaw('2026-april')
    const lp = season.find((r) => r.id === 'jeff-buckley-live-a-lolympia')
    const cd = season.find((r) => r.id === 'jeff-buckley-live-a-lolympia-2')
    expect(lp?.format).toBe('2 x LP')
    expect(cd?.format).toBe('CD')
    const candidates = [
      siteF('Jeff Buckley', "Live À L'Olympia", 418467310333, '2 x LP'),
      siteF('Jeff Buckley', "Live À L'Olympia", 418467310334, 'CD'),
    ]
    const res = matchReleases(season, candidates, season)
    expect(res.accepted.get('jeff-buckley-live-a-lolympia')?.photoId).toBe(418467310333)
    expect(res.accepted.get('jeff-buckley-live-a-lolympia-2')?.photoId).toBe(418467310334)
  })

  it('collapses identical-format site rows to the lowest photo id', () => {
    const r = relF('a-b', 'Artist', 'Some Title', 'LP')
    const res = matchReleases(
      [r],
      [siteF('Artist', 'Some Title', 502, 'LP'), siteF('Artist', 'Some Title', 501, 'LP')],
      [r],
    )
    expect(res.accepted.get('a-b')?.photoId).toBe(501)
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
