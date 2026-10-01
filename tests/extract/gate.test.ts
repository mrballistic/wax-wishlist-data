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

  it('rejects a row with an empty field', () => {
    const rows = many(30)
    rows[3] = makeRelease(3, { label: '' })
    const r = checkCandidate(rows, base)
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/missing artist, title, label or format/)
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
