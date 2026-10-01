import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiscogsInput } from '../../scripts/enrich-discogs.js'
import { registerSeason } from '../../scripts/register-season.js'
import type { SiteIndex } from '../../scripts/rsd/site-index.js'
import type { Release } from '../../scripts/types.js'
import { publishSeason } from '../../scripts/watch/publish.js'
import { makeRelease, REPO_ROOT } from '../helpers/releases.js'

let repo: string
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'wwd-publish-'))
  await cp(join(REPO_ROOT, 'seasons.json'), join(repo, 'seasons.json'))
  await cp(join(REPO_ROOT, 'current.json'), join(repo, 'current.json'))
})

const enrich = async (raw: DiscogsInput[]): Promise<Release[]> =>
  raw.map((r) => ({ ...r, discogsMasterId: r.discogsMasterId ?? null, artFilename: `${r.id}.jpg` }))
const noSite = async (): Promise<SiteIndex | null> => null

describe('publishSeason', () => {
  it('writes releases, fetches art, and registers the season', async () => {
    const fetchArt = vi.fn(async () => {})
    const releases = [makeRelease(2), makeRelease(1)]
    await publishSeason(
      { repoRoot: repo, seasonId: '2026-november', date: '2026-11-27', releases },
      {
        enrich,
        fetchArt,
        register: (id, date, label, root) => registerSeason(id, date, label, root),
        siteIndex: noSite,
      },
    )

    const written = JSON.parse(await readFile(join(repo, 'releases/2026-november/releases.json'), 'utf8'))
    expect(written.map((r: Release) => r.id)).toEqual(['artist-1-title-1', 'artist-2-title-2'])
    expect(written[0].artFilename).toBe('artist-1-title-1.jpg')
    expect(fetchArt).toHaveBeenCalledWith(releases, '2026-november', repo)

    const seasons = JSON.parse(await readFile(join(repo, 'seasons.json'), 'utf8'))
    expect(seasons[0]).toMatchObject({ id: '2026-november', date: '2026-11-27', label: 'Black Friday Drop 2026' })
    const current = JSON.parse(await readFile(join(repo, 'current.json'), 'utf8'))
    expect(current.id).toBe('2026-november')
  })

  it('carries previous ids and site fields forward into enrichment on a revision', async () => {
    const dir = join(repo, 'releases/2026-november')
    await mkdir(dir, { recursive: true })
    const previous: Release[] = [
      {
        ...makeRelease(1),
        description: 'Old words',
        discogsMasterId: 111,
        artFilename: 'artist-1-title-1.jpg',
        tracklist: ['A1. One'],
        quantity: 500,
        upc: '012345678905',
        rsdUrl: 'https://recordstoreday.com/SpecialRelease/1',
      },
      { ...makeRelease(2), discogsMasterId: 222, artFilename: 'artist-2-title-2.jpg' },
    ]
    await writeFile(join(dir, 'releases.json'), JSON.stringify(previous))
    const seen: DiscogsInput[] = []
    const enrichSpy = async (raw: DiscogsInput[]): Promise<Release[]> => {
      seen.push(...raw)
      return enrich(raw)
    }

    await publishSeason(
      {
        repoRoot: repo,
        seasonId: '2026-november',
        date: '2026-11-27',
        releases: [makeRelease(1), makeRelease(2, { description: 'Fresh PDF words' }), makeRelease(3)],
      },
      { enrich: enrichSpy, fetchArt: async () => {}, register: async () => {}, siteIndex: noSite },
    )

    expect(seen.map((r) => r.discogsMasterId)).toEqual([111, 222, null])
    const written: Release[] = JSON.parse(await readFile(join(dir, 'releases.json'), 'utf8'))
    expect(written[0]).toMatchObject({
      description: 'Old words',
      discogsMasterId: 111,
      tracklist: ['A1. One'],
      quantity: 500,
      upc: '012345678905',
      rsdUrl: 'https://recordstoreday.com/SpecialRelease/1',
    })
    expect(written[1]).toMatchObject({ description: 'Fresh PDF words', discogsMasterId: 222 })
    expect(written[2]).toMatchObject({ discogsMasterId: null, description: '' })
    expect(written[2]).not.toHaveProperty('tracklist')
  })

  it('keeps a previous discogsMasterId when enrichment returns null', async () => {
    const dir = join(repo, 'releases/2026-november')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'releases.json'),
      JSON.stringify([{ ...makeRelease(1), discogsMasterId: 111, artFilename: 'artist-1-title-1.jpg' }]),
    )
    const forgetful = async (raw: DiscogsInput[]): Promise<Release[]> =>
      raw.map((r) => ({ ...r, discogsMasterId: null, artFilename: `${r.id}.jpg` }))
    await publishSeason(
      { repoRoot: repo, seasonId: '2026-november', date: '2026-11-27', releases: [makeRelease(1)] },
      { enrich: forgetful, fetchArt: async () => {}, register: async () => {}, siteIndex: noSite },
    )
    const written: Release[] = JSON.parse(await readFile(join(dir, 'releases.json'), 'utf8'))
    expect(written[0]?.discogsMasterId).toBe(111)
  })

  it('fills fields from the site index before Discogs, so the UPC reaches the lookup', async () => {
    const siteIndex = vi.fn(async (): Promise<SiteIndex | null> => ({
      seasonId: '2026-november',
      eventId: 599,
      entries: [
        {
          releaseId: '42',
          artist: 'Artist 1',
          title: 'Title 1',
          photoId: 9,
          format: 'LP',
          label: 'Label',
          description: 'From the site',
          tracklist: ['A1. Song'],
          quantity: 1500,
          upc: '075678604034',
          pageUrl: 'https://recordstoreday.com/SpecialRelease/42',
        },
      ],
    }))
    const seen: DiscogsInput[] = []
    const enrichSpy = async (raw: DiscogsInput[]): Promise<Release[]> => {
      seen.push(...raw)
      return enrich(raw)
    }
    await publishSeason(
      {
        repoRoot: repo,
        seasonId: '2026-november',
        date: '2026-11-27',
        releases: [makeRelease(1), makeRelease(2, { artist: 'Someone Else', title: 'Unrelated' })],
      },
      { enrich: enrichSpy, fetchArt: async () => {}, register: async () => {}, siteIndex },
    )
    expect(siteIndex).toHaveBeenCalledWith('2026-november', 2)
    expect(seen[0]?.upc).toBe('075678604034')
    const written: Release[] = JSON.parse(await readFile(join(repo, 'releases/2026-november/releases.json'), 'utf8'))
    expect(written[0]).toMatchObject({
      description: 'From the site',
      tracklist: ['A1. Song'],
      quantity: 1500,
      upc: '075678604034',
      rsdUrl: 'https://recordstoreday.com/SpecialRelease/42',
    })
    expect(written[1]).not.toHaveProperty('rsdUrl')
  })

  it('publishes without site enrichment when the index is null or fails', async () => {
    for (const siteIndex of [noSite, async (): Promise<SiteIndex | null> => Promise.reject(new Error('blocked'))]) {
      await publishSeason(
        { repoRoot: repo, seasonId: '2026-november', date: '2026-11-27', releases: [makeRelease(1)] },
        { enrich, fetchArt: async () => {}, register: async () => {}, siteIndex },
      )
      const written: Release[] = JSON.parse(await readFile(join(repo, 'releases/2026-november/releases.json'), 'utf8'))
      expect(written).toEqual([{ ...makeRelease(1), discogsMasterId: null, artFilename: 'artist-1-title-1.jpg' }])
    }
  })
})
