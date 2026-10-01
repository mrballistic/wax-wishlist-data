import { describe, expect, it } from 'vitest'

import { blackFridayDate, seasonDate } from '../../scripts/watch/calendar.js'

describe('calendar', () => {
  it('puts Black Friday the day after the fourth Thursday of November', () => {
    expect(blackFridayDate(2025)).toBe('2025-11-28')
    expect(blackFridayDate(2026)).toBe('2026-11-27')
    expect(blackFridayDate(2027)).toBe('2027-11-26')
  })

  it('resolves season dates', () => {
    const cal = { '2026': '2026-04-18' }
    expect(seasonDate('2026-november', cal)).toBe('2026-11-27')
    expect(seasonDate('2026-april', cal)).toBe('2026-04-18')
    expect(seasonDate('2027-april', cal)).toBeNull()
    expect(seasonDate('2027-summer', cal)).toBeNull()
  })
})
