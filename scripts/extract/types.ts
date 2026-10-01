import { z } from 'zod'

/** Which extractor produced a candidate list. Recorded in sources.json and commit messages. */
export type ExtractorName = 'parser' | 'gemini' | 'claude'

/**
 * One release row as printed in an RSD list PDF, before ids and category
 * slugs are assigned. Every extractor returns this shape, so post-processing
 * (and therefore release ids) never depends on which extractor ran.
 */
export const ExtractedRowSchema = z
  .object({
    category: z.enum(['E', 'L', 'F']),
    artist: z.string(),
    title: z.string(),
    label: z.string(),
    format: z.string(),
  })
  .strict()
export type ExtractedRow = z.infer<typeof ExtractedRowSchema>

/** Wire shape both LLM extractors are asked to return. */
export const ExtractedRowsSchema = z.object({ rows: z.array(ExtractedRowSchema) }).strict()

export interface Extractor {
  name: ExtractorName
  /** Throws on transport/config failure or malformed output; returns rows otherwise. */
  extract(pdf: Buffer): Promise<ExtractedRow[]>
  /** Short note about the last extract() call, e.g. which model answered; null if none. */
  detail?(): string | null
  /**
   * Rows the last extract() call left out for a missing field (missing
   * fields as ""), for row repair. Only the parser has these.
   */
  partialRows?(): ExtractedRow[]
}
