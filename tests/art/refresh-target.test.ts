import { describe, expect, it } from 'vitest'

import { refreshTarget } from '../../scripts/art-refresh-target.js'

describe('refreshTarget', () => {
  const current = { id: '2026-black-friday', date: '2026-11-27' }

  it('returns the id when the season date is after today', () => {
    expect(refreshTarget(current, '2026-10-01')).toBe('2026-black-friday')
  })

  it('returns the id on the season date itself', () => {
    expect(refreshTarget(current, '2026-11-27')).toBe('2026-black-friday')
  })

  it('returns null once the season date has passed', () => {
    expect(refreshTarget(current, '2026-11-28')).toBeNull()
  })
})
