import { dropSharedPhotos, getSiteIndex, photoUrl, type RsdEvents } from '../rsd/site-index.js'
import type { RawRelease } from '../types.js'

import type { Unlocker } from './brightdata.js'
import type { IndexedArtSource } from './indexed-source.js'
import {
  type ArtCandidate,
  matchReleases,
  type MatchResult,
  type ScoredCandidate,
} from './match.js'

/**
 * Tier: product images from recordstoreday.com's event listing. Fetching and
 * parsing live in the shared site index (scripts/rsd/site-index.ts); this tier
 * turns its entries into art candidates. Images are fetched directly.
 */

export interface RsdSiteOptions {
  seasonId: string
  unlocker: Unlocker | null
  /** Defaults to `rsd-events.json` in the working directory. */
  events?: RsdEvents
  log?: (line: string) => void
}

export function createRsdSiteSource(opts: RsdSiteOptions): IndexedArtSource {
  const log = opts.log ?? ((line: string) => console.log(line))
  let result: MatchResult = { accepted: new Map(), suggestions: new Map() }

  return {
    name: 'rsd-site',
    async prepare(missing: RawRelease[], season: RawRelease[]): Promise<void> {
      const { unlocker } = opts
      // Without an Unlocker the index logs "not configured" once, whatever is missing.
      if (unlocker && missing.length === 0) return
      const index = await getSiteIndex({
        seasonId: opts.seasonId,
        unlocker,
        expectedCount: season.length,
        events: opts.events,
        log,
      })
      if (!index || !unlocker) return
      try {
        const candidates: ArtCandidate[] = dropSharedPhotos(index.entries, log).map((e) => ({
          source: 'rsd-site',
          key: `photo:${e.photoId}`,
          imageUrl: photoUrl(e.photoId, 800),
          thumbUrl: photoUrl(e.photoId, 360),
          label: `${e.artist} – ${e.title}`,
          artist: e.artist,
          title: e.title,
          photoId: e.photoId,
          format: e.format,
        }))
        result = matchReleases(missing, candidates, season)
        log(
          `rsd-site: PromotionalEvent/${index.eventId} lists ${index.entries.length} releases, ${result.accepted.size} matched ` +
            `(${unlocker.requestsMade()} Unlocker requests)`,
        )
      } catch (err) {
        log(
          `rsd-site: skipped (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`,
        )
      }
    },
    accepted: (id: string): ScoredCandidate | null => result.accepted.get(id) ?? null,
    suggestions: (id: string): ScoredCandidate[] => result.suggestions.get(id) ?? [],
  }
}
