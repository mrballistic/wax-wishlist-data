import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import type { UkRow } from '../../scripts/types.js'
import { parsePage, parseUkPdf, UkParseError } from '../../scripts/uk/parse.js'
import { REPO_ROOT } from '../helpers/releases.js'

let rows: UkRow[]
beforeAll(async () => {
  rows = await parseUkPdf(
    await readFile(join(REPO_ROOT, 'tests', 'fixtures', '2026-november-uk.pdf')),
  )
})

describe('parseUkPdf (2026 Black Friday UK list)', () => {
  it('reads every row on all seven pages', () => {
    expect(rows).toHaveLength(151)
    expect(rows.at(-1)).toEqual({
      artist: 'Yusuf / Cat Stevens',
      title: 'Majikat Earth Tour 1976 (Live)',
      label: 'Dark Horse Records',
      format: '2xLP',
    })
  })

  it('joins a wrapped artist cell', () => {
    expect(rows[0]).toEqual({
      artist: '(International) Noise Conspiracy, The',
      title: 'A New Morning, Changing Weather',
      label: 'Burning Heart',
      format: 'LP',
    })
  })

  it('joins wrapped title, label and format cells of one row', () => {
    expect(rows[1]).toEqual({
      artist: '10,000 Maniacs',
      title: 'Candy Everybody Wants: The Complete Elektra Studio Albums',
      label: 'Elektra / Rhino',
      format: 'LP BOXSET',
    })
    expect(rows[2]?.label).toBe('Charly | International Artists')
  })

  it('keeps two formats of one title as two rows', () => {
    const withers = rows.filter((r) => r.artist === 'Bill Withers')
    expect(withers.map((r) => r.format)).toEqual(['LP', 'CD'])
  })

  it('never repeats the page header as a row', () => {
    expect(rows.some((r) => r.artist === 'Artist')).toBe(false)
  })
})

describe('parsePage', () => {
  it('throws without the header', () => {
    expect(() => parsePage([{ s: 'Some Artist', x: 40, y: 600 }], 1)).toThrow(UkParseError)
  })

  it('throws on a row with no format', () => {
    const header = [
      { s: 'Artist', x: 40, y: 700 },
      { s: 'Title', x: 200, y: 700 },
      { s: 'Label', x: 400, y: 700 },
      { s: 'Format', x: 530, y: 700 },
    ]
    expect(() =>
      parsePage([...header, { s: 'A', x: 40, y: 650 }, { s: 'T', x: 200, y: 650 }], 1),
    ).toThrow(/incomplete row/)
  })
})
