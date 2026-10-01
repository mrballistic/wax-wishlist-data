import { describe, expect, it } from 'vitest'

import { finalizeRows } from '../../scripts/extract/finalize.js'
import type { ExtractedRow } from '../../scripts/extract/types.js'

const row = (overrides: Partial<ExtractedRow> = {}): ExtractedRow => ({
  category: 'E',
  artist: 'a-ha',
  title: 'Analogue',
  label: 'Rhino',
  format: '2 x LP',
  ...overrides,
})

describe('finalizeRows', () => {
  it('maps E/L/F to category slugs', () => {
    const out = finalizeRows([
      row({ category: 'E', title: 'One' }),
      row({ category: 'L', title: 'Two' }),
      row({ category: 'F', title: 'Three' }),
    ])
    expect(out.map((r) => r.category)).toEqual(['exclusive', 'small-run', 'rsd-first'])
  })

  it('collapses whitespace in every field', () => {
    const [r] = finalizeRows([row({ artist: '  a-ha ', title: 'Analogue\n 20th  Anniversary' })])
    expect(r?.artist).toBe('a-ha')
    expect(r?.title).toBe('Analogue 20th Anniversary')
  })

  it('builds ids from artist + title only', () => {
    const [a] = finalizeRows([row({ label: 'Rhino', format: 'LP' })])
    const [b] = finalizeRows([row({ label: 'Warner', format: 'CD', category: 'F' })])
    expect(a?.id).toBe('a-ha-analogue')
    expect(b?.id).toBe('a-ha-analogue')
  })

  it('dedupes exact tuples and suffixes distinct formats of one title', () => {
    const out = finalizeRows([row(), row(), row({ format: 'CD' })])
    expect(out.map((r) => r.id)).toEqual(['a-ha-analogue', 'a-ha-analogue-2'])
  })

  it('keeps incomplete rows so the gate can reject them', () => {
    const out = finalizeRows([row({ label: '  ' })])
    expect(out).toHaveLength(1)
    expect(out[0]?.label).toBe('')
  })

  it('skips rows whose artist and title slug to nothing', () => {
    expect(finalizeRows([row({ artist: '', title: '…' })])).toEqual([])
  })

  it('sets an empty description', () => {
    expect(finalizeRows([row()])[0]?.description).toBe('')
  })
})
