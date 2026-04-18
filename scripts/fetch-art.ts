import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'

import { createDiscogsSource } from './sources/discogs.js'
import {
  createManualSource,
  findManualArtForRelease,
  listManualArtBasenames,
  resizeManualArt,
} from './sources/manual.js'
import { createMusicBrainzSource } from './sources/musicbrainz.js'
import type { ArtLookupResult, ArtSource, ArtTier, RawRelease } from './types.js'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Download an art file from `url` into `destPath`. No-op if the file
 * already exists on disk (idempotent for re-runs of the ingest workflow).
 * Uses the native `fetch` available in Node 24.
 */
export async function downloadArt(url: string, destPath: string): Promise<'downloaded' | 'exists'> {
  if (await exists(destPath)) {
    return 'exists'
  }

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch art (${res.status}) from ${url}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(destPath), { recursive: true })
  await writeFile(destPath, buf)
  return 'downloaded'
}

// ---------------------------------------------------------------------------
// Cascade orchestrator
// ---------------------------------------------------------------------------

export interface CascadeOptions {
  /** Repo-root-relative path to the season's art directory. */
  artDir: string
  /** Path to the `manual-art/` directory. */
  manualArtDir: string
  /** Discogs application consumer key (optional; paired with {@link discogsConsumerSecret}). */
  discogsConsumerKey?: string | undefined
  /** Discogs application consumer secret (optional; paired with {@link discogsConsumerKey}). */
  discogsConsumerSecret?: string | undefined
  /** MetaBrainz Supporter / commercial access token (optional). */
  metabrainzAccessToken?: string | undefined
  /** Skip HTTP + filesystem writes; only simulate the cascade. */
  dryRun?: boolean
  /** Override the four tier sources (for tests). */
  sources?: {
    manual?: ArtSource
    discogs?: ArtSource
    musicbrainz?: ArtSource
  }
  /** Inject fetch (for tests). */
  fetchImpl?: typeof fetch
  /** Inject the resize-and-copy function (for tests). */
  resizeImpl?: (sourcePath: string, destPath: string) => Promise<void>
}

export interface CascadeSummary {
  total: number
  counts: Record<ArtTier, number>
  results: ArtLookupResult[]
  /** Files in manual-art/ that didn't match any release id in this run. */
  orphanManualFiles: string[]
}

export function buildDefaultSources(
  options: Pick<
    CascadeOptions,
    'manualArtDir' | 'discogsConsumerKey' | 'discogsConsumerSecret' | 'metabrainzAccessToken'
  >,
): { manual: ArtSource; discogs: ArtSource; musicbrainz: ArtSource } {
  return {
    manual: createManualSource({ manualArtDir: options.manualArtDir }),
    discogs: createDiscogsSource({
      consumerKey: options.discogsConsumerKey,
      consumerSecret: options.discogsConsumerSecret,
    }),
    musicbrainz: createMusicBrainzSource({
      accessToken: options.metabrainzAccessToken,
    }),
  }
}

/**
 * Run the four-tier art cascade (FR-F-001/FR-F-002) across `releases`
 * sequentially. Resolves to a summary suitable for printing (FR-F-004).
 *
 * Cascade order per release (short-circuits on first match):
 *   1. manual (tier 3) — highest priority, wins over auto-sourced art
 *   2. discogs (tier 1)
 *   3. musicbrainz (tier 2)
 *   4. none (tier 4) — `artFilename: null`
 */
export async function runArtCascade(
  releases: RawRelease[],
  options: CascadeOptions,
): Promise<CascadeSummary> {
  const dryRun = options.dryRun ?? false
  // In dry-run mode, suppress Discogs/MB HTTP calls entirely (FR §7.4) — the
  // manual-art source remains active because it's a local filesystem lookup.
  // Explicit test sources always win over the dry-run override.
  const defaults = buildDefaultSources(options)
  const dryRunStubs: { manual: ArtSource; discogs: ArtSource; musicbrainz: ArtSource } = {
    manual: defaults.manual,
    discogs: { name: 'discogs', async lookup() { return null } },
    musicbrainz: { name: 'musicbrainz', async lookup() { return null } },
  }
  const base = dryRun ? dryRunStubs : defaults
  const sources = { ...base, ...(options.sources ?? {}) }
  const fetchImpl = options.fetchImpl ?? fetch
  const resize = options.resizeImpl ?? resizeManualArt

  const counts: Record<ArtTier, number> = {
    manual: 0,
    discogs: 0,
    musicbrainz: 0,
    none: 0,
  }
  const results: ArtLookupResult[] = []

  const seenReleaseIds = new Set<string>()

  for (const release of releases) {
    seenReleaseIds.add(release.id)

    // Order: manual (always wins), then discogs, then musicbrainz.
    const tierOrder: ArtSource[] = [sources.manual, sources.discogs, sources.musicbrainz]
    let hit: ArtLookupResult | null = null
    for (const src of tierOrder) {
      const res = await src.lookup(release)
      if (res && res.artFilename) {
        hit = res
        break
      }
    }

    if (!hit) {
      const noArt: ArtLookupResult = {
        releaseId: release.id,
        tier: 'none',
        sourceUrl: null,
        artFilename: null,
      }
      results.push(noArt)
      counts.none += 1
      continue
    }

    // Materialize the art file unless we're in dry-run mode.
    const destPath = resolvePath(options.artDir, hit.artFilename as string)
    if (!dryRun) {
      try {
        if (hit.tier === 'manual') {
          const manualSrc = await findManualArtForRelease(options.manualArtDir, release.id)
          if (manualSrc) {
            await mkdir(dirname(destPath), { recursive: true })
            await resize(manualSrc.sourcePath, destPath)
          }
        } else if (hit.sourceUrl) {
          const res = await fetchImpl(hit.sourceUrl)
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer())
            await mkdir(dirname(destPath), { recursive: true })
            await writeFile(destPath, buf)
          } else {
            // Source promised a URL but it 404'd — demote to no-art.
            const noArt: ArtLookupResult = {
              releaseId: release.id,
              tier: 'none',
              sourceUrl: null,
              artFilename: null,
            }
            results.push(noArt)
            counts.none += 1
            continue
          }
        }
      } catch (err) {
        console.warn(`art: failed to materialize ${release.id} (tier=${hit.tier}): ${(err as Error).message}`)
        // Record as no-art on failure rather than aborting the run.
        const noArt: ArtLookupResult = {
          releaseId: release.id,
          tier: 'none',
          sourceUrl: null,
          artFilename: null,
        }
        results.push(noArt)
        counts.none += 1
        continue
      }
    }

    results.push(hit)
    counts[hit.tier] += 1
  }

  // FR-F-015: warn on orphan manual files that never matched a release id.
  const basenames = await listManualArtBasenames(options.manualArtDir)
  const seenLower = new Set(Array.from(seenReleaseIds).map((id) => id.toLowerCase()))
  const orphanManualFiles = basenames.filter((name) => !seenLower.has(name))

  return { total: releases.length, counts, results, orphanManualFiles }
}

