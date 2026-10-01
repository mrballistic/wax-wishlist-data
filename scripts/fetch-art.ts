import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'

import { writeArtCandidates } from './art/candidates.js'
import type { IndexedArtSource } from './art/indexed-source.js'
import type { ScoredCandidate } from './art/match.js'
import { normalizeArtImage } from './art/normalize.js'
import { createRsdBucketSource } from './art/rsd-bucket.js'
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
  /**
   * Season id (e.g. "2025-november"). Enables the RSD tiers; the year is its
   * first four characters.
   */
  seasonId?: string | undefined
  /**
   * Override the indexed RSD sources (for tests). Replaces the defaults, and
   * unlike the defaults they're still prepared in dry-run mode.
   */
  indexedSources?: IndexedArtSource[]
  /** Inject fetch (for tests). */
  fetchImpl?: typeof fetch
  /** Inject the resize-and-copy function (for tests). */
  resizeImpl?: (sourcePath: string, destPath: string) => Promise<void>
}

export interface CascadeSummary {
  total: number
  counts: Record<ArtTier, number>
  results: ArtLookupResult[]
  /**
   * Releases skipped because their art file was already on disk (from a
   * previous run or a wax-wishlist-art-admin commit). Counted toward coverage.
   */
  kept: number
  /** Files in manual-art/ that didn't match any release id in this run. */
  orphanManualFiles: string[]
  /**
   * Releases that ended with no art → their top RSD candidates (≤ 3, best
   * first). Feeds `art-candidates.json` for wax-wishlist-art-admin.
   */
  suggestions: Map<string, ScoredCandidate[]>
}

/** Top-N suggestions shown to a human for a release with no accepted art. */
const MAX_SUGGESTIONS = 3

/**
 * The indexed (whole-season) RSD sources, in cascade order. Empty without a
 * season id.
 */
export function buildDefaultIndexedSources(options: Pick<CascadeOptions, 'seasonId'>): IndexedArtSource[] {
  if (!options.seasonId) return []
  return [createRsdBucketSource({ year: options.seasonId.slice(0, 4) })]
}

