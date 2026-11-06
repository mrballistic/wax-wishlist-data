import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { writeArtCandidates } from './art/candidates.js'
import { applyDiscogsOverrides, isPinned, loadDiscogsOverrides } from './discogs-overrides.js'
import { enrichDiscogs } from './enrich-discogs.js'
import { formatCoverageSummary, runArtCascade } from './fetch-art.js'
import { writeCurrent, writeReleases } from './generate-json.js'
import {
  CurrentSeasonSchema,
  type RawRelease,
  type Release,
  ReleaseListSchema,
  toRawRelease,
  type UkList,
} from './types.js'
import { loadUkList, loadUkOverrides, writeUkList } from './uk/files.js'
import { formatUkReport, mergeUk, type UkMatchResult } from './uk/merge.js'
import { parseUkPdf } from './uk/parse.js'
import { createUkSite, enrichFromUkSite, type UkSite } from './uk/site.js'

/** Fewer rows than this means the parse went wrong, not a short list (2026 Black Friday: 151). */
export const MIN_UK_ROWS = 20
/** Share of UK rows that must match the US list (2026 Black Friday: 74%). */
export const MIN_MATCH_SHARE = 0.3

/** The UK list barely overlaps the US one: almost certainly another event's PDF. */
export class UkListMismatchError extends Error {
  override name = 'UkListMismatchError'
}

export interface IngestUkDeps {
  fetchPdf: (url: string) => Promise<Buffer>
  parse: (pdf: Buffer) => Promise<UkList['rows']>
  discogs: (releases: Release[]) => Promise<Release[]>
  art: (opts: { repoRoot: string; seasonId: string; releases: RawRelease[] }) => Promise<void>
  now: () => string
  log: (line: string) => void
  /** recordstoreday.co.uk, for UK exclusives' descriptions, links and covers. */
  ukSite: () => UkSite
}

