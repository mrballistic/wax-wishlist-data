import type { RawRelease } from '../types.js'

import type { ScoredCandidate } from './match.js'

/**
 * An art source that matches a whole season at once (so it can enforce
 * one-image-one-release), then answers per release.
 */
export interface IndexedArtSource {
  name: 'rsd-site' | 'rsd-bucket'
  /** Build the index for `missing` (releases still without art). Never throws. */
  prepare(missing: RawRelease[], season: RawRelease[]): Promise<void>
  accepted(releaseId: string): ScoredCandidate | null
  suggestions(releaseId: string): ScoredCandidate[]
}
