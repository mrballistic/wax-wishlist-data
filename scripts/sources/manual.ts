import { readdir, stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

import sharp from 'sharp'

import type { ArtLookupResult, ArtSource, RawRelease } from '../types.js'

export const MANUAL_ART_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
export const MANUAL_ART_MAX_DIMENSION = 600

/**
 * Extensions the manual-art lookup will match, in tiebreaker order.
 * If multiple files exist with the same basename and different extensions,
 * the first in this list wins (arbitrary but documented; FR-F-014).
 */
const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png'] as const
type SupportedExt = (typeof SUPPORTED_EXTENSIONS)[number]

export interface ManualSourceOptions {
  /** Path to the repo's `manual-art/` directory. */
  manualArtDir: string
}

export interface ManualArtCandidate {
  releaseId: string
  sourcePath: string
  ext: SupportedExt
}

/**
 * Case-insensitive match of a release id against files in a directory.
 * Returns the first match in SUPPORTED_EXTENSIONS order so callers don't
 * have to iterate. Returns null if nothing matches.
 */
export async function findManualArtForRelease(
  manualArtDir: string,
  releaseId: string,
): Promise<ManualArtCandidate | null> {
  let entries: string[]
  try {
    entries = await readdir(manualArtDir)
  } catch {
    return null
  }

  // Build an index: lowercase basename-without-ext → { ext, original filename }
  const index = new Map<string, { ext: SupportedExt; filename: string }[]>()
  for (const entry of entries) {
    const lowered = entry.toLowerCase()
    for (const ext of SUPPORTED_EXTENSIONS) {
      if (lowered.endsWith(ext)) {
        const base = lowered.slice(0, -ext.length)
        const list = index.get(base) ?? []
        list.push({ ext, filename: entry })
        index.set(base, list)
        break
      }
    }
  }

  const matches = index.get(releaseId.toLowerCase())
  if (!matches || matches.length === 0) return null

  // Tiebreaker: first SUPPORTED_EXTENSIONS hit wins.
  for (const ext of SUPPORTED_EXTENSIONS) {
    const hit = matches.find((m) => m.ext === ext)
    if (hit) {
      return {
        releaseId,
        sourcePath: resolvePath(manualArtDir, hit.filename),
        ext,
      }
    }
  }
  return null
}

/**
 * Enumerate every supported image basename in `manual-art/`. Used to warn
 * about orphan overrides (files whose basename doesn't match any release id
 * in the current season, per FR-F-015).
 */
export async function listManualArtBasenames(manualArtDir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(manualArtDir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const lowered = entry.toLowerCase()
    for (const ext of SUPPORTED_EXTENSIONS) {
      if (lowered.endsWith(ext)) {
        out.push(entry.slice(0, entry.length - ext.length))
        break
      }
    }
  }
  return out
}

/**
 * Resize a manual-art source image into a normalized JPEG at or below
 * {@link MANUAL_ART_MAX_DIMENSION} on the longest side, written to `destPath`.
 *
 * Aspect ratio is preserved (sharp's default `fit: 'cover'` is NOT used — we
 * use `fit: 'inside'` and don't upscale, so small source images keep their
 * original size).
 */
export async function resizeManualArt(sourcePath: string, destPath: string): Promise<void> {
  await sharp(sourcePath)
    .resize({
      width: MANUAL_ART_MAX_DIMENSION,
      height: MANUAL_ART_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toFile(destPath)
}

export interface ManualSourceLookupContext {
  /**
   * Optional orchestrator hook invoked when the cascade picks a manual art
   * file. The orchestrator uses this to resize+write the bytes to the season
   * art directory. If absent, the source returns the lookup result without
   * side effects (useful for --dry-run).
   */
  onMatch?: (candidate: ManualArtCandidate) => Promise<void>
}

/**
 * Tier 3 source: hand-curated `manual-art/` folder. Always takes precedence
 * over tiers 1 and 2 when a match exists (FR-F-002).
 */
export function createManualSource(options: ManualSourceOptions): ArtSource {
  const { manualArtDir } = options

  return {
    name: 'manual',
    async lookup(release: RawRelease): Promise<ArtLookupResult | null> {
      const candidate = await findManualArtForRelease(manualArtDir, release.id)
      if (!candidate) return null

      // Reject files over the size limit with a console warning (§6 of PRD).
      try {
        const st = await stat(candidate.sourcePath)
        if (st.size > MANUAL_ART_MAX_BYTES) {
          console.warn(
            `manual-art: ${candidate.sourcePath} is ${st.size} bytes; max is ${MANUAL_ART_MAX_BYTES}. Skipping.`,
          )
          return null
        }
      } catch {
        return null
      }

      return {
        releaseId: release.id,
        tier: 'manual',
        sourceUrl: null,
        artFilename: `${release.id}.jpg`,
      }
    },
  }
}
