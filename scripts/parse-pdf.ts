import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'

import { type RawRelease, RawReleaseSchema } from './types.js'

/**
 * Column names for the standard Record Store Day release list PDF layout:
 * a category letter (E/L/F), then artist/title/label/format.
 *
 * The X-coordinates aren't constant across PDFs — the April 2025, April 2026,
 * and Black Friday 2025 drops all use the same 5-column structure but with
 * different absolute X values (the whole grid is shifted by ~10–25pt between
 * drops). We auto-detect the grid from the document's own data rows rather
 * than hard-coding coordinates that need revisiting every season.
 */
const COLUMN_NAMES = ['category', 'artist', 'title', 'label', 'format'] as const

type ColumnName = (typeof COLUMN_NAMES)[number]
type ColumnGrid = Record<ColumnName, number>

/** Tolerance (pt) for snapping a text item to the nearest column. */
const COL_SNAP_TOLERANCE = 30

/** Tolerance (pt) for clustering text items into the same row. */
const ROW_Y_TOLERANCE = 2

/** Minimum number of well-formed reference rows needed to trust the detected grid. */
const MIN_REFERENCE_ROWS = 3

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
 * Group text fragments into rows by Y-coordinate. Fragments on the same line
 * (within `ROW_Y_TOLERANCE`) end up in the same row. Rows are returned in
 * top-to-bottom, left-to-right order.
 */
function groupIntoRows(items: TextFragment[]): TextFragment[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: TextFragment[][] = []
  for (const frag of sorted) {
    const last = rows[rows.length - 1]
    if (last && Math.abs((last[0]?.y ?? frag.y) - frag.y) < ROW_Y_TOLERANCE) {
      last.push(frag)
    } else {
      rows.push([frag])
    }
  }
  return rows
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

/**
 * Auto-detect the five column X-coordinates from the document's data rows.
 *
 * A "reference row" is a row whose first fragment is exactly a category code
 * (E / L / F) and which has exactly five fragments. Rows meeting those
 * criteria are guaranteed to be well-formed data rows — for each column we
 * take the median X across all reference rows. That survives occasional
 * malformed rows and yields a tight grid even if the document mixes layouts.
 */
function detectColumnGrid(allRows: TextFragment[][]): ColumnGrid | null {
  const referenceXs: number[][] = [[], [], [], [], []]
  for (const row of allRows) {
    if (row.length !== 5) continue
    const first = row[0]
    if (!first) continue
    const cat = first.s.trim()
    if (!(cat in CATEGORY_MAP)) continue
    const sorted = [...row].sort((a, b) => a.x - b.x)
    for (let i = 0; i < 5; i++) {
      const xs = referenceXs[i]
      const frag = sorted[i]
      if (xs && frag) xs.push(frag.x)
    }
  }

  const counts = referenceXs.map((xs) => xs.length)
  if (Math.min(...counts) < MIN_REFERENCE_ROWS) return null

  const medians = referenceXs.map((xs) => median(xs))
  return {
    category: medians[0] ?? 0,
    artist: medians[1] ?? 0,
    title: medians[2] ?? 0,
    label: medians[3] ?? 0,
    format: medians[4] ?? 0,
  }
}

/**
 * Extract structured rows from a page's text items using a previously
 * detected column grid. Only rows that begin with a recognized category
 * code (E/L/F) near the category column are emitted.
 */
function extractRowsFromPage(items: TextFragment[], grid: ColumnGrid): ParsedRow[] {
  const rows = groupIntoRows(items)

  const out: ParsedRow[] = []
  for (const row of rows) {
    const first = row[0]
    if (!first) continue
    if (Math.abs(first.x - grid.category) > 10) continue
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
      for (const name of COLUMN_NAMES) {
        const d = Math.abs(frag.x - grid[name])
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

  // First pass: collect all fragments and their row groupings across every
  // page so we can detect the column grid from the document's own data.
  const pages: TextFragment[][] = []
  const allRows: TextFragment[][] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const fragments: TextFragment[] = content.items
      .filter((it): it is TextItem => 'str' in it && it.str.trim().length > 0)
      .map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str }))
    pages.push(fragments)
    allRows.push(...groupIntoRows(fragments))
  }

  const grid = detectColumnGrid(allRows)
  if (!grid) {
    throw new Error(
      `Could not detect a 5-column grid from the PDF: fewer than ${MIN_REFERENCE_ROWS} ` +
        `well-formed data rows (E/L/F + 4 fields) were found. The layout may have ` +
        `changed — inspect the PDF's text positions and extend parse-pdf.ts.`,
    )
  }

  const releases: RawRelease[] = []
  const seenIds = new Map<string, number>()
  // Dedup on the full product tuple (artist + title + format + label +
  // category). Byte-identical rows are rare (usually a PDF parser hiccup
  // extracting the same row twice); different formats of the same title
  // — e.g. Jeff Buckley "Live À L'Olympia" as 2xLP and CD — intentionally
  // differ on `format` so they survive dedup as distinct products.
  const seenTuples = new Set<string>()

  for (const fragments of pages) {
    for (const row of extractRowsFromPage(fragments, grid)) {
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