const defaultDeps: IngestUkDeps = {
  fetchPdf: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`)
    return Buffer.from(await res.arrayBuffer())
  },
  parse: parseUkPdf,
  discogs: enrichDiscogs,
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
    const outcome = await writeArtCandidates(
      resolve(repoRoot, 'releases', seasonId),
      summary.suggestions,
    )
    console.log(
      `art-candidates.json: ${outcome} (${summary.suggestions.size} releases with suggestions)`,
    )
  },
  now: () => new Date().toISOString(),
  log: (line) => console.log(line),
  ukSite: () => createUkSite(),
}

export interface IngestUkOptions {
  repoRoot: string
  seasonId: string
  /** Download and parse this PDF; omit to re-merge the saved uk.json (after editing uk-overrides.json). */
  pdfUrl?: string | undefined
  /** Report only: write nothing. */
  dryRun?: boolean
  /** The PDF's ETag (from the watcher's HEAD), saved in uk.json to spot revisions. */
  etag?: string | undefined
}

/**
 * Merge recordstoreday.co.uk's list into a published season: tag every
 * release with `regions`, append the UK exclusives, fill them from
 * recordstoreday.co.uk (description, page link, cover), look up Discogs ids
 * and the rest of their art, and stamp current.json. The season's US list must
 * already be published. Returns the match result for reporting.
 */
export async function ingestUk(
  opts: IngestUkOptions,
  deps: Partial<IngestUkDeps> = {},
): Promise<UkMatchResult> {
  const d = { ...defaultDeps, ...deps }
  const releasesPath = resolve(opts.repoRoot, 'releases', opts.seasonId, 'releases.json')
  let existing: Release[]
  try {
    existing = ReleaseListSchema.parse(JSON.parse(await readFile(releasesPath, 'utf8')))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${opts.seasonId} has no releases.json: publish the US list first.`)
    }
    throw err
  }

  let uk: UkList
  if (opts.pdfUrl) {
    const rows = await d.parse(await d.fetchPdf(opts.pdfUrl))
    if (rows.length < MIN_UK_ROWS) {
      throw new Error(
        `Parsed only ${rows.length} rows from ${opts.pdfUrl} (expected at least ${MIN_UK_ROWS}); nothing written.`,
      )
    }
    uk = {
      sourceUrl: opts.pdfUrl,
      ...(opts.etag ? { etag: opts.etag } : {}),
      fetchedAt: d.now(),
      rows,
    }
  } else {
    const saved = await loadUkList(opts.repoRoot, opts.seasonId)
    if (!saved) throw new Error(`${opts.seasonId} has no uk.json yet: pass the UK PDF URL.`)
    uk = saved
  }

  const previous = new Map(existing.map((r) => [r.id, r]))
  const { releases: merged, result } = mergeUk(
    existing,
    uk,
    await loadUkOverrides(opts.repoRoot, opts.seasonId),
    previous,
  )
  if (!result) throw new Error('unreachable: merge without a UK list')
  d.log(
    `${uk.rows.length} UK rows: ${result.matches.length} on both lists, ${result.ukOnly.length} UK exclusives`,
  )

  // A list that barely overlaps the US one is the wrong event (e.g. last
  // year's PDF still linked), not a list of mostly UK exclusives.
  const share = result.matches.length / uk.rows.length
  if (opts.pdfUrl && share < MIN_MATCH_SHARE) {
    throw new UkListMismatchError(
      `Only ${result.matches.length} of ${uk.rows.length} UK rows match ${opts.seasonId}'s US list ` +
        `(${Math.round(share * 100)}%, need ${MIN_MATCH_SHARE * 100}%): probably another event's PDF; nothing written.`,
    )
  }

  if (opts.dryRun) return result

  // Discogs only for UK exclusives without an id; the US list is the
  // watcher's and the daily refresh's business. Hand fixes in
  // discogs-overrides.json apply before and after, as in publish.
  const overrides = await loadDiscogsOverrides(opts.repoRoot, opts.seasonId)
  let releases = applyDiscogsOverrides(merged, overrides)
  const needing = releases.filter(
    (r) =>
      r.regions?.length === 1 &&
      r.regions[0] === 'uk' &&
      r.discogsMasterId === null &&
      !isPinned(r.id, overrides),
  )
  if (needing.length > 0) {
    try {
      const found = new Map((await d.discogs(needing)).map((r) => [r.id, r]))
      releases = applyDiscogsOverrides(
        releases.map((r) => {
          const f = found.get(r.id)
          return f ? { ...r, discogsMasterId: f.discogsMasterId } : r
        }),
        overrides,
      )
    } catch (err) {
      d.log(`discogs lookup failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`)
    }
  }

  // Before the cascade, so the official UK cover wins over a Discogs guess.
  releases = (
    await enrichFromUkSite(releases, {
      repoRoot: opts.repoRoot,
      seasonId: opts.seasonId,
      site: d.ukSite(),
      log: d.log,
    })
  ).releases

  await writeUkList(opts.repoRoot, opts.seasonId, uk)
  await writeReleases(releasesPath, releases)
  const currentPath = resolve(opts.repoRoot, 'current.json')
  try {
    const current = CurrentSeasonSchema.parse(JSON.parse(await readFile(currentPath, 'utf8')))
    if (current.id === opts.seasonId)
      await writeCurrent(currentPath, { ...current, contentUpdatedAt: d.now() })
  } catch (err) {
    d.log(`current.json not stamped: ${(err as Error).message}`)
  }

  // Art only fills empty slots, so this costs nothing for releases that have art.
  try {
    await d.art({
      repoRoot: opts.repoRoot,
      seasonId: opts.seasonId,
      releases: releases.map(toRawRelease),
    })
  } catch (err) {
    d.log(`art cascade failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`)
  }
  return result
}

const USAGE = 'Usage: pnpm tsx scripts/ingest-uk.ts <season-id> [<uk-pdf-url>] [--dry-run]'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const [seasonId, pdfUrl] = argv.filter((a) => !a.startsWith('--'))
  if (!seasonId || (pdfUrl !== undefined && !URL.canParse(pdfUrl))) {
    console.error(USAGE)
    process.exit(1)
    return
  }
  const result = await ingestUk({ repoRoot: resolve(process.cwd()), seasonId, pdfUrl, dryRun })
  const report = formatUkReport(result, seasonId)
  console.log(report)
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary) await appendFile(summary, `${report}\n`)
}

function isInvokedAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (entry.includes('vitest') || entry.includes('node_modules')) return false
  return entry.endsWith('ingest-uk.ts') || entry.endsWith('ingest-uk.js')
}

if (isInvokedAsCli()) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
