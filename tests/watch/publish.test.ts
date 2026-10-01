import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerSeason } from '../../scripts/register-season.js'
import type { RawRelease, Release } from '../../scripts/types.js'
import { publishSeason } from '../../scripts/watch/publish.js'
import { makeRelease, REPO_ROOT } from '../helpers/releases.js'

let repo: string
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'wwd-publish-'))
  await cp(join(REPO_ROOT, 'seasons.json'), join(repo, 'seasons.json'))
  await cp(join(REPO_ROOT, 'current.json'), join(repo, 'current.json'))
})

const enrich = async (raw: RawRelease[]): Promise<Release[]> =>
  raw.map((r) => ({ ...r, discogsMasterId: null, artFilename: `${r.id}.jpg` }))

describe('publishSeason', () => {
  it('writes releases, fetches art, and registers the season', async () => {
    const fetchArt = vi.fn(async () => {})
    const releases = [makeRelease(2), makeRelease(1)]
    await publishSeason(
      { repoRoot: repo, seasonId: '2026-november', date: '2026-11-27', releases },
      { enrich, fetchArt, register: (id, date, label, root) => registerSeason(id, date, label, root) },
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

  it('keeps a previous discogsMasterId on a revision when enrichment returns null', async () => {
    const dir = join(repo, 'releases/2026-november')
    await mkdir(dir, { recursive: true })
    const previous: Release[] = [
      { ...makeRelease(1), discogsMasterId: 111, artFilename: 'artist-1-title-1.jpg' },
      { ...makeRelease(2), discogsMasterId: 222, artFilename: 'artist-2-title-2.jpg' },
    ]
    await writeFile(join(dir, 'releases.json'), JSON.stringify(previous))
    const enrichWithOneHit = async (raw: RawRelease[]): Promise<Release[]> =>
      raw.map((r) => ({
        ...r,
        discogsMasterId: r.id === 'artist-2-title-2' ? 999 : null,
        artFilename: `${r.id}.jpg`,
      }))

    await publishSeason(
      {
        repoRoot: repo,
        seasonId: '2026-november',
        date: '2026-11-27',
        releases: [makeRelease(1), makeRelease(2), makeRelease(3)],
      },
      { enrich: enrichWithOneHit, fetchArt: async () => {}, register: async () => {} },
    )

    const written: Release[] = JSON.parse(await readFile(join(dir, 'releases.json'), 'utf8'))
    expect(Object.fromEntries(written.map((r) => [r.id, r.discogsMasterId]))).toEqual({
      'artist-1-title-1': 111, // carried forward
      'artist-2-title-2': 999, // fresh lookup wins
      'artist-3-title-3': null, // new release, nothing to carry
    })
  })
})
