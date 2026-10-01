import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { finalizeRows } from '../../scripts/extract/finalize.js'
import { runCascade } from '../../scripts/extract/index.js'
import { parseRows, parseRowsDetailed, parserExtractor } from '../../scripts/extract/parser.js'
import type { ExtractedRow, Extractor } from '../../scripts/extract/types.js'
import { repairRows } from '../../scripts/rsd/repair.js'
import { parseListing, parseTablePage, type SiteEntry } from '../../scripts/rsd/site-index.js'
import { REPO_ROOT } from '../helpers/releases.js'

const DJ = 'david-johansen-and-the-harry-smiths-david-johansen-and-the-harry-smiths'
const LARRY = 'larry-june-2-chainz-the-alchemist-life-is-beautiful-chopped-not-slopped'

let pdf: Buffer
let rows: ExtractedRow[]
let partial: ExtractedRow[]
let entries: SiteEntry[]
beforeAll(async () => {
  pdf = await readFile(join(REPO_ROOT, 'tests/fixtures/2025-november.pdf'))
  ;({ rows, partial } = await parseRowsDetailed(pdf))
  const html = await readFile(
    join(REPO_ROOT, 'tests/fixtures/rsd-site/promotional-event-599-black-friday-2025.html'),
    'utf8',
  )
  const table = parseTablePage(html)
  entries = parseListing(html).map((e) => ({
    ...e,
    quantity: table.get(e.releaseId)?.quantity ?? null,
    upc: table.get(e.releaseId)?.upc ?? null,
  }))
})

const entry = (artist: string, title: string, over: Partial<SiteEntry> = {}): SiteEntry => ({
  releaseId: '1',
  artist,
  title,
  photoId: 1,
  format: '',
  label: '',
  description: '',
  tracklist: [],
  quantity: null,
  upc: null,
  pageUrl: 'https://recordstoreday.com/SpecialRelease/1',
  ...over,
})
const row = (over: Partial<ExtractedRow>): ExtractedRow => ({
  category: 'E',
  artist: '',
  title: '',
  label: '',
  format: '',
  ...over,
})

describe('parseRowsDetailed', () => {
  it('keeps the rows the parser skips as partial rows', () => {
    expect(rows).toHaveLength(173)
    expect(partial.map((r) => r.artist)).toEqual([
      'David Johansen and the Harry Smiths David Johansen And The Harry Smiths',
      'David Johansen and the Harry Smiths David Johansen And The Harry Smiths',
      'Larry June, 2 Chainz & The Alchemist Life Is Beautiful (Chopped Not Slopped)',
      'Matchbox Twenty',
    ])
    expect(partial[3]).toEqual({
      category: 'E',
      artist: 'Matchbox Twenty',
      title: 'Mad Season (Live 2001)',
      label: '',
      format: '2 x LP',
    })
  })

  it('leaves parseRows unchanged', async () => {
    expect(await parseRows(pdf)).toEqual(rows)
  })

  it('exposes the last call’s partial rows on the parser extractor', async () => {
    expect(await parserExtractor.extract(pdf)).toEqual(rows)
    expect(parserExtractor.partialRows?.()).toEqual(partial)
  })
})

