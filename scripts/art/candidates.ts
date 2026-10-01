import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import type { ScoredCandidate } from './match.js'

const CandidateSchema = z
  .object({
    source: z.enum(['rsd-site', 'rsd-bucket']),
    imageUrl: z.string().url(),
    thumbUrl: z.string().url(),
    label: z.string().min(1),
    score: z.number().min(0).max(1),
  })
  .strict()

export const ArtCandidatesSchema = z.array(
  z.object({ releaseId: z.string().min(1), candidates: z.array(CandidateSchema).min(1).max(3) }).strict(),
)
export type ArtCandidatesFile = z.infer<typeof ArtCandidatesSchema>

export const ART_CANDIDATES_FILE = 'art-candidates.json'

/**
 * Write the season's suggestions for art-admin, sorted by release id. Deletes
 * the file when nothing is left to suggest. Returns what happened.
 */
export async function writeArtCandidates(
  seasonDir: string,
  suggestions: Map<string, ScoredCandidate[]>,
): Promise<'written' | 'deleted' | 'unchanged'> {
  const path = resolve(seasonDir, ART_CANDIDATES_FILE)
  const entries: ArtCandidatesFile = [...suggestions]
    .filter(([, cs]) => cs.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([releaseId, cs]) => ({
      releaseId,
      candidates: cs.slice(0, 3).map((c) => ({
        source: c.source,
        imageUrl: c.imageUrl,
        thumbUrl: c.thumbUrl,
        label: c.label,
        score: Math.round(c.score * 100) / 100,
      })),
    }))
  let existing: string | null = null
  try {
    existing = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (entries.length === 0) {
    if (existing === null) return 'unchanged'
    await unlink(path)
    return 'deleted'
  }
  const next = `${JSON.stringify(ArtCandidatesSchema.parse(entries), null, 2)}\n`
  if (next === existing) return 'unchanged'
  await writeFile(path, next, 'utf8')
  return 'written'
}
