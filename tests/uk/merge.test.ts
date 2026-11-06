import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { type Release, ReleaseListSchema, type UkList, type UkRow } from '../../scripts/types.js'
import {
  displayArtist,
  formatUkReport,
  matchUk,
  mergeUk,
  scorePair,
  ukRowKey,
} from '../../scripts/uk/merge.js'
import { parseUkPdf } from '../../scripts/uk/parse.js'
import { DATA_ROOT, REPO_ROOT } from '../helpers/releases.js'

const NONE = { match: {}, ukOnly: [] }
const row = (artist: string, title: string, format = 'LP', label = 'Lab'): UkRow => ({
  artist,
  title,
  label,
  format,
})
const us = (id: string, artist: string, title: string, over: Partial<Release> = {}): Release => ({
  id,
  artist,
  title,
  label: 'Lab',
  format: 'LP',
  category: 'exclusive',
  description: '',
  discogsMasterId: null,
  artFilename: `${id}.jpg`,
  ...over,
})
const list = (rows: UkRow[]): UkList => ({
  sourceUrl: 'https://example.com/uk.pdf',
  fetchedAt: '2026-11-06T00:00:00.000Z',
  rows,
})

describe('2026 Black Friday: real UK list against the real US list', () => {
  let usList: Release[]
  let ukRows: UkRow[]
  beforeAll(async () => {
    usList = ReleaseListSchema.parse(
      JSON.parse(
        await readFile(join(DATA_ROOT, 'releases', '2026-november', 'releases.json'), 'utf8'),
      ),
    )
    ukRows = await parseUkPdf(
      await readFile(join(REPO_ROOT, 'tests', 'fixtures', '2026-november-uk.pdf')),
    )
  })

  it('finds 111 shared releases and 40 UK exclusives', () => {
    const r = matchUk(usList, ukRows, NONE)
    expect(r.matches).toHaveLength(111)
    expect(r.ukOnly).toHaveLength(40)
    const exclusives = r.ukOnly.map((u) => `${u.row.artist} — ${u.row.title}`)
    expect(exclusives).toEqual(
      expect.arrayContaining([
        'Black Sabbath — Technical Ecstasy',
        'Madness — How The West Was One: Hammersmith Odeon 23rd December 1980',
        // Same artist, a different record from the US list's "The Rising Night".
        'Doctor Who — The Day of the Troll',
        // Shares only "Blue" with Blue Mitchell's "Out Of The Blue".
        'Blue Horizon — Blue Horizon',
      ]),
    )
  })

  it('matches across naming differences', () => {
    const r = matchUk(usList, ukRows, NONE)
    const to = (artist: string, title: string) =>
      r.matches.find((m) => m.row.artist === artist && m.row.title === title)?.usId
    expect(to('Norah Jones', 'Play Along Vol 2')).toBe('norah-jones-playing-along-volume-2')
    expect(to('Tom Verlaine', 'Live NYC 96-06')).toMatch(/^tom-verlaine-live-in-nyc/)
    expect(to('Mile End Kicks', 'Music Inspired by the Motion Picture')).toBe(
      'various-artists-mile-end-kicks-music-inspired-by-the-motion-picture',
    )
    expect(to('Fischerspooner', '#1')).toBe('fischerspooner-1')
    expect(to('Beatles (The)', 'Rubber Soul (US Version)')).toMatch(/^the-beatles-rubber-soul/)
  })

  it('pairs the LP and CD of one title with the LP and CD', () => {
    const r = matchUk(usList, ukRows, NONE)
    const withers = r.matches
      .filter((m) => m.row.artist === 'Bill Withers')
      .map((m) => [m.row.format, m.usId])
    expect(withers).toEqual(
      expect.arrayContaining([
        ['LP', 'bill-withers-bill-withers-in-concert-live-at-the-bbc-1974'],
        ['CD', 'bill-withers-bill-withers-in-concert-live-at-the-bbc-1974-2'],
      ]),
    )
  })

  it('flags the borderline Cher match for a human', () => {
    const r = matchUk(usList, ukRows, NONE)
    expect(r.uncertain.map((m) => m.usId)).toEqual(['cher-christmas-dj-party-edition'])
  })

  it('merges into a list that passes the schema with unique ids', () => {
    const { releases } = mergeUk(usList, list(ukRows), NONE)
    expect(releases).toHaveLength(226)
    expect(() => ReleaseListSchema.parse(releases)).not.toThrow()
    expect(new Set(releases.map((r) => r.id)).size).toBe(226)
    expect(releases.filter((r) => r.regions?.join() === 'us,uk')).toHaveLength(111)
    expect(releases.filter((r) => r.regions?.join() === 'us')).toHaveLength(75)
    expect(releases.filter((r) => r.regions?.join() === 'uk')).toHaveLength(40)
  })
})

