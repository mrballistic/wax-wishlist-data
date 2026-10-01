import type { RawRelease } from '../types.js'
import { listKeys, objectUrl } from '../watch/bucket.js'
import type { BucketObject } from '../watch/sources.js'

import type { IndexedArtSource } from './indexed-source.js'
import { type ArtCandidate, matchReleases, type MatchResult, type ScoredCandidate } from './match.js'

export const MAX_BUCKET_IMAGE_BYTES = 25 * 1024 * 1024

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
  let result: MatchResult = { accepted: new Map(), suggestions: new Map() }
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
        log(`rsd-bucket: ${candidates.length} images under ${opts.year}/, ${result.accepted.size} matched`)
      } catch (err) {
        log(`rsd-bucket: skipped (${err instanceof Error ? err.message : String(err)})`)
      }
    },
    accepted: (id: string): ScoredCandidate | null => result.accepted.get(id) ?? null,
    suggestions: (id: string): ScoredCandidate[] => result.suggestions.get(id) ?? [],
  }
}
