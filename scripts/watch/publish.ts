import { resolve } from 'node:path'

import { enrichDiscogs } from '../enrich-discogs.js'
import { formatCoverageSummary, runArtCascade } from '../fetch-art.js'
import { writeReleases } from '../generate-json.js'
import { registerSeason } from '../register-season.js'
import type { RawRelease, Release } from '../types.js'

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
  })
  console.log(formatCoverageSummary(summary))
}

export const defaultPublishDeps: PublishDeps = {
  enrich: enrichDiscogs,
  fetchArt,
  register: (seasonId, date, label, repoRoot) => registerSeason(seasonId, date, label, repoRoot),
}

/**
 * Publish a gate-passed list: Discogs ids, releases.json, the art cascade
 * (empty slots only), then announce the season in seasons.json/current.json.
 * The caller validates and commits.
 */
export async function publishSeason(input: PublishInput, deps: PublishDeps = defaultPublishDeps): Promise<void> {
  const enriched = await deps.enrich(input.releases)
  await writeReleases(resolve(input.repoRoot, 'releases', input.seasonId, 'releases.json'), enriched)
  await deps.fetchArt(input.releases, input.seasonId, input.repoRoot)
  await deps.register(input.seasonId, input.date, input.label, input.repoRoot)
}
