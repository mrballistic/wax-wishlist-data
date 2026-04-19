import { z } from 'zod'

/**
 * Season status, mirrored from the iOS app's CurrentSeasonDTO.status field.
 * Kept as a string literal union to match the JSON contract exactly.
 */
export const SeasonStatusSchema = z.enum(['upcoming', 'active', 'past'])
export type SeasonStatus = z.infer<typeof SeasonStatusSchema>

/**
 * Matches Swift `CurrentSeasonDTO` in WaxWishlist/Sources/DataContract/DTOs.swift.
 * All fields required; camelCase preserved.
 *
 * `contentUpdatedAt` is an ISO-8601 timestamp stamped every time the release
 * list for the current season is regenerated (e.g. a re-ingest that adds art
 * coverage). iOS clients compare it against their local copy and refetch
 * `releasesUrl` when the remote timestamp is newer. Optional on the wire for
 * backwards compatibility with clients that predate the field.
 */
export const CurrentSeasonSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be yyyy-MM-dd (matches SeasonDateParser)'),
    status: SeasonStatusSchema,
    releasesUrl: z.string().url(),
    artBaseUrl: z.string().url(),
    contentUpdatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
export type CurrentSeason = z.infer<typeof CurrentSeasonSchema>

/**
 * Matches Swift `SeasonDTO`. Note: SeasonDTO does NOT include `status`
 * in the Swift layer, but we keep it in seasons.json anyway so the
 * update-status workflow stays idempotent. The iOS decoder ignores
 * unknown keys by default.
 */
export const SeasonSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: SeasonStatusSchema,
    releasesUrl: z.string().url(),
    artBaseUrl: z.string().url(),
  })
  .strict()
export type Season = z.infer<typeof SeasonSchema>

export const SeasonsListSchema = z.array(SeasonSchema)
export type SeasonsList = z.infer<typeof SeasonsListSchema>

/**
 * Matches Swift `ReleaseDTO`. `discogsMasterId` and `artFilename` are optional
 * (nullable) — the iOS side uses `Int?` and `String?`.
 */
export const ReleaseSchema = z
  .object({
    id: z.string().min(1),
    artist: z.string().min(1),
    title: z.string().min(1),
    label: z.string().min(1),
    format: z.string().min(1),
    category: z.string().min(1),
    description: z.string(),
    discogsMasterId: z.number().int().positive().nullable(),
    artFilename: z.string().min(1).nullable(),
  })
  .strict()
export type Release = z.infer<typeof ReleaseSchema>

export const ReleaseListSchema = z.array(ReleaseSchema)
export type ReleaseList = z.infer<typeof ReleaseListSchema>

/**
 * Raw release produced by the PDF parser, before Discogs enrichment.
 * Superset-compatible with `Release` except for enrichment-derived fields.
 */
export const RawReleaseSchema = z
  .object({
    id: z.string().min(1),
    artist: z.string().min(1),
    title: z.string().min(1),
    label: z.string().min(1),
    format: z.string().min(1),
    category: z.string().min(1),
    description: z.string(),
  })
  .strict()
export type RawRelease = z.infer<typeof RawReleaseSchema>

/**
 * Multi-source album art cascade types (FR-F-003 in docs/FEATURE_PRD_multi_source_art.md).
 *
 * The cascade picks art per release in priority order:
 *   tier 3 (`manual`) beats tier 1 (`discogs`) beats tier 2 (`musicbrainz`) beats tier 4 (`none`).
 *
 * Sources surface their result as {@link ArtLookupResult}. A successful lookup
 * has a non-null `artFilename`; a miss has `artFilename: null` and the cascade
 * continues to the next tier.
 */
export type ArtTier = 'manual' | 'discogs' | 'musicbrainz' | 'none'

export interface ArtLookupResult {
  releaseId: string
  tier: ArtTier
  /** Remote URL the art was fetched from. Null for manual and no-art results. */
  sourceUrl: string | null
  artFilename: string | null
}

export interface ArtSource {
  name: ArtTier
  lookup(release: RawRelease): Promise<ArtLookupResult | null>
}