/** Merge every source's suggestions: best first, one per image URL, at most 3. */
function topSuggestions(indexed: IndexedArtSource[], releaseId: string): ScoredCandidate[] {
  const all = indexed.flatMap((src) => src.suggestions(releaseId)).sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  const out: ScoredCandidate[] = []
  for (const c of all) {
    if (seen.has(c.imageUrl)) continue
    seen.add(c.imageUrl)
    out.push(c)
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
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
 * Run the art cascade (FR-F-001/FR-F-002) across `releases` sequentially.
 * Resolves to a summary suitable for printing (FR-F-004).
 *
 * Cascade order per release (short-circuits on first match):
 *   1. manual (tier 3) — highest priority, wins over auto-sourced art
 *      and over an existing file
 *   -  existing file in `artDir` — kept as-is, no network lookups. This is
 *      what makes re-runs safe for art committed by wax-wishlist-art-admin,
 *      which writes straight into `art/` rather than `manual-art/`.
 *   2. rsd-site, rsd-bucket — indexed sources matched across the whole
 *      season at once (prepared once, before the per-release loop). A hit
 *      whose image can't be fetched or decoded falls through to the next tier.
 *   3. discogs (tier 1)
 *   4. musicbrainz (tier 2)
 *   5. none (tier 4) — `artFilename: null`; the release's best RSD
 *      suggestions are recorded in `summary.suggestions`.
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
  // Same rule for the indexed RSD sources: the defaults hit the network, so
  // dry-run skips them; explicitly passed ones always run.
  const indexed = options.indexedSources ?? (dryRun ? [] : buildDefaultIndexedSources(options))
  const fetchImpl = options.fetchImpl ?? fetch
  const resize = options.resizeImpl ?? resizeManualArt

  const counts: Record<ArtTier, number> = {
    manual: 0,
    'rsd-site': 0,
    'rsd-bucket': 0,
    discogs: 0,
    musicbrainz: 0,
    none: 0,
  }
  const results: ArtLookupResult[] = []
  const suggestions = new Map<string, ScoredCandidate[]>()
  let kept = 0

  const seenReleaseIds = new Set<string>()
  const total = releases.length
  const pad = String(total).length

  // Pre-pass: manual (always wins), then an existing file on disk. Whatever
  // is left is `pending` and goes to the indexed sources and the remote tiers.
  const manualHits = new Map<string, ArtLookupResult>()
  const keptIds = new Set<string>()
  const pending: RawRelease[] = []
  for (const release of releases) {
    seenReleaseIds.add(release.id)
    const manualHit = await sources.manual.lookup(release)
    if (manualHit?.artFilename) {
      manualHits.set(release.id, manualHit)
    } else if (await exists(resolvePath(options.artDir, `${release.id}.jpg`))) {
      keptIds.add(release.id)
    } else {
      pending.push(release)
    }
  }

  // Prepare each indexed source once for the whole season, in order; a later
  // source isn't asked about releases an earlier one already accepted.
  const acceptedIds = new Set<string>()
  for (const src of indexed) {
    try {
      await src.prepare(
        pending.filter((r) => !acceptedIds.has(r.id)),
        releases,
      )
    } catch (err) {
      console.warn(`art: ${src.name} prepare failed: ${(err as Error).message}`)
      continue
    }
    for (const r of pending) if (src.accepted(r.id)) acceptedIds.add(r.id)
  }

  /** Fetch + normalize an RSD image into `destPath`. False (logged) on any failure. */
  const materializeRsd = async (url: string, destPath: string, releaseId: string, tier: ArtTier): Promise<boolean> => {
    try {
      const res = await fetchImpl(url)
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
      const jpeg = await normalizeArtImage(Buffer.from(await res.arrayBuffer()))
      await mkdir(dirname(destPath), { recursive: true })
      await writeFile(destPath, jpeg)
      return true
    } catch (err) {
      console.warn(`art: failed to materialize ${releaseId} (tier=${tier}), trying next tier: ${(err as Error).message}`)
      return false
    }
  }

  const recordNone = (releaseId: string): void => {
    results.push({ releaseId, tier: 'none', sourceUrl: null, artFilename: null })
    counts.none += 1
    const top = topSuggestions(indexed, releaseId)
    if (top.length > 0) suggestions.set(releaseId, top)
  }

  for (let i = 0; i < total; i++) {
    const release = releases[i]
    if (!release) continue
    const n = String(i + 1).padStart(pad, ' ')
    const label = `${release.artist} – ${release.title}`

    if (keptIds.has(release.id)) {
      kept += 1
      console.log(`[${n}/${total}] ${label} → kept existing file`)
      continue
    }

    const destPath = resolvePath(options.artDir, `${release.id}.jpg`)
    let hit: ArtLookupResult | null = manualHits.get(release.id) ?? null

    // Indexed RSD tiers. Materialized here so a broken image demotes to the
    // next tier rather than straight to no-art.
    if (!hit) {
      for (const src of indexed) {
        const candidate = src.accepted(release.id)
        if (!candidate) continue
        if (dryRun || (await materializeRsd(candidate.imageUrl, destPath, release.id, src.name))) {
          hit = {
            releaseId: release.id,
            tier: src.name,
            sourceUrl: candidate.imageUrl,
            artFilename: `${release.id}.jpg`,
          }
          break
        }
      }
    }
    const rsdHit = hit !== null && hit.tier !== 'manual'

    if (!hit) {
      const remoteTiers: ArtSource[] = [sources.discogs, sources.musicbrainz]
      for (const src of remoteTiers) {
        const res = await src.lookup(release)
        if (res && res.artFilename) {
          hit = res
          break
        }
      }
    }

    if (!hit) {
      recordNone(release.id)
      console.log(`[${n}/${total}] ${label} → no art (tier 4)`)
      continue
    }

    // Materialize the art file unless we're in dry-run mode (RSD hits were
    // already written above).
    const hitPath = resolvePath(options.artDir, hit.artFilename as string)
    if (!dryRun && !rsdHit) {
      try {
        if (hit.tier === 'manual') {
          const manualSrc = await findManualArtForRelease(options.manualArtDir, release.id)
          if (manualSrc) {
            await mkdir(dirname(hitPath), { recursive: true })
            await resize(manualSrc.sourcePath, hitPath)
          }
        } else if (hit.sourceUrl) {
          const res = await fetchImpl(hit.sourceUrl)
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer())
            await mkdir(dirname(hitPath), { recursive: true })
            await writeFile(hitPath, buf)
          } else {
            // Source promised a URL but it 404'd — demote to no-art.
            recordNone(release.id)
            continue
          }
        }
      } catch (err) {
        console.warn(`art: failed to materialize ${release.id} (tier=${hit.tier}): ${(err as Error).message}`)
        // Record as no-art on failure rather than aborting the run.
        recordNone(release.id)
        continue
      }
    }

    results.push(hit)
    counts[hit.tier] += 1
    const tierLabel =
      hit.tier === 'discogs'
        ? 'tier 1 discogs'
        : hit.tier === 'musicbrainz'
          ? 'tier 2 musicbrainz'
          : hit.tier === 'manual'
            ? 'tier 3 manual'
            : hit.tier
    console.log(`[${n}/${total}] ${label} → ${tierLabel} (${hit.artFilename})`)
  }

  // FR-F-015: warn on orphan manual files that never matched a release id.
  const basenames = await listManualArtBasenames(options.manualArtDir)
  const seenLower = new Set(Array.from(seenReleaseIds).map((id) => id.toLowerCase()))
  const orphanManualFiles = basenames.filter((name) => !seenLower.has(name))

  return { total: releases.length, counts, kept, results, orphanManualFiles, suggestions }
}