/**
 * Pretty-print the coverage summary exactly as specified in FR-F-004.
 */
export function formatCoverageSummary(summary: CascadeSummary): string {
  const { total, counts } = summary
  const pct = (n: number): string => {
    if (total === 0) return '0%'
    return `${Math.round((n / total) * 100)}%`
  }
  const covered = counts.manual + counts.discogs + counts.musicbrainz
  const pad = (n: number, width: number): string => String(n).padStart(width, ' ')
  // Width matches the FR-F-004 example: 2 digits fits 0–99 releases; larger
  // seasons get whatever the actual digit count is.
  const w = Math.max(2, String(total).length)

  // Format matches FR-F-004 character-for-character. The label strings have
  // different trailing-space counts by design; don't auto-align them.
  return [
    '=== Art Coverage Summary ===',
    `Total releases: ${total}`,
    `  Tier 1 (Discogs):      ${pad(counts.discogs, w)} (${pct(counts.discogs)})`,
    `  Tier 2 (MusicBrainz):  ${pad(counts.musicbrainz, w)} (${pct(counts.musicbrainz)})`,
    `  Tier 3 (Manual):        ${pad(counts.manual, w)} (${pct(counts.manual)})`,
    `  Tier 4 (No art):        ${pad(counts.none, w)} (${pct(counts.none)})`,
    `Coverage: ${covered} / ${total} (${pct(covered)})`,
    '===========================',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function loadReleasesForCli(seasonId: string, repoRoot: string): Promise<RawRelease[]> {
  const { readFile } = await import('node:fs/promises')
  const path = resolvePath(repoRoot, 'releases', seasonId, 'releases.json')
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>
  // Release JSON has more fields than RawRelease (discogsMasterId, artFilename).
  // Strip them for the cascade, which operates on the raw shape.
  return parsed.map((r) => ({
    id: String(r['id']),
    artist: String(r['artist']),
    title: String(r['title']),
    label: String(r['label']),
    format: String(r['format']),
    category: String(r['category']),
    description: String(r['description'] ?? ''),
  }))
}

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const positional = args.filter((a) => !a.startsWith('--'))
  const seasonId = positional[0]
  if (!seasonId) {
    console.error('Usage: pnpm tsx scripts/fetch-art.ts <season-id> [--dry-run]')
    process.exit(1)
    return
  }

  const repoRoot = resolvePath(process.cwd())
  const artDir = resolvePath(repoRoot, 'releases', seasonId, 'art')
  const manualArtDir = resolvePath(repoRoot, 'manual-art')

  const releases = await loadReleasesForCli(seasonId, repoRoot)
  const summary = await runArtCascade(releases, {
    artDir,
    manualArtDir,
    discogsConsumerKey: process.env['DISCOGS_CONSUMER_KEY'],
    discogsConsumerSecret: process.env['DISCOGS_CONSUMER_SECRET'],
    metabrainzAccessToken: process.env['METABRAINZ_ACCESS_TOKEN'],
    dryRun,
  })

  console.log(formatCoverageSummary(summary))
  if (summary.orphanManualFiles.length > 0) {
    console.warn('\nOrphan manual-art files (no matching release id in this season):')
    for (const name of summary.orphanManualFiles) {
      console.warn(`  - ${name}`)
    }
  }
}

// Only run the CLI when this module is executed directly (not under vitest,
// not when imported from another script).
function isInvokedAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (entry.includes('vitest') || entry.includes('node_modules')) return false
  return entry.endsWith('fetch-art.ts') || entry.endsWith('fetch-art.js')
}

if (isInvokedAsCli()) {
  cliMain().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
