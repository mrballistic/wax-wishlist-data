// Import the library entrypoint directly, bypassing pdf-parse's `index.js`
// debug wrapper that eagerly reads `./test/data/05-versions-space.pdf` when
// `module.parent` is falsy (i.e. under ESM / tsx). See the top-level
// index.js in the pdf-parse 1.1.1 package. Subpath types live in
// `pdf-parse-subpath.d.ts`.
// eslint-disable-next-line import/no-unresolved
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

import { type RawRelease, RawReleaseSchema } from './types.js'

/**
 * Parse an RSD release list PDF into a list of raw releases.
 *
 * This is intentionally minimal: the real PDF format varies year-to-year,
 * so we expose a single entry point the ingest workflow calls, and keep
 * the parsing logic pluggable. For now, we support a simple
 * tab/pipe-separated line format as a placeholder until a real PDF
 * fixture is available.
 *
 * Expected line shape (one per release):
 *   id | artist | title | label | format | category | description
 */
export async function parsePdf(pdfBuffer: Buffer): Promise<RawRelease[]> {
  const parsed = await pdfParse(pdfBuffer)
  const text = parsed.text ?? ''
  const results: RawRelease[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('|').map((p) => p.trim())
    if (parts.length < 7) continue
    const [id, artist, title, label, format, category, description] = parts
    if (!id || !artist || !title || !label || !format || !category) continue

    const candidate = {
      id,
      artist,
      title,
      label,
      format,
      category,
      description: description ?? '',
    }
    const validated = RawReleaseSchema.safeParse(candidate)
    if (validated.success) {
      results.push(validated.data)
    }
  }

  return results
}
