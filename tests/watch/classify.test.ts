import { describe, expect, it } from 'vitest'

import { classifyKey, hasListSignal } from '../../scripts/watch/classify.js'

describe('classifyKey', () => {
  it.each([
    ['2025/RSD_2025_Italia/2025_RSD_PUBLIC_PDF_Italia.pdf', { kind: 'skipped-country' }],
    ['2025/RSD 2025 List Links/2025_RSD_PUBLICX354A.pdf', { kind: 'season', seasonId: '2025-april' }],
    ['2025/RSD 2025 List Links/2025_BLACK_FRIDAY_PUBLIC.pdf', { kind: 'season', seasonId: '2025-november' }],
    ['2025/RSD Black Friday 2025 l/2025_BLACK_FRIDAY_PUBLIC.pdf', { kind: 'season', seasonId: '2025-november' }],
    ['2026/RSD 2026_v2/RSD26_PDF_4-3.pdf', { kind: 'season', seasonId: '2026-april' }],
    ['2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf', { kind: 'season', seasonId: '2026-april' }],
    ['2026/Black Friday/RSD Black Friday List.pdf', { kind: 'season', seasonId: '2026-november' }],
    ['2025/Stock/RSD ORDERABLE STOCK AS OF 4-17.xlsx', { kind: 'ignored' }],
    ['2025/Forms/pledge.doc', { kind: 'ignored' }],
    ['2026/Logos/rsd_stacked_2026.zip', { kind: 'ignored' }],
    ['2026/Logos/', { kind: 'ignored' }],
  ])('%s', (key, expected) => {
    expect(classifyKey(key)).toEqual(expected)
  })
})

describe('hasListSignal', () => {
  it('looks only at the file name', () => {
    expect(hasListSignal('2025/RSD 2025 List Links/2025_RSD_PUBLICX354A.pdf')).toBe(true)
    expect(hasListSignal('2025/RSD 2025 List Links/2025_BLACK_FRIDAY_PUBLIC.pdf')).toBe(true)
    expect(hasListSignal('2026/RSD 2026 List Links/RSD26_PDF_4-3.pdf')).toBe(false)
    expect(hasListSignal('2026/x/RSD Black Friday List.pdf')).toBe(true)
  })
})
