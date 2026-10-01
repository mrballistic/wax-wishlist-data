import { describe, expect, it } from 'vitest'

import { formatOutcomes } from '../../scripts/watch/summary.js'

describe('formatOutcomes', () => {
  it('says so when there was nothing to do', () => {
    expect(formatOutcomes([])).toBe('No new or revised PDFs.')
  })

  it('renders a markdown table, escaping pipes in keys', () => {
    const md = formatOutcomes([
      { key: '2026/BF/list.pdf', seasonId: '2026-november', outcome: 'published', extractor: 'parser' },
      { key: '2026/a|b.pdf', seasonId: null, outcome: 'not-a-list', extractor: null },
    ])
    expect(md).toBe(
      [
        '### watch-rsd outcomes',
        '',
        '| Outcome | Season | Extractor | Key |',
        '|---|---|---|---|',
        '| published | 2026-november | parser | `2026/BF/list.pdf` |',
        '| not-a-list | – | – | `2026/a\\|b.pdf` |',
      ].join('\n'),
    )
  })
})
