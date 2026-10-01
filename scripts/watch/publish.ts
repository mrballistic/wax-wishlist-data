import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { unlockerFromEnv } from '../art/brightdata.js'
import { writeArtCandidates } from '../art/candidates.js'
import { type DiscogsInput, enrichDiscogs } from '../enrich-discogs.js'
import { formatCoverageSummary, runArtCascade } from '../fetch-art.js'
import { writeReleases } from '../generate-json.js'
import { registerSeason } from '../register-season.js'
import { enrichFromSite, isEmpty } from '../rsd/enrich.js'
import { getSiteIndex, type SiteIndex } from '../rsd/site-index.js'
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
  enrich: (releases: DiscogsInput[]) => Promise<Release[]>
  fetchArt: (releases: RawRelease[], seasonId: string, repoRoot: string) => Promise<void>
  register: (seasonId: string, date: string, label: string | undefined, repoRoot: string) => Promise<unknown>
  /** The season's recordstoreday.com index, or null when it isn't available. */
  siteIndex: (seasonId: string, expectedCount: number) => Promise<SiteIndex | null>
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
  siteIndex: (seasonId, expectedCount) => getSiteIndex({ seasonId, expectedCount, unlocker: unlockerFromEnv() }),
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

/** Fields a revision keeps from the previous releases.json when the new value is empty. */
const CARRIED = ['description', 'tracklist', 'quantity', 'upc', 'rsdUrl', 'discogsMasterId'] as const

/** A raw release as a Release with defaults, plus whatever the previous publish already knew. */
function withPrevious(raw: RawRelease, previous: Release | undefined): Release {
  const out: Release = { ...raw, discogsMasterId: null, artFilename: `${raw.id}.jpg` }
  if (!previous) return out
  const fields: Partial<Release> = {}
  for (const key of CARRIED) {
    if (isEmpty(out[key]) && !isEmpty(previous[key])) Object.assign(fields, { [key]: previous[key] })
  }
  return { ...out, ...fields }
}

/**
 * Publish a gate-passed list: carry forward what the previous releases.json
 * knew, fill empty fields from recordstoreday.com, look up Discogs ids (UPC
 * first), write releases.json, run the art cascade (empty slots only), then
 * announce the season in seasons.json/current.json. The caller validates and
 * commits.
 *
 * On a revision, a description, tracklist, quantity, UPC, RSD link or Discogs
 * id that was found before is carried forward when the new value is empty, so
 * a revision never loses enrichment it already had. Site enrichment is skipped
 * with one log line when the index is unavailable or fails.
 */
export async function publishSeason(input: PublishInput, deps: PublishDeps = defaultPublishDeps): Promise<void> {
  const path = resolve(input.repoRoot, 'releases', input.seasonId, 'releases.json')
  const previous = new Map((await loadExisting(path)).map((r) => [r.id, r]))
  let releases = input.releases.map((r) => withPrevious(r, previous.get(r.id)))

  try {
    const index = await deps.siteIndex(input.seasonId, releases.length)
    if (index) {
      const result = enrichFromSite(releases, index, input.releases)
      releases = result.releases
      console.log(`rsd-site: enriched ${result.changed} of ${releases.length} releases`)
    } else {
      console.log('rsd-site: no site index; enrichment skipped')
    }
  } catch (err) {
    console.log(`rsd-site: enrichment skipped (${err instanceof Error ? err.message : String(err)})`)
  }

  const enriched = (await deps.enrich(releases)).map((r) =>
    r.discogsMasterId === null ? { ...r, discogsMasterId: previous.get(r.id)?.discogsMasterId ?? null } : r,
  )
  await writeReleases(path, enriched)
  await deps.fetchArt(input.releases, input.seasonId, input.repoRoot)
  await deps.register(input.seasonId, input.date, input.label, input.repoRoot)
}