/**
 * Pretty-print the coverage summary exactly as specified in FR-F-004.
 */
export function formatCoverageSummary(summary: CascadeSummary): string {
  const { total, counts, kept } = summary
  const pct = (n: number): string => {
    if (total === 0) return '0%'
    return `${Math.round((n / total) * 100)}%`
  }
  const covered =
    counts.manual + counts['rsd-site'] + counts['rsd-bucket'] + counts.discogs + counts.musicbrainz + kept
  const pad = (n: number, width: number): string => String(n).padStart(width, ' ')
  // Width matches the FR-F-004 example: 2 digits fits 0–99 releases; larger
  // seasons get whatever the actual digit count is.
  const w = Math.max(2, String(total).length)

  // Format matches FR-F-004 character-for-character. The label strings have
  // different trailing-space counts by design; don't auto-align them.
  return [
    '=== Art Coverage Summary ===',
    `Total releases: ${total}`,
    `  RSD site:               ${pad(counts['rsd-site'], w)} (${pct(counts['rsd-site'])})`,
    `  RSD bucket:             ${pad(counts['rsd-bucket'], w)} (${pct(counts['rsd-bucket'])})`,
    `  Tier 1 (Discogs):      ${pad(counts.discogs, w)} (${pct(counts.discogs)})`,
    `  Tier 2 (MusicBrainz):  ${pad(counts.musicbrainz, w)} (${pct(counts.musicbrainz)})`,
    `  Tier 3 (Manual):        ${pad(counts.manual, w)} (${pct(counts.manual)})`,
    `  Tier 4 (No art):        ${pad(counts.none, w)} (${pct(counts.none)})`,
    `  Already on disk:        ${pad(kept, w)} (${pct(kept)})`,
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
    seasonId,
  })

  console.log(formatCoverageSummary(summary))
  if (!dryRun) {
    const outcome = await writeArtCandidates(resolvePath(repoRoot, 'releases', seasonId), summary.suggestions)
    console.log(`art-candidates.json: ${outcome} (${summary.suggestions.size} releases with suggestions)`)
  }
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
