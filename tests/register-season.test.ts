import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerSeason } from '../scripts/register-season.js'

const BASE_URL =
  'https://raw.githubusercontent.com/mrballistic/wax-wishlist-data/main/releases'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

interface SeasonShape {
  id: string
  label: string
  date: string
  status: string
  releasesUrl: string
  artBaseUrl: string
}

describe('registerSeason', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'wwd-register-'))
    await mkdir(repo, { recursive: true })
    await writeJson(join(repo, 'current.json'), {
      id: '2026-april',
      label: 'April Drop 2026',
      date: '2026-04-18',
      status: 'active',
      releasesUrl: `${BASE_URL}/2026-april/releases.json`,
      artBaseUrl: `${BASE_URL}/2026-april/art/`,
    })
    await writeJson(join(repo, 'seasons.json'), [
      {
        id: '2026-april',
        label: 'April Drop 2026',
        date: '2026-04-18',
        status: 'active',
        releasesUrl: `${BASE_URL}/2026-april/releases.json`,
        artBaseUrl: `${BASE_URL}/2026-april/art/`,
      },
      {
        id: '2025-april',
        label: 'April Drop 2025',
        date: '2025-04-19',
        status: 'past',
        releasesUrl: `${BASE_URL}/2025-april/releases.json`,
        artBaseUrl: `${BASE_URL}/2025-april/art/`,
      },
    ])
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('promotes a strictly-newer season to current.json and prepends to seasons.json', async () => {
    const { registered, promotedToCurrent } = await registerSeason(
      '2027-april',
      '2027-04-17',
      undefined,
      repo,
    )
    expect(promotedToCurrent).toBe(true)
    expect(registered.label).toBe('April Drop 2027')
    expect(registered.status).toBe('upcoming')
    expect(registered.releasesUrl).toBe(`${BASE_URL}/2027-april/releases.json`)

    const current = await readJson<SeasonShape>(join(repo, 'current.json'))
    expect(current.id).toBe('2027-april')

    const seasons = await readJson<SeasonShape[]>(join(repo, 'seasons.json'))
    expect(seasons.map((s) => s.id)).toEqual(['2027-april', '2026-april', '2025-april'])
  })

  it('derives "Black Friday Drop" for November seasons', async () => {
    const { registered } = await registerSeason(
      '2027-november',
      '2027-11-26',
      undefined,
      repo,
    )
    expect(registered.label).toBe('Black Friday Drop 2027')
  })

  it('leaves current.json untouched when the new date is not strictly later', async () => {
    const { promotedToCurrent } = await registerSeason(
      '2025-april',
      '2025-04-19',
      undefined,
      repo,
    )
    expect(promotedToCurrent).toBe(false)
    const current = await readJson<SeasonShape>(join(repo, 'current.json'))
    expect(current.id).toBe('2026-april')
  })

  it('preserves the existing status when re-registering an existing id', async () => {
    const { registered } = await registerSeason(
      '2025-april',
      '2025-04-19',
      undefined,
      repo,
    )
    expect(registered.status).toBe('past')
  })

  it('requires --label for seasons whose id cannot be derived', async () => {
    await expect(
      registerSeason('2027-summer-drop-2', '2027-07-04', undefined, repo),
    ).rejects.toThrow(/Cannot derive a human label/)
  })

  it('accepts an explicit label override', async () => {
    const { registered } = await registerSeason(
      '2027-summer-drop-2',
      '2027-07-04',
      'Summer Bonus Drop 2027',
      repo,
    )
    expect(registered.label).toBe('Summer Bonus Drop 2027')
    expect(registered.id).toBe('2027-summer-drop-2')
  })

  it('keeps seasons.json sorted newest-first after an upsert', async () => {
    await registerSeason('2025-november', '2025-11-28', undefined, repo)
    const seasons = await readJson<SeasonShape[]>(join(repo, 'seasons.json'))
    expect(seasons.map((s) => s.id)).toEqual([
      '2026-april',
      '2025-november',
      '2025-april',
    ])
  })
})
