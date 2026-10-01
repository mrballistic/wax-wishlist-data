import type { RawRelease } from '../types.js'
import { listKeys, objectUrl } from '../watch/bucket.js'
import type { BucketObject } from '../watch/sources.js'

import type { IndexedArtSource } from './indexed-source.js'
import { type ArtCandidate, matchReleases, type MatchResult, type ScoredCandidate } from './match.js'

export const MAX_BUCKET_IMAGE_BYTES = 25 * 1024 * 1024
const PROBE_TIMEOUT_MS = 15_000
const EMPTY = (): MatchResult => ({ accepted: new Map(), suggestions: new Map() })

/**
 * False when the bucket refuses the image (401/403) or can't be reached: RSD's
 * 2025 art packs are listed but not public, while the list PDFs are. Other
 * statuses don't say the objects are private, so they count as readable.
 */
async function isPubliclyReadable(url: string): Promise<boolean> {
  const done = new AbortController()
  try {
    // Resolved per call: msw patches global fetch after module load.
    const res = await fetch(url, {
      signal: AbortSignal.any([done.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
    })
    return res.status !== 401 && res.status !== 403
  } catch {
    return false
  } finally {
    done.abort() // only the status matters; don't download the image
  }
}

export function isArtImageKey(key: string): boolean {
  const lower = key.toLowerCase()
  if (!/\.(jpe?g|png|webp|tiff?)$/.test(lower)) return false
  return !lower.includes('/logos/') && !lower.includes('__macosx/') && !lower.endsWith('.ds_store')
}

export interface RsdBucketOptions {
  /** Season year, e.g. "2026" — the bucket prefix. */
  year: string
  list?: (prefix: string) => Promise<BucketObject[]>
  log?: (line: string) => void
}

/** Tier: distributor art packs RSD sometimes uploads next to the list PDF. Free, no credentials. */
export function createRsdBucketSource(opts: RsdBucketOptions): IndexedArtSource {
  const list = opts.list ?? ((prefix: string) => listKeys(prefix, isArtImageKey))
  const log = opts.log ?? ((line: string) => console.log(line))
  let result: MatchResult = EMPTY()
  return {
    name: 'rsd-bucket',
    async prepare(missing: RawRelease[], season: RawRelease[]): Promise<void> {
      if (missing.length === 0) return
      try {
        const objects = (await list(`${opts.year}/`)).filter(
          (o) => isArtImageKey(o.key) && o.size <= MAX_BUCKET_IMAGE_BYTES,
        )
        const candidates: ArtCandidate[] = objects.map((o) => ({
          source: 'rsd-bucket',
          key: o.key,
          imageUrl: objectUrl(o.key),
          thumbUrl: objectUrl(o.key),
          label: o.key.slice(o.key.lastIndexOf('/') + 1),
        }))
        result = matchReleases(missing, candidates, season)
        // One GET on a matched image, so art-admin is never handed URLs that 403.
        const sample =
          result.accepted.values().next().value ?? result.suggestions.values().next().value?.[0]
        if (sample && !(await isPubliclyReadable(sample.imageUrl))) {
          result = EMPTY()
          log('rsd-bucket: art images not publicly readable; skipping')
          return
        }
        log(`rsd-bucket: ${candidates.length} images under ${opts.year}/, ${result.accepted.size} matched`)
      } catch (err) {
        log(`rsd-bucket: skipped (${err instanceof Error ? err.message : String(err)})`)
      }
    },
    accepted: (id: string): ScoredCandidate | null => result.accepted.get(id) ?? null,
    suggestions: (id: string): ScoredCandidate[] => result.suggestions.get(id) ?? [],
  }
}
