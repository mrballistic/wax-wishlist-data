import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { refreshSeason } from '../scripts/refresh-season.js'
import type { SiteIndex } from '../scripts/rsd/site-index.js'

const release = (over: Record<string, unknown> = {}) => ({
  id: 'a-b',
  artist: 'A',
  title: 'B',
  label: 'L',
  format: 'LP',
  category: 'exclusive',
  description: '',
  discogsMasterId: 5,
  artFilename: 'a-b.jpg',
  ...over,
})

const current = (id: string) => ({
  id,
  label: 'X',
  date: '2026-11-27',
  status: 'upcoming',
  releasesUrl: 'https://example.com/r.json',
  artBaseUrl: 'https://example.com/art/',
})

let root: string
const NOW = '2026-10-02T00:00:00.000Z'

async function setup(currentId: string, releases = [release()]): Promise<void> {
  await mkdir(join(root, 'releases', '2026-november'), { recursive: true })
  await writeFile(join(root, 'releases', '2026-november', 'releases.json'), JSON.stringify(releases))
  await writeFile(join(root, 'current.json'), JSON.stringify(current(currentId)))
}

const index: SiteIndex = { seasonId: '2026-november', eventId: 1, entries: [] }
const releasesPath = (): string => join(root, 'releases', '2026-november', 'releases.json')
const siteIndexFor = (description: string): SiteIndex => ({
  seasonId: '2026-november',
  eventId: 1,
  entries: [
    {
      releaseId: '42',
      artist: 'Alpha',
      title: 'Bravo',
      photoId: 1,
      format: 'LP',
      label: 'L',
      description,
      tracklist: [],
      quantity: null,
      upc: null,
      pageUrl: 'https://recordstoreday.com/SpecialRelease/42',
    },
  ],
})
const readCurrent = async () => JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'refresh-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('refreshSeason', () => {
  it('writes nothing and does not stamp when data is unchanged; art still runs', async () => {
    await setup('2026-november')
    const before = await readFile(releasesPath(), 'utf8')
    const art = vi.fn(async () => {})
    const res = await refreshSeason(
      { repoRoot: root, seasonId: '2026-november', now: () => NOW },
      { siteIndex: async () => index, discogs: async (r) => r, art },
    )
    expect(res).toEqual({ dataChanged: false, stamped: false })
    expect(await readFile(releasesPath(), 'utf8')).toBe(before)
    expect((await readCurrent()).contentUpdatedAt).toBeUndefined()
    expect(art).toHaveBeenCalledTimes(1)
  })

  it('writes and stamps when changed for the current season', async () => {
    await setup('2026-november', [release({ discogsMasterId: null })])
    const art = vi.fn(async () => {})
    const res = await refreshSeason(
      { repoRoot: root, seasonId: '2026-november', now: () => NOW },
      {
        siteIndex: async () => null,
        discogs: async (rs) => rs.map((r) => ({ ...r, discogsMasterId: 99 })),
        art,
      },
    )
    expect(res).toEqual({ dataChanged: true, stamped: true })
    const written = JSON.parse(await readFile(join(root, 'releases', '2026-november', 'releases.json'), 'utf8'))
    expect(written[0].discogsMasterId).toBe(99)
    expect((await readCurrent()).contentUpdatedAt).toBe(NOW)
    expect(art).toHaveBeenCalledTimes(1)
  })

  it('writes but does not stamp for a non-current season', async () => {
    await setup('2027-april', [release({ discogsMasterId: null })])
    const art = vi.fn(async () => {})
    const res = await refreshSeason(
      { repoRoot: root, seasonId: '2026-november', now: () => NOW },
      {
        siteIndex: async () => null,
        discogs: async (rs) => rs.map((r) => ({ ...r, discogsMasterId: 99 })),
        art,
      },
    )
    expect(res).toEqual({ dataChanged: true, stamped: false })
    expect((await readCurrent()).contentUpdatedAt).toBeUndefined()
    expect(art).toHaveBeenCalledTimes(1)
  })

  it('writes and stamps a description the site index fills', async () => {
    await setup('2026-november', [release({ artist: 'Alpha', title: 'Bravo' })])
    const res = await refreshSeason(
      { repoRoot: root, seasonId: '2026-november', now: () => NOW },
      { siteIndex: async () => siteIndexFor('From the site'), discogs: async (r) => r, art: async () => {} },
    )
    expect(res).toEqual({ dataChanged: true, stamped: true })
    const written = JSON.parse(await readFile(releasesPath(), 'utf8'))
    expect(written[0]).toMatchObject({
      description: 'From the site',
      rsdUrl: 'https://recordstoreday.com/SpecialRelease/42',
    })
    expect((await readCurrent()).contentUpdatedAt).toBe(NOW)
  })

  it('keeps the site changes when Discogs throws', async () => {
    await setup('2026-november', [release({ artist: 'Alpha', title: 'Bravo', discogsMasterId: null })])
    const res = await refreshSeason(
      { repoRoot: root, seasonId: '2026-november', now: () => NOW },
      {
        siteIndex: async () => siteIndexFor('From the site'),
        discogs: async () => {
          throw new Error('discogs down')
        },
        art: async () => {},
      },
    )
    expect(res).toEqual({ dataChanged: true, stamped: true })
    const written = JSON.parse(await readFile(releasesPath(), 'utf8'))
    expect(written[0]).toMatchObject({ description: 'From the site', discogsMasterId: null })
  })

  it('keeps the data changes and resolves when the art cascade throws', async () => {
    await setup('2026-november', [release({ discogsMasterId: null })])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await refreshSeason(
      { repoRoot: root, seasonId: '2026-november', now: () => NOW },
      {
        siteIndex: async () => null,
        discogs: async (rs) => rs.map((r) => ({ ...r, discogsMasterId: 99 })),
        art: async () => {
          throw new Error('art down')
        },
      },
    )
    expect(res).toEqual({ dataChanged: true, stamped: true })
    expect(JSON.parse(await readFile(releasesPath(), 'utf8'))[0].discogsMasterId).toBe(99)
    expect(warn).toHaveBeenCalledWith('art cascade failed: art down')
    warn.mockRestore()
  })

  it('survives site and discogs failures and still runs art', async () => {
    await setup('2026-november', [release({ discogsMasterId: null })])
    const art = vi.fn(async () => {})
    const res = await refreshSeason(
      { repoRoot: root, seasonId: '2026-november', now: () => NOW },
      {
        siteIndex: async () => {
          throw new Error('boom')
        },
        discogs: async () => {
          throw new Error('boom')
        },
        art,
      },
    )
    expect(res.dataChanged).toBe(false)
    expect(art).toHaveBeenCalledTimes(1)
  })
})
