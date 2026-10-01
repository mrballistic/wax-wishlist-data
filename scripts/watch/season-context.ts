import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { type RawRelease, ReleaseListSchema, SeasonsListSchema } from '../types.js'

/** `2026-november` → `november`. "Same kind" means same suffix. */
export function seasonKind(seasonId: string): string {
  return seasonId.split('-').slice(1).join('-')
}

/** A published season's releases as RawRelease, or null if it has none. */
export async function loadReleasesAsRaw(repoRoot: string, seasonId: string): Promise<RawRelease[] | null> {
  let raw: string
  try {
    raw = await readFile(resolve(repoRoot, 'releases', seasonId, 'releases.json'), 'utf8')
  } catch {
    return null
  }
  return ReleaseListSchema.parse(JSON.parse(raw)).map(({ id, artist, title, label, format, category, description }) => ({
    id,
    artist,
    title,
    label,
    format,
    category,
    description,
  }))
}

/**
 * Gate comparisons for a season: its current list (making this a revision)
 * and the size of the latest other season of the same kind.
 */
export async function loadGateContext(
  repoRoot: string,
  seasonId: string,
): Promise<{ previousSameSeason: RawRelease[] | null; lastComparableCount: number | null }> {
  const previousSameSeason = await loadReleasesAsRaw(repoRoot, seasonId)
  const seasons = SeasonsListSchema.parse(JSON.parse(await readFile(resolve(repoRoot, 'seasons.json'), 'utf8')))
  const kind = seasonKind(seasonId)
  const comparable = seasons
    .filter((s) => s.id !== seasonId && seasonKind(s.id) === kind)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  for (const season of comparable) {
    const releases = await loadReleasesAsRaw(repoRoot, season.id)
    if (releases) return { previousSameSeason, lastComparableCount: releases.length }
  }
  return { previousSameSeason, lastComparableCount: null }
}
