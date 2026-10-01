import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

/** One object from the RSD bucket listing. `etag` keeps S3's quotes. */
export interface BucketObject {
  key: string
  etag: string
  lastModified: string
  size: number
}

export const SourceOutcomeSchema = z.enum(['published', 'not-a-list', 'skipped-country', 'superseded', 'failed'])
export type SourceOutcome = z.infer<typeof SourceOutcomeSchema>

export const SourceEntrySchema = z
  .object({
    key: z.string().min(1),
    etag: z.string().min(1),
    lastModified: z.string().datetime(),
    seasonId: z.string().min(1).nullable(),
    outcome: SourceOutcomeSchema,
    extractor: z.enum(['parser', 'gemini', 'claude']).nullable(),
    processedAt: z.string().datetime(),
  })
  .strict()
export type SourceEntry = z.infer<typeof SourceEntrySchema>

export const SourcesSchema = z.array(SourceEntrySchema)

/** Missing file → no history. */
export async function loadSources(path: string): Promise<SourceEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return SourcesSchema.parse(JSON.parse(raw))
}

export async function saveSources(path: string, entries: SourceEntry[]): Promise<void> {
  const sorted = SourcesSchema.parse([...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
}

/** New keys, changed ETags, and keys whose last outcome was `failed` (retried daily). */
export function pendingObjects(objects: BucketObject[], sources: SourceEntry[]): BucketObject[] {
  const byKey = new Map(sources.map((s) => [s.key, s]))
  return objects.filter((o) => {
    const seen = byKey.get(o.key)
    return !seen || seen.etag !== o.etag || seen.outcome === 'failed'
  })
}

export function upsertSource(sources: SourceEntry[], entry: SourceEntry): SourceEntry[] {
  return [...sources.filter((s) => s.key !== entry.key), entry]
}