describe('repairRows', () => {
  it('recovers the David Johansen and Larry June rows from the 599 listing', () => {
    const log = vi.fn()
    const out = repairRows(rows, partial, entries, log)
    expect(out.repaired).toBe(3)
    expect(log).toHaveBeenCalledWith('repair: recovered 3 rows, filled 0 fields')

    const releases = finalizeRows(out.rows)
    expect(releases).toHaveLength(173 + 3)
    const byId = new Map(releases.map((r) => [r.id, r]))
    expect(byId.get(DJ)).toMatchObject({
      artist: 'David Johansen and the Harry Smiths',
      title: 'David Johansen And The Harry Smiths',
      label: 'Chesky Records',
      format: 'LP',
    })
    expect(byId.get(`${DJ}-2`)).toMatchObject({ label: 'Chesky Records', format: 'SACD' })
    expect(byId.get(LARRY)).toMatchObject({
      artist: 'Larry June, 2 Chainz & The Alchemist',
      title: 'Life Is Beautiful (Chopped Not Slopped)',
      label: 'The Freeminded Records / 2 Chainz / ALC / EMPIRE',
      format: 'LP',
    })
    expect(releases.some((r) => r.artist === 'Matchbox Twenty')).toBe(false)
  })

  it('changes nothing without site entries', () => {
    const out = repairRows(rows, partial, [])
    expect(out.repaired).toBe(0)
    expect(finalizeRows(out.rows)).toEqual(finalizeRows(rows))
  })

  it('does not split a fused string that matches two different releases', () => {
    const fused = row({ artist: 'Foo Bar Baz', label: 'L', format: 'LP' })
    const out = repairRows([], [fused], [entry('Foo', 'Bar Baz'), entry('Foo Bar', 'Baz')])
    expect(out).toEqual({ rows: [], repaired: 0 })
  })

  it('splits a fused string matching several entries of one release', () => {
    const fused = row({ artist: 'Foo Bar Baz', label: 'L', format: 'LP' })
    const out = repairRows(
      [],
      [fused],
      [entry('Foo', 'Bar Baz'), entry('foo', 'bar baz', { releaseId: '2' })],
    )
    expect(out.rows).toEqual([{ ...fused, artist: 'Foo', title: 'Bar Baz' }])
  })

  it('fills a blank label or format on any row when the site agrees', () => {
    const gemini = row({ artist: 'Foo', title: 'Bar', format: 'LP' })
    const noFormat = row({ artist: 'Qux', title: 'Quux', label: 'Lab' })
    const out = repairRows(
      [gemini, noFormat],
      [],
      [entry('Foo', 'Bar', { label: 'Label A' }), entry('Qux', 'Quux', { format: '2 x LP' })],
    )
    expect(out.rows).toEqual([
      { ...gemini, label: 'Label A' },
      { ...noFormat, format: '2 x LP' },
    ])
  })

  it('picks a label by format when site entries disagree, and never fills on ambiguity', () => {
    const site = [
      entry('Foo', 'Bar', { label: 'Label A', format: 'LP' }),
      entry('Foo', 'Bar', { label: 'Label B', format: 'CD' }),
    ]
    const byFormat = repairRows([row({ artist: 'Foo', title: 'Bar', format: 'CD' })], [], site)
    expect(byFormat.rows[0]?.label).toBe('Label B')
    const noFormat = repairRows([row({ artist: 'Foo', title: 'Bar' })], [], site)
    expect(noFormat.rows[0]).toMatchObject({ label: '', format: '' })
  })

  it('never overwrites a non-empty value and never fills from an empty site value', () => {
    const r = row({ artist: 'Foo', title: 'Bar', label: 'Mine', format: '' })
    const out = repairRows([r], [], [entry('Foo', 'Bar', { label: 'Theirs', format: '' })])
    expect(out.rows).toEqual([r])
  })
})

describe('runCascade with repair', () => {
  const parserWith = (out: ExtractedRow[], part: ExtractedRow[]): Extractor => ({
    name: 'parser',
    extract: vi.fn(async () => out),
    partialRows: () => part,
  })
  const input = (
    extractor: Extractor,
    repair?: (r: ExtractedRow[], p: ExtractedRow[]) => ExtractedRow[],
  ) => ({
    pdf: Buffer.from(''),
    pdfText: '',
    extractors: [extractor],
    previousSameSeason: null,
    lastComparableCount: 173,
    title: 'test',
    ...(repair ? { repair } : {}),
  })

  it('never lets unrepaired partial rows reach the gate', async () => {
    const r = await runCascade(input(parserWith(rows, partial)))
    expect(r.attempts[0]?.rowCount).toBe(173)
    expect(r.releases).toHaveLength(173)
    expect(r.dropped).toEqual([])
  })

  it('adds the repaired rows before ids are assigned', async () => {
    const r = await runCascade(
      input(parserWith(rows, partial), (x, p) => repairRows(x, p, entries).rows),
    )
    expect(r.passed).toBe(true)
    expect(r.attempts[0]?.rowCount).toBe(176)
    expect(r.releases?.map((x) => x.id)).toEqual(expect.arrayContaining([DJ, `${DJ}-2`, LARRY]))
    expect(r.dropped).toEqual([])
  })
})
