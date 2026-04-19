import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'

import { type RawRelease, RawReleaseSchema } from './types.js'

/**
 * Approximate X-coordinates of the five columns in the standard
 * Record Store Day release list PDF layout. Observed consistent across
 * the 2025 and 2026 April drops; revisit if a future season's PDF
 * uses a different grid.
 */
const COLUMNS = {
  category: 41,
  artist: 55,
  title: 211,
  label: 431,
  format: 509,
} as const

type ColumnName = keyof typeof COLUMNS

/** Tolerance (pt) for snapping a text item to the nearest column. */
const COL_SNAP_TOLERANCE = 30

/** Tolerance (pt) for clustering text items into the same row. */
const ROW_Y_TOLERANCE = 2

/**
 * RSD uses single-letter category codes in column 1:
 *   E = Exclusive Release
 *   L = Limited Run / Regional Focus Release
 *   F = RSD First Release
 * Emit machine-readable slugs; the iOS app's `Release.Category` enum
 * maps these back to display strings ("Exclusive", "Small Run", "RSD
 * First"). Keeping the wire format as slugs keeps the display copy in
 * the client where it belongs.
 */
const CATEGORY_MAP: Record<string, string> = {
  E: 'exclusive',
  L: 'small-run',
  F: 'rsd-first',
}

interface TextFragment {
  x: number
  y: number
  s: string
}

interface ParsedRow {
  category: string
  artist: string
  title: string
  label: string
  format: string
}

/**
 * Patterns that commonly start the format column ("LP", "CD", "12"", "7"",
 * quantity prefixes like "2 x LP", "Picture Disc", "Vinyl", etc.). Used to
 * split a fused "label+format" string when the format column is empty.
 */
const FORMAT_TAIL_RE =
  /((?:\d+\s*x\s+)?(?:\d+"\s*)?(?:LP|CD|EP|Picture Disc|Vinyl|Single|Import|Box Set|Cassette)(?:\s+[^]*)?)$/i

/**
 * When a row's `label` column is non-empty but `format` is empty, the PDF
 * commonly fused them into one text item (either "Rhino 2 x LP" with a space
 * or "Fuzze-Flex RecordsLP" with no space). Split off the tail when we can
 * recognize it as a format keyword.
 *
 * Returns null if no recognizable split is possible.
 */
function splitLabelFormat(label: string): { label: string; format: string } | null {
  const match = FORMAT_TAIL_RE.exec(label)
  if (!match || match.index === undefined) return null
  const format = match[1].trim()
  const remainingLabel = label.slice(0, match.index).trim()
  // If the match started mid-word ("RecordsLP"), the word boundary is
  // literally the character before the match — accept the label as-is.
  if (!remainingLabel) return null
  return { label: remainingLabel, format }
}

/**
 * Extract structured rows from a single page's text items.
 * Returns only rows that begin with a recognized category code (E/L/F).
 */
function extractRowsFromPage(items: TextFragment[]): ParsedRow[] {
  items.sort((a, b) => b.y - a.y || a.x - b.x)

  const rows: TextFragment[][] = []
  for (const frag of items) {
    const last = rows[rows.length - 1]
    if (last && Math.abs((last[0]?.y ?? frag.y) - frag.y) < ROW_Y_TOLERANCE) {
      last.push(frag)
    } else {
      rows.push([frag])
    }
  }

  const out: ParsedRow[] = []
  for (const row of rows) {
    const first = row[0]
    if (!first) continue
    if (Math.abs(first.x - COLUMNS.category) > 10) continue
    const cat = first.s.trim()
    const categoryLabel = CATEGORY_MAP[cat]
    if (!categoryLabel) continue

    const bucket: Record<ColumnName, string[]> = {
      category: [],
      artist: [],
      title: [],
      label: [],
      format: [],
    }

    for (const frag of row) {
      if (frag === first) continue
      let bestCol: ColumnName | null = null
      let bestDist = Infinity
      for (const [name, col] of Object.entries(COLUMNS) as [ColumnName, number][]) {
        const d = Math.abs(frag.x - col)
        if (d <= COL_SNAP_TOLERANCE && d < bestDist) {
          bestCol = name
          bestDist = d
        }
      }
      if (!bestCol) continue
      bucket[bestCol].push(frag.s)
    }

    const joined = (parts: string[]): string =>
      parts.join(' ').replace(/\s+/g, ' ').trim()

    const artist = joined(bucket.artist)
    const title = joined(bucket.title)
    let label = joined(bucket.label)
    let format = joined(bucket.format)

    // Salvage rows where the PDF fused label + format into a single item
    // at the label column (e.g. "Rhino 2 x LP" or "Fuzze-Flex RecordsLP").
    if (label && !format) {
      const split = splitLabelFormat(label)
      if (split) {
        label = split.label
        format = split.format
      }
    }

    if (!artist || !title || !label || !format) continue

    out.push({ category: categoryLabel, artist, title, label, format })
  }
  return out
}

/**
 * Slugify a string for use in a release id. Lowercase, alphanumerics
 * separated by single hyphens, trimmed.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .replace(/['"`’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Parse a Record Store Day release list PDF into structured releases.
 *
 * Uses `pdfjs-dist` to read positional text items (X/Y coordinates)
 * instead of `pdf-parse`'s stripped text, since the RSD PDF layout has
 * no delimiters between columns — the whitespace between columns is
 * positional, not textual.
 *
 * Rows are matched by:
 *   1. A category letter (E/L/F) at the leftmost column.
 *   2. Four non-empty text groups at the artist/title/label/format
 *      column positions.
 *
 * Rows where the label column is empty (usually because the title text
 * overflowed into the label column) are skipped and logged. These are a
 * small minority (~1–2% in observed PDFs) and are expected to be handled
 * by the manual-art / curation flow downstream.
 *
 * Duplicate slugs are disambiguated by appending `-2`, `-3`, etc.
 */
export async function parsePdf(pdfBuffer: Buffer): Promise<RawRelease[]> {
  const data = new Uint8Array(pdfBuffer)
  const doc = await getDocument({ data, verbosity: 0 }).promise

  const releases: RawRelease[] = []
  const seenIds = new Map<string, number>()
  // Dedup on the full product tuple (artist + title + format + label +
  // category). Byte-identical rows are rare (usually a PDF parser hiccup
  // extracting the same row twice); different formats of the same title
  // — e.g. Jeff Buckley "Live À L'Olympia" as 2xLP and CD — intentionally
  // differ on `format` so they survive dedup as distinct products.
  const seenTuples = new Set<string>()

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()

    const fragments: TextFragment[] = content.items
      .filter((it): it is TextItem => 'str' in it && it.str.trim().length > 0)
      .map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str }))

    for (const row of extractRowsFromPage(fragments)) {
      const tupleKey = [row.artist, row.title, row.format, row.label, row.category].join('|')
      if (seenTuples.has(tupleKey)) continue
      seenTuples.add(tupleKey)

      const baseSlug = slugify(`${row.artist} ${row.title}`)
      if (!baseSlug) continue
      const count = (seenIds.get(baseSlug) ?? 0) + 1
      seenIds.set(baseSlug, count)
      const id = count === 1 ? baseSlug : `${baseSlug}-${count}`

      const candidate: RawRelease = {
        id,
        artist: row.artist,
        title: row.title,
        label: row.label,
        format: row.format,
        category: row.category,
        description: '',
      }
      const validated = RawReleaseSchema.safeParse(candidate)
      if (validated.success) releases.push(validated.data)
    }
  }

  return releases
}
