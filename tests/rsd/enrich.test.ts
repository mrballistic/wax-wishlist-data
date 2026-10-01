import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { enrichFromSite } from '../../scripts/rsd/enrich.js'
import {
  parseListing,
  parseTablePage,
  type SiteEntry,
  type SiteIndex,
} from '../../scripts/rsd/site-index.js'
import { type Release, ReleaseListSchema } from '../../scripts/types.js'
import { REPO_ROOT } from '../helpers/releases.js'

const AHA = 'a-ha-analogue-20th-anniversary-deluxe-edition'
const FIXTURES = join(REPO_ROOT, 'tests/fixtures/rsd-site')

let index: SiteIndex
let april: Release[]
beforeAll(async () => {
  const viewAll = await readFile(join(FIXTURES, 'promotional-event-601-view-all.html'), 'utf8')
  const table = parseTablePage(
    await readFile(join(FIXTURES, 'promotional-event-601-rsd-2026.html'), 'utf8'),
  )
  const entries: SiteEntry[] = parseListing(viewAll).map((e) => ({
    ...e,
    quantity: table.get(e.releaseId)?.quantity ?? null,
    upc: table.get(e.releaseId)?.upc ?? null,
  }))
  index = { seasonId: '2026-april', eventId: 601, entries }
  april = ReleaseListSchema.parse(
    JSON.parse(await readFile(join(REPO_ROOT, 'releases/2026-april/releases.json'), 'utf8')),
  )
})

const entry = (over: Partial<SiteEntry>): SiteEntry => ({
  releaseId: '1',
  artist: 'Artist',
  title: 'Title',
  photoId: 1,
  format: 'LP',
  label: 'Label',
  description: 'Site description',
  tracklist: ['A1. One'],
  quantity: 1000,
  upc: '012345678905',
  pageUrl: 'https://recordstoreday.com/SpecialRelease/1',
  ...over,
})

const release = (over: Partial<Release>): Release => ({
  id: 'artist-title',
  artist: 'Artist',
  title: 'Title',
  label: 'Label',
  format: 'LP',
  category: 'exclusive',
  description: '',
  discogsMasterId: null,
  artFilename: 'artist-title.jpg',
  ...over,
})

describe('enrichFromSite', () => {
  it('fills the a-ha description, tracklist and RSD link from the 601 listing', () => {
    const { releases } = enrichFromSite(april, index, april)
    const aha = releases.find((r) => r.id === AHA)
    expect(aha?.description.startsWith("Analogue is a-ha's eighth studio album")).toBe(true)
    expect(aha?.tracklist).toContain('A1. CELICE (2026 REMASTER)')
    expect(aha?.rsdUrl).toBe('https://recordstoreday.com/SpecialRelease/19926')
    expect(() => ReleaseListSchema.parse(releases)).not.toThrow()
  })

  it('reports how much of 2026-april it fills', () => {
    const { releases, changed } = enrichFromSite(april, index, april)
    const count = (f: (r: Release) => boolean): number => releases.filter(f).length
    const counts = {
      changed,
      description: count((r) => r.description !== ''),
      tracklist: count((r) => (r.tracklist?.length ?? 0) > 0),
      quantity: count((r) => r.quantity != null),
      upc: count((r) => r.upc != null),
      rsdUrl: count((r) => r.rsdUrl != null),
    }
    // 353 releases; the same 342 the art tier matches on these fixtures.
    expect(counts).toEqual({
      changed: 342,
      description: 324,
      tracklist: 294,
      quantity: 338,
      upc: 342,
      rsdUrl: 342,
    })
  })

  it('never overwrites a preset description or UPC', () => {
    const preset = april.map((r) =>
      r.id === AHA ? { ...r, description: 'Ours', upc: '00000000' } : r,
    )
    const aha = enrichFromSite(preset, index, preset).releases.find((r) => r.id === AHA)
    expect(aha?.description).toBe('Ours')
    expect(aha?.upc).toBe('00000000')
    expect(aha?.rsdUrl).toBe('https://recordstoreday.com/SpecialRelease/19926')
  })

  it('leaves unmatched releases untouched and counts only changed ones', () => {
    const matched = release({})
    const unmatched = release({ id: 'nobody-nothing', artist: 'Nobody', title: 'Nothing At All' })
    const full = release({
      id: 'full-house',
      artist: 'Full',
      title: 'House',
      description: 'd',
      tracklist: ['t'],
      quantity: 5,
      upc: '11111111',
      rsdUrl: 'https://example.com/x',
    })
    const idx: SiteIndex = {
      seasonId: '2026-april',
      eventId: 1,
      entries: [entry({}), entry({ releaseId: '2', artist: 'Full', title: 'House', photoId: 2 })],
    }
    const season = [matched, unmatched, full]
    const { releases, changed } = enrichFromSite(season, idx, season)
    expect(changed).toBe(1)
    expect(releases[0]).toMatchObject({
      description: 'Site description',
      tracklist: ['A1. One'],
      quantity: 1000,
      upc: '012345678905',
      rsdUrl: 'https://recordstoreday.com/SpecialRelease/1',
    })
    expect(releases[1]).toEqual(unmatched)
    expect(releases[2]).toEqual(full)
  })

  it('fills from releases that share a placeholder photo (photo ids are not identity)', () => {
    const a = release({ id: 'alpha-one', artist: 'Alpha', title: 'One' })
    const b = release({ id: 'beta-two', artist: 'Beta', title: 'Two' })
    const idx: SiteIndex = {
      seasonId: '2026-april',
      eventId: 1,
      entries: [
        entry({
          releaseId: '10',
          artist: 'Alpha',
          title: 'One',
          photoId: 7,
          pageUrl: 'https://recordstoreday.com/SpecialRelease/10',
        }),
        entry({
          releaseId: '11',
          artist: 'Beta',
          title: 'Two',
          photoId: 7,
          pageUrl: 'https://recordstoreday.com/SpecialRelease/11',
        }),
      ],
    }
    const { releases, changed } = enrichFromSite([a, b], idx, [a, b])
    expect(changed).toBe(2)
    expect(releases.map((r) => r.rsdUrl)).toEqual([
      'https://recordstoreday.com/SpecialRelease/10',
      'https://recordstoreday.com/SpecialRelease/11',
    ])
  })

  it('skips site values that would break the contract', () => {
    const idx: SiteIndex = {
      seasonId: '2026-april',
      eventId: 1,
      entries: [entry({ upc: '12', quantity: 0, tracklist: ['', ' '], description: '  ' })],
    }
    const { releases } = enrichFromSite([release({})], idx, [release({})])
    expect(releases[0]?.upc).toBeUndefined()
    expect(releases[0]?.quantity).toBeUndefined()
    expect(releases[0]?.tracklist).toBeUndefined()
    expect(releases[0]?.description).toBe('')
    expect(releases[0]?.rsdUrl).toBe('https://recordstoreday.com/SpecialRelease/1')
  })

  it('never throws on bad data', () => {
    const bad = { seasonId: 'x', eventId: 1, entries: [null] } as unknown as SiteIndex
    const input = [release({})]
    expect(enrichFromSite(input, bad, input)).toEqual({ releases: input, changed: 0 })
  })
})
