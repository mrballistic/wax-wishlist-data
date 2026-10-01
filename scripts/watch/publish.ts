import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { writeArtCandidates } from '../art/candidates.js'
import { enrichDiscogs } from '../enrich-discogs.js'
import { formatCoverageSummary, runArtCascade } from '../fetch-art.js'
import { writeReleases } from '../generate-json.js'
import { registerSeason } from '../register-season.js'
import { type RawRelease, type Release, ReleaseListSchema } from '../types.js'

export interface PublishInput {
  repoRoot: string
  seasonId: string
  date: string
  /** Defaults to the label register-season derives ("Black Friday Drop 2026"). */
  label?: string | undefined
  releases: RawRelease[]
}

export interface PublishDeps {
  enrich: (releases: RawRelease[]) => Promise<Release[]>
  fetchArt: (releases: RawRelease[], seasonId: string, repoRoot: string) => Promise<void>
  register: (seasonId: string, date: string, label: string | undefined, repoRoot: string) => Promise<unknown>
}

async function fetchArt(releases: RawRelease[], seasonId: string, repoRoot: string): Promise<void> {
  const summary = await runArtCascade(releases, {
    artDir: resolve(repoRoot, 'releases', seasonId, 'art'),
    manualArtDir: resolve(repoRoot, 'manual-art'),
    discogsConsumerKey: process.env['DISCOGS_CONSUMER_KEY'],
    discogsConsumerSecret: process.env['DISCOGS_CONSUMER_SECRET'],
    metabrainzAccessToken: process.env['METABRAINZ_ACCESS_TOKEN'],
    seasonId,
  })
  console.log(formatCoverageSummary(summary))
  // Suggestions are a convenience for art-admin; never let them block a publish.
  try {
    const outcome = await writeArtCandidates(resolve(repoRoot, 'releases', seasonId), summary.suggestions)
    console.log(`art-candidates.json: ${outcome} (${summary.suggestions.size} releases with suggestions)`)
  } catch (err) {
    console.warn(`art-candidates.json: not written (${(err as Error).message})`)
  }
}

export const defaultPublishDeps: PublishDeps = {
  enrich: enrichDiscogs,
  fetchArt,
  register: (seasonId, date, label, repoRoot) => registerSeason(seasonId, date, label, repoRoot),
}

/** The season's current releases.json, or [] for a new season. */
async function loadExisting(path: string): Promise<Release[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return ReleaseListSchema.parse(JSON.parse(raw))
}

/**
 * Publish a gate-passed list: Discogs ids, releases.json, the art cascade
 * (empty slots only), then announce the season in seasons.json/current.json.
 * The caller validates and commits.
 *
 * On a revision, a Discogs id that was found before is carried forward when
 * this lookup comes back empty (rate limit, missing credentials, flaky
 * search), so a revision never loses enrichment it already had.
 */
export async function publishSeason(input: PublishInput, deps: PublishDeps = defaultPublishDeps): Promise<void> {
  const path = resolve(input.repoRoot, 'releases', input.seasonId, 'releases.json')
  const previousIds = new Map((await loadExisting(path)).map((r) => [r.id, r.discogsMasterId]))
  const enriched = (await deps.enrich(input.releases)).map((r) =>
    r.discogsMasterId === null ? { ...r, discogsMasterId: previousIds.get(r.id) ?? null } : r,
  )
  await writeReleases(path, enriched)
  await deps.fetchArt(input.releases, input.seasonId, input.repoRoot)
  await deps.register(input.seasonId, input.date, input.label, input.repoRoot)
}
