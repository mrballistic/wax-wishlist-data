import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { unlockerFromEnv } from './art/brightdata.js'
import { writeArtCandidates } from './art/candidates.js'
import { enrichDiscogs } from './enrich-discogs.js'
import { formatCoverageSummary, runArtCascade } from './fetch-art.js'
import { writeCurrent, writeReleases } from './generate-json.js'
import { enrichFromSite } from './rsd/enrich.js'
import { getSiteIndex, type SiteIndex } from './rsd/site-index.js'
import { CurrentSeasonSchema, type RawRelease, type Release, ReleaseListSchema } from './types.js'

export interface RefreshDeps {
  siteIndex: (opts: { seasonId: string; expectedCount: number }) => Promise<SiteIndex | null>
  discogs: (releases: Release[]) => Promise<Release[]>
  art: (opts: { repoRoot: string; seasonId: string; releases: RawRelease[] }) => Promise<void>
}

const defaultDeps: RefreshDeps = {
  siteIndex: (o) => getSiteIndex({ ...o, unlocker: unlockerFromEnv() }),
  discogs: (releases) => enrichDiscogs(releases),
  art: async ({ repoRoot, seasonId, releases }) => {
    const summary = await runArtCascade(releases, {
      artDir: resolve(repoRoot, 'releases', seasonId, 'art'),
      manualArtDir: resolve(repoRoot, 'manual-art'),
      discogsConsumerKey: process.env['DISCOGS_CONSUMER_KEY'],
      discogsConsumerSecret: process.env['DISCOGS_CONSUMER_SECRET'],
      metabrainzAccessToken: process.env['METABRAINZ_ACCESS_TOKEN'],
      seasonId,
    })
    console.log(formatCoverageSummary(summary))
    const outcome = await writeArtCandidates(resolve(repoRoot, 'releases', seasonId), summary.suggestions)
    console.log(`art-candidates.json: ${outcome} (${summary.suggestions.size} releases with suggestions)`)
  },
}

function toRaw(r: Release): RawRelease {
  return {
    id: r.id,
    artist: r.artist,
    title: r.title,
    label: r.label,
    format: r.format,
    category: r.category,
    description: r.description ?? '',
  }
}

export async function refreshSeason(
  opts: { repoRoot: string; seasonId: string; now?: () => string },
  deps: Partial<RefreshDeps> = {},
): Promise<{ dataChanged: boolean; stamped: boolean }> {
  const d = { ...defaultDeps, ...deps }
  const now = opts.now ?? (() => new Date().toISOString())
  const releasesPath = resolve(opts.repoRoot, 'releases', opts.seasonId, 'releases.json')
  const original = ReleaseListSchema.parse(JSON.parse(await readFile(releasesPath, 'utf8')))
  let releases = original
  const season = original.map(toRaw)

  try {
    const index = await d.siteIndex({ seasonId: opts.seasonId, expectedCount: original.length })
    if (index) {
      const res = enrichFromSite(releases, index, season)
      releases = res.releases
      console.log(`site: filled ${res.changed} releases`)
    } else {
      console.log('site: no index available; skipping')
    }
  } catch (err) {
    console.warn(`site enrichment failed: ${(err as Error).message}`)
  }

  try {
    const needing = releases.filter((r) => r.discogsMasterId == null)
    if (needing.length > 0) {
      const found = new Map((await d.discogs(needing)).map((r) => [r.id, r]))
      releases = releases.map((r) => found.get(r.id) ?? r)
    }
  } catch (err) {
    console.warn(`discogs enrichment failed: ${(err as Error).message}`)
  }

  const dataChanged = JSON.stringify(releases) !== JSON.stringify(original)
  let stamped = false
  if (dataChanged) {
    await writeReleases(releasesPath, releases)
    const currentPath = resolve(opts.repoRoot, 'current.json')
    try {
      const current = CurrentSeasonSchema.parse(JSON.parse(await readFile(currentPath, 'utf8')))
      if (current.id === opts.seasonId) {
        await writeCurrent(currentPath, { ...current, contentUpdatedAt: now() })
        stamped = true
      }
    } catch (err) {
      console.warn(`current.json not stamped: ${(err as Error).message}`)
    }
  }

  await d.art({ repoRoot: opts.repoRoot, seasonId: opts.seasonId, releases: releases.map(toRaw) })
  return { dataChanged, stamped }
}

async function main(): Promise<void> {
  const seasonId = process.argv[2]
  if (!seasonId) {
    console.error('Usage: pnpm tsx scripts/refresh-season.ts <season-id>')
    process.exit(1)
    return
  }
  const res = await refreshSeason({ repoRoot: resolve(process.cwd()), seasonId })
  console.log(`dataChanged=${res.dataChanged} stamped=${res.stamped}`)
}

function isInvokedAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (entry.includes('vitest') || entry.includes('node_modules')) return false
  return entry.endsWith('refresh-season.ts') || entry.endsWith('refresh-season.js')
}

if (isInvokedAsCli()) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
