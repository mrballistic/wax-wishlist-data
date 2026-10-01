import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'

import type { ExtractedRow, Extractor } from './types.js'

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

const CATEGORY_CODES = new Set(['E', 'L', 'F'])

function isCategoryCode(s: string): s is ExtractedRow['category'] {
  return CATEGORY_CODES.has(s)
}

interface TextFragment {
  x: number
  y: number
  s: string
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
    if (!isCategoryCode(cat)) continue
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
function extractRowsFromPage(items: TextFragment[], grid: ColumnGrid): ExtractedRow[] {
  const rows = groupIntoRows(items)

  const out: ExtractedRow[] = []
  for (const row of rows) {
    const first = row[0]
    if (!first) continue
    if (Math.abs(first.x - grid.category) > 10) continue
    const cat = first.s.trim()
    if (!isCategoryCode(cat)) continue

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

    out.push({ category: cat, artist, title, label, format })
  }
  return out
}

/**
 * Read release rows from a Record Store Day list PDF by text position.
 *
 * Uses `pdfjs-dist` to read positional text items (X/Y coordinates)
 * instead of stripped text, since the RSD PDF layout has no delimiters
 * between columns — the whitespace between columns is positional.
 *
 * Rows are matched by:
 *   1. A category letter (E/L/F) at the leftmost column.
 *   2. Four non-empty text groups at the artist/title/label/format
 *      column positions.
 *
 * Rows where the label column is empty (usually because the title text
 * overflowed into it) are skipped. Throws when no column grid can be
 * detected, which the cascade records as "parser found no rows".
 */
export async function parseRows(pdfBuffer: Buffer): Promise<ExtractedRow[]> {
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
        `changed — inspect the PDF's text positions and extend scripts/extract/parser.ts.`,
    )
  }

  return pages.flatMap((fragments) => extractRowsFromPage(fragments, grid))
}

export const parserExtractor: Extractor = { name: 'parser', extract: parseRows }
