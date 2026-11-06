import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'

import type { UkRow } from '../types.js'

export class UkParseError extends Error {
  override name = 'UkParseError'
}

const HEADERS = ['Artist', 'Title', 'Label', 'Format'] as const

/**
 * Vertical distance (PDF points) that starts a new row. In the 2026 Black
 * Friday list, wrapped lines inside one cell sit 13–14pt apart and rows
 * 20–21pt apart; each row's cells are vertically centred, so a short cell
 * sits between the lines of a wrapped one and never widens a gap.
 */
const ROW_GAP = 17
/** Tolerance when assigning an item to the column whose header it sits under. */
const COLUMN_SLOP = 5

interface Item {
  s: string
  x: number
  y: number
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Parse recordstoreday.co.uk's release-list PDF: a four-column table
 * (Artist, Title, Label, Format) with the header repeated on every page and
 * long cells wrapped onto extra lines. Rows are recovered by clustering the
 * text items' y positions; columns by the header x positions on each page.
 */
export async function parseUkPdf(pdf: Buffer): Promise<UkRow[]> {
  const doc = await getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise
  const rows: UkRow[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    const items: Item[] = content.items
      .filter((it): it is TextItem => 'str' in it && it.str.trim() !== '')
      .map((it) => ({
        s: it.str.trim(),
        x: it.transform[4] as number,
        y: it.transform[5] as number,
      }))
    rows.push(...parsePage(items, p))
  }
  if (rows.length === 0) throw new UkParseError('no rows found')
  return rows
}

/** One page's rows. Exported for tests. */
export function parsePage(items: Item[], page: number): UkRow[] {
  const header = HEADERS.map((name) => items.find((i) => i.s === name))
  if (header.some((h) => h === undefined)) {
    throw new UkParseError(`page ${page}: missing the Artist/Title/Label/Format header`)
  }
  const [artistH, titleH, labelH, formatH] = header as [Item, Item, Item, Item]
  const headerY = Math.min(artistH.y, titleH.y, labelH.y, formatH.y)
  const column = (x: number): 0 | 1 | 2 | 3 =>
    x >= formatH.x - COLUMN_SLOP
      ? 3
      : x >= labelH.x - COLUMN_SLOP
        ? 2
        : x >= titleH.x - COLUMN_SLOP
          ? 1
          : 0

  // PDF y grows upwards: body items sit below the header.
  const body = items.filter((i) => i.y < headerY - 2)
  const ys = [...new Set(body.map((i) => Math.round(i.y)))].sort((a, b) => b - a)
  const groups: number[][] = []
  for (const y of ys) {
    const last = groups.at(-1)
    if (last && (last.at(-1) as number) - y <= ROW_GAP) last.push(y)
    else groups.push([y])
  }

  return groups.map((group) => {
    const inRow = body
      .filter((i) => group.includes(Math.round(i.y)))
      .sort((a, b) => b.y - a.y || a.x - b.x)
    const cells = [0, 1, 2, 3].map((c) =>
      clean(
        inRow
          .filter((i) => column(i.x) === c)
          .map((i) => i.s)
          .join(' '),
      ),
    )
    const [artist = '', title = '', label = '', format = ''] = cells
    if (!artist || !title || !format) {
      throw new UkParseError(`page ${page}: incomplete row "${cells.join(' | ')}"`)
    }
    return { artist, title, label, format }
  })
}
