import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeCurrent, writeReleases, writeSeasons } from '../scripts/generate-json.js'
import { ReleaseListSchema } from '../scripts/types.js'

const CURRENT = {
  id: '2026-april',
  label: 'April Drop 2026',
  date: '2026-04-18',
  status: 'upcoming' as const,
  releasesUrl:
    'https://raw.githubusercontent.com/mrballistic/wax-wishlist-data/main/releases/2026-april/releases.json',
  artBaseUrl:
    'https://raw.githubusercontent.com/mrballistic/wax-wishlist-data/main/releases/2026-april/art/',
}

const UNSORTED_RELEASES = [
  {
    id: 'c',
    artist: 'Zebra',
    title: 'A',
    label: 'L',
    format: 'LP',
    category: 'Exclusive',
    description: '',
    discogsMasterId: null,
    artFilename: null,
  },
  {
    id: 'a',
    artist: 'Apple',
    title: 'Z',
    label: 'L',
    format: 'LP',
    category: 'Exclusive',
    description: '',
    discogsMasterId: 1,
    artFilename: 'a.jpg',
  },
  {
    id: 'b',
    artist: 'apple',
    title: 'A',
    label: 'L',
    format: 'LP',
    category: 'Exclusive',
    description: '',
    discogsMasterId: 2,
    artFilename: 'b.jpg',
  },
]

describe('generate-json', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wax-wishlist-data-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writeCurrent produces 2-space indent with trailing newline', async () => {
    const path = join(dir, 'current.json')
    await writeCurrent(path, CURRENT)
    const text = await readFile(path, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "id": "2026-april"')
    expect(JSON.parse(text)).toEqual(CURRENT)
  })

  it('writeSeasons round-trips an array', async () => {
    const path = join(dir, 'seasons.json')
    await writeSeasons(path, [CURRENT])
    const text = await readFile(path, 'utf8')
    expect(JSON.parse(text)).toEqual([CURRENT])
  })

  it('writeReleases sorts by artist then title, case-insensitive', async () => {
    const path = join(dir, 'releases.json')
    await writeReleases(path, UNSORTED_RELEASES)
    const text = await readFile(path, 'utf8')
    const parsed = ReleaseListSchema.parse(JSON.parse(text))
    expect(parsed.map((r) => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('writeReleases output is deterministic across runs', async () => {
    const pathA = join(dir, 'a.json')
    const pathB = join(dir, 'b.json')
    await writeReleases(pathA, UNSORTED_RELEASES)
    await writeReleases(pathB, [...UNSORTED_RELEASES].reverse())
    const a = await readFile(pathA, 'utf8')
    const b = await readFile(pathB, 'utf8')
    expect(a).toBe(b)
  })
})
