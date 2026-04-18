import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  type CurrentSeason,
  CurrentSeasonSchema,
  type Release,
  ReleaseListSchema,
  type Season,
  SeasonsListSchema,
} from './types.js'

function stringifyStable(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeFileEnsuring(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

export async function writeCurrent(path: string, season: CurrentSeason): Promise<void> {
  const parsed = CurrentSeasonSchema.parse(season)
  await writeFileEnsuring(path, stringifyStable(parsed))
}

export async function writeSeasons(path: string, seasons: Season[]): Promise<void> {
  const parsed = SeasonsListSchema.parse(seasons)
  await writeFileEnsuring(path, stringifyStable(parsed))
}

export async function writeReleases(path: string, releases: Release[]): Promise<void> {
  const sorted = [...releases].sort((a, b) => {
    const byArtist = a.artist.localeCompare(b.artist, 'en', { sensitivity: 'base' })
    if (byArtist !== 0) return byArtist
    return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' })
  })
  const parsed = ReleaseListSchema.parse(sorted)
  await writeFileEnsuring(path, stringifyStable(parsed))
}
