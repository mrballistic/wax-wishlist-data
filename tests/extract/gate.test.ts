import { beforeAll, describe, expect, it } from 'vitest'

import {
  checkCandidate,
  diffReleases,
  type GateContext,
  groundedFraction,
  normalizeForGrounding,
} from '../../scripts/extract/gate.js'
import type { RawRelease } from '../../scripts/types.js'
import { loadRaw, makeRelease } from '../helpers/releases.js'

const base: GateContext = {
  extractor: 'parser',
  pdfText: '',
  previousSameSeason: null,
  lastComparableCount: null,
}
const many = (n: number): RawRelease[] => Array.from({ length: n }, (_, i) => makeRelease(i))
const textOf = (rows: RawRelease[]): string =>
  rows.map((r) => `E ${r.artist} ${r.title} ${r.label} ${r.format}`).join('\n')

let november: RawRelease[]
beforeAll(async () => {
  november = await loadRaw('2025-november')
})

describe('checkCandidate — always-on rules', () => {
  it('passes the published 2025-november list as an unchanged revision', () => {
    const r = checkCandidate(november, { ...base, previousSameSeason: november })
    expect(r.failures).toEqual([])
    expect(r.pass).toBe(true)
  })

  it('needs at least 25 rows', () => {
    expect(checkCandidate(many(24), base).pass).toBe(false)
    expect(checkCandidate(many(25), base).pass).toBe(true)
  })

  it('drops a single incomplete row from a large list and still passes', () => {
    const rows = many(100)
    rows[3] = makeRelease(3, { label: '' })
    const r = checkCandidate(rows, base)
    expect(r.pass).toBe(true)
    expect(r.kept).toHaveLength(99)
    expect(r.dropped).toHaveLength(1)
  })

  it('rejects an unknown category', () => {
    const rows = many(30)
    rows[0] = makeRelease(0, { category: 'Exclusive Release' })
    expect(checkCandidate(rows, base).failures.join(' ')).toMatch(/unknown category/)
  })

  it('rejects duplicate ids', () => {
    const rows = many(30)
    rows[1] = makeRelease(1, { id: rows[0]?.id ?? '' })
    expect(checkCandidate(rows, base).failures.join(' ')).toMatch(/duplicate ids/)
  })
})

describe('checkCandidate — plausible size (new season)', () => {
  const ctx = { ...base, lastComparableCount: 100 }
  it('accepts 0.6× and 1.6× inclusive', () => {
    expect(checkCandidate(many(60), ctx).pass).toBe(true)
    expect(checkCandidate(many(160), ctx).pass).toBe(true)
  })
  it('rejects just outside the band', () => {
    expect(checkCandidate(many(59), ctx).pass).toBe(false)
    expect(checkCandidate(many(161), ctx).pass).toBe(false)
  })
  it('does not apply to revisions', () => {
    const prev = many(30)
    const r = checkCandidate(prev, { ...base, previousSameSeason: prev, lastComparableCount: 1000 })
    expect(r.pass).toBe(true)
  })
})

describe('checkCandidate — bounded revision', () => {
  it('allows removing 15% of previous ids, not more', () => {
    // 25 / 173 = 14.45% removed (and count change 14.45%)
    expect(checkCandidate(november.slice(25), { ...base, previousSameSeason: november }).pass).toBe(true)
    // 26 / 173 = 15.03%
    const r = checkCandidate(november.slice(26), { ...base, previousSameSeason: november })
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/removes 26 of 173/)
  })

  it('allows a count change up to 25%', () => {
    const extra = (n: number) => Array.from({ length: n }, (_, i) => makeRelease(1000 + i))
    // 43 / 173 = 24.86%
    expect(checkCandidate([...november, ...extra(43)], { ...base, previousSameSeason: november }).pass).toBe(true)
    // 44 / 173 = 25.43%
    const r = checkCandidate([...november, ...extra(44)], { ...base, previousSameSeason: november })
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/changes the count from 173 to 217/)
  })

  it('reports added, removed and changed rows', () => {
    const next = november.slice(1).map((r, i) => (i === 0 ? { ...r, format: 'CD' } : r))
    const r = checkCandidate(next, { ...base, previousSameSeason: november })
    expect(r.report).toMatch(/Removed/)
    expect(r.report).toMatch(/Changed/)
  })
})

describe('checkCandidate — grounding (LLM extractors only)', () => {
  it('passes when every artist and title is in the text layer', () => {
    const r = checkCandidate(november, { ...base, extractor: 'gemini', pdfText: textOf(november) })
    expect(r.pass).toBe(true)
  })

  it('passes at 3 fabricated titles of 173 (98.27%) and fails at 4 (97.69%)', () => {
    const text = textOf(november)
    const fake = (n: number) =>
      november.map((r, i) => (i < n ? { ...r, title: `Fabricated Title Number ${i}` } : r))
    expect(checkCandidate(fake(3), { ...base, extractor: 'gemini', pdfText: text }).pass).toBe(true)
    const r = checkCandidate(fake(4), { ...base, extractor: 'claude', pdfText: text })
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/titles appear in the PDF text/)
  })

  it('fails an LLM candidate when the PDF has no text layer', () => {
    const r = checkCandidate(november, { ...base, extractor: 'gemini', pdfText: '  ' })
    expect(r.failures.join(' ')).toMatch(/no text layer/)
  })

  it('skips grounding for the parser', () => {
    expect(checkCandidate(november, { ...base, pdfText: '' }).pass).toBe(true)
  })
})

