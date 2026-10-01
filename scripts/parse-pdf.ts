import { finalizeRows } from './extract/finalize.js'
import { parseRows } from './extract/parser.js'
import type { RawRelease } from './types.js'

/**
 * Parse a Record Store Day release list PDF with the positional parser.
 * Kept for existing callers and tests; `ingest` and the watcher go through
 * the extractor cascade in `scripts/extract/`.
 */
export async function parsePdf(pdfBuffer: Buffer): Promise<RawRelease[]> {
  return finalizeRows(await parseRows(pdfBuffer))
}