describe('scorePair', () => {
  it('ignores "The" however it is written', () => {
    expect(
      scorePair(row('Coral, The', 'Butterfly House'), us('x', 'The Coral', 'Butterfly House'))
        .artist,
    ).toBe(1)
    expect(
      scorePair(row('Beatles (The)', 'Rubber Soul'), us('x', 'The Beatles', 'Rubber Soul')).artist,
    ).toBe(1)
  })
})

describe('displayArtist', () => {
  it('un-inverts the article as the US list writes it', () => {
    expect(displayArtist('Coral, The')).toBe('The Coral')
    expect(displayArtist('Beatles (The)')).toBe('The Beatles')
    expect(displayArtist('Madness')).toBe('Madness')
  })
})

describe('matchUk overrides', () => {
  const usList = [us('a-x', 'A', 'X'), us('b-y', 'B', 'Y')]

  it('pins a match the fuzzy matcher would miss', () => {
    const r = matchUk(usList, [row('Alpha', 'Totally Different')], {
      match: { [ukRowKey(row('Alpha', 'Totally Different'))]: 'a-x' },
      ukOnly: [],
    })
    expect(r.matches).toEqual([expect.objectContaining({ usId: 'a-x', via: 'override' })])
    expect(r.ukOnly).toEqual([])
  })

  it('forces a row to stay UK-only', () => {
    const r = matchUk(usList, [row('A', 'X')], { match: {}, ukOnly: [ukRowKey(row('A', 'X'))] })
    expect(r.matches).toEqual([])
    expect(r.ukOnly).toHaveLength(1)
  })

  it('reports overrides naming a missing row or release', () => {
    const r = matchUk(usList, [row('A', 'X')], {
      match: { 'gone-lp': 'a-x', [ukRowKey(row('A', 'X'))]: 'nope' },
      ukOnly: ['gone-too'],
    })
    expect(r.staleOverrides.sort()).toEqual(['a-x-lp', 'gone-lp', 'gone-too'])
  })
})

describe('mergeUk', () => {
  it('returns the US list unchanged, without UK exclusives, when there is no UK list', () => {
    const plain = us('a-x', 'A', 'X')
    const old = us('z-q', 'Z', 'Q', { regions: ['uk'] })
    expect(mergeUk([plain, old], null, NONE).releases).toEqual([plain])
  })

  it('suffixes a UK exclusive whose id collides with a US release', () => {
    // Same artist and title, but the override keeps the UK row separate.
    const r = mergeUk([us('a-x', 'A', 'X')], list([row('A', 'X', '7"')]), {
      match: {},
      ukOnly: [ukRowKey(row('A', 'X', '7"'))],
    })
    expect(r.releases.map((x) => [x.id, x.regions])).toEqual([
      ['a-x', ['us']],
      ['a-x-uk', ['uk']],
    ])
  })

  it('writes a UK exclusive in the US list style', () => {
    const r = mergeUk([], list([row('Coral, The', 'Butterfly House', '12”', '')]), NONE)
    expect(r.releases[0]).toMatchObject({
      id: 'the-coral-butterfly-house',
      artist: 'The Coral',
      format: '12"',
      label: 'Unknown',
      category: 'exclusive',
      artFilename: 'the-coral-butterfly-house.jpg',
      regions: ['uk'],
    })
  })

  it('keeps what an earlier merge learned about a UK exclusive', () => {
    const prev = us('m-n', 'M', 'N', {
      regions: ['uk'],
      discogsMasterId: 99,
      description: 'Known',
      upc: '012345678905',
    })
    const r = mergeUk([], list([row('M', 'N')]), NONE, new Map([[prev.id, prev]]))
    expect(r.releases[0]).toMatchObject({
      discogsMasterId: 99,
      description: 'Known',
      upc: '012345678905',
    })
  })

  it('re-tags a release that left the UK list', () => {
    const r = mergeUk([us('a-x', 'A', 'X', { regions: ['us', 'uk'] })], list([row('B', 'Y')]), NONE)
    expect(r.releases.find((x) => x.id === 'a-x')?.regions).toEqual(['us'])
  })
})

describe('formatUkReport', () => {
  it('lists the matches to check and the exclusives', () => {
    const r = matchUk([us('a-x', 'A', 'X')], [row('A', 'X'), row('B', 'Y')], NONE)
    const md = formatUkReport(r, '2026-november')
    expect(md).toContain('1 on both lists, 1 UK exclusives.')
    expect(md).toContain('B — Y (LP) `b-y-lp`')
  })
})