describe('grounding helpers', () => {
  it('normalizes case, accents, punctuation and whitespace', () => {
    expect(normalizeForGrounding("  Live À L'Olympia — 2xLP ")).toBe('live a l olympia 2xlp')
  })

  it('matches whole words only', () => {
    expect(groundedFraction(['Cure'], 'The Cured')).toBe(0)
    expect(groundedFraction(['Cure'], 'The Cure, Disintegration')).toBe(1)
  })

  it('`!!!` is grounded by raw substring', () => {
    expect(groundedFraction(['!!!'], 'E !!! Louden Up Now Warp LP')).toBe(1)
    expect(groundedFraction(['!!!'], 'E Other Band Warp LP')).toBe(0)
  })
})

describe('diffReleases', () => {
  it('compares by id on label and format', () => {
    const a = [makeRelease(1), makeRelease(2), makeRelease(3)]
    const b = [makeRelease(2, { label: 'New Label' }), makeRelease(3), makeRelease(4)]
    const d = diffReleases(a, b)
    expect(d.added.map((r) => r.id)).toEqual(['artist-4-title-4'])
    expect(d.removed.map((r) => r.id)).toEqual(['artist-1-title-1'])
    expect(d.changed).toEqual([
      {
        id: 'artist-2-title-2',
        before: { label: 'Label', format: 'LP' },
        after: { label: 'New Label', format: 'LP' },
      },
    ])
  })
})

describe('checkCandidate — incomplete rows', () => {
  const blank = (rows: RawRelease[], idx: number[]): RawRelease[] =>
    rows.map((r, i) => (idx.includes(i) ? { ...r, label: '' } : r))

  it('passes 100 rows with 2 incomplete, keeping 98 and listing both', () => {
    const r = checkCandidate(blank(many(100), [10, 20]), base)
    expect(r.pass).toBe(true)
    expect(r.kept).toHaveLength(98)
    expect(r.dropped.map((x) => x.id)).toEqual(['artist-10-title-10', 'artist-20-title-20'])
    expect(r.report).toContain('#### parser: PASS (98 rows, 2 dropped)')
    expect(r.report).toContain('- ⚠️ Dropped 2 incomplete rows (not published):')
    expect(r.report).toContain('  - exclusive | Artist 10 | Title 10 | (blank) | LP')
    expect(r.report).toContain('  - exclusive | Artist 20 | Title 20 | (blank) | LP')
  })

  it('fails 100 rows with 3 incomplete, with the limit message', () => {
    const r = checkCandidate(blank(many(100), [1, 2, 3]), base)
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain(
      '3 rows missing artist, title, label or format (limit 2 = 2% of 100; first: Artist 1 – Title 1)',
    )
    expect(r.kept).toHaveLength(97)
    expect(r.dropped).toHaveLength(3)
    expect(r.report).toContain('Dropped 3 incomplete rows')
  })

  it('fails 25 rows with 1 incomplete (floor(0.5) = 0)', () => {
    const r = checkCandidate(blank(many(25), [4]), base)
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('limit 0 = 2% of 25')
  })

  it('shows ? and (blank) for empty cells in the report', () => {
    const rows = many(100)
    rows[0] = makeRelease(0, { artist: '', format: '' })
    const r = checkCandidate(rows, base)
    expect(r.report).toContain('  - exclusive | ? | Title 0 | Label | (blank)')
  })

  it('judges a revision on the kept rows', () => {
    const extra = Array.from({ length: 3 }, (_, i) => makeRelease(2000 + i))
    const bad = makeRelease(3000, { label: '' })
    // 173 + 3 + 1 = 177 candidate rows; floor(177 * 0.02) = 3 incomplete allowed
    const r = checkCandidate([...november, ...extra, bad], {
      ...base,
      previousSameSeason: november,
    })
    expect(r.pass).toBe(true)
    expect(r.kept).toHaveLength(176)
    expect(r.report).toContain('+3 added')
  })

  it('counts a dropped row that was previously published as removed', () => {
    const next = november.map((x, i) => (i === 0 ? { ...x, label: '' } : x))
    const r = checkCandidate(next, { ...base, previousSameSeason: november })
    expect(r.pass).toBe(true)
    expect(r.report).toContain('−1 removed')
  })

  it('computes grounding on kept rows only', () => {
    const text = textOf(november)
    const fabricated = makeRelease(4000, { title: 'Totally Fabricated Title Here', label: '' })
    const r = checkCandidate([...november, fabricated], {
      ...base,
      extractor: 'gemini',
      pdfText: text,
    })
    expect(r.pass).toBe(true)
    expect(r.kept).toHaveLength(173)
    expect(r.report).toMatch(/titles 100\.0%/)
  })
})
