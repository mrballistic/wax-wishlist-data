import { describe, expect, it } from 'vitest'

import {
  CurrentSeasonSchema,
  RawReleaseSchema,
  ReleaseListSchema,
  ReleaseSchema,
  SeasonSchema,
  SeasonsListSchema,
  SeasonStatusSchema,
} from '../scripts/types.js'

const VALID_CURRENT = {
  id: '2026-april',
  label: 'April Drop 2026',
  date: '2026-04-18',
  status: 'upcoming' as const,
  releasesUrl:
    'https://raw.githubusercontent.com/mrballistic/wax-wishlist-data/main/releases/2026-april/releases.json',
  artBaseUrl:
    'https://raw.githubusercontent.com/mrballistic/wax-wishlist-data/main/releases/2026-april/art/',
}

const VALID_RELEASE = {
  id: '2026-april-001',
  artist: 'Azure Parallax',
  title: 'Low Tide at Dawn',
  label: 'Halcyon Pressing Co.',
  format: 'LP, 180g',
  category: 'Exclusive Release',
  description: 'Debut reissue.',
  discogsMasterId: 1048576,
  artFilename: '2026-april-001.jpg',
}

describe('SeasonStatusSchema', () => {
  it('accepts the three valid statuses', () => {
    expect(SeasonStatusSchema.parse('upcoming')).toBe('upcoming')
    expect(SeasonStatusSchema.parse('active')).toBe('active')
    expect(SeasonStatusSchema.parse('past')).toBe('past')
  })

  it('rejects unknown statuses', () => {
    expect(SeasonStatusSchema.safeParse('future').success).toBe(false)
  })
})

describe('CurrentSeasonSchema', () => {
  it('round-trips a valid payload', () => {
    const parsed = CurrentSeasonSchema.parse(VALID_CURRENT)
    expect(parsed).toEqual(VALID_CURRENT)
  })

  it('rejects a bad date format', () => {
    const bad = { ...VALID_CURRENT, date: '04/18/2026' }
    expect(CurrentSeasonSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a non-https url shape', () => {
    const bad = { ...VALID_CURRENT, releasesUrl: 'not-a-url' }
    expect(CurrentSeasonSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects missing fields', () => {
    const bad = { ...VALID_CURRENT } as Record<string, unknown>
    delete bad['label']
    expect(CurrentSeasonSchema.safeParse(bad).success).toBe(false)
  })
})

describe('SeasonSchema / SeasonsListSchema', () => {
  it('round-trips an array with one entry', () => {
    const list = [VALID_CURRENT]
    const parsed = SeasonsListSchema.parse(list)
    expect(parsed).toHaveLength(1)
    expect(SeasonSchema.parse(VALID_CURRENT).id).toBe('2026-april')
  })
})

describe('ReleaseSchema / ReleaseListSchema', () => {
  it('round-trips a valid release', () => {
    expect(ReleaseSchema.parse(VALID_RELEASE)).toEqual(VALID_RELEASE)
  })

  it('allows null discogsMasterId and null artFilename', () => {
    const nullable = { ...VALID_RELEASE, discogsMasterId: null, artFilename: null }
    expect(ReleaseSchema.parse(nullable).discogsMasterId).toBeNull()
    expect(ReleaseSchema.parse(nullable).artFilename).toBeNull()
  })

  it('rejects a negative discogsMasterId', () => {
    const bad = { ...VALID_RELEASE, discogsMasterId: -1 }
    expect(ReleaseSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an empty artist string', () => {
    const bad = { ...VALID_RELEASE, artist: '' }
    expect(ReleaseSchema.safeParse(bad).success).toBe(false)
  })

  it('accepts an empty list', () => {
    expect(ReleaseListSchema.parse([])).toEqual([])
  })

  it('rejects a list with any invalid entry', () => {
    const list = [VALID_RELEASE, { ...VALID_RELEASE, id: '' }]
    expect(ReleaseListSchema.safeParse(list).success).toBe(false)
  })
})

describe('RawReleaseSchema', () => {
  it('accepts a raw release lacking enrichment fields', () => {
    const raw = {
      id: '2026-april-999',
      artist: 'Test Artist',
      title: 'Test Title',
      label: 'Test Label',
      format: '7"',
      category: 'RSD First',
      description: '',
    }
    expect(RawReleaseSchema.parse(raw).id).toBe('2026-april-999')
  })

  it('rejects presence of discogsMasterId on a raw release', () => {
    const bad = {
      id: 'x',
      artist: 'a',
      title: 't',
      label: 'l',
      format: 'f',
      category: 'c',
      description: '',
      discogsMasterId: 1,
    }
    expect(RawReleaseSchema.safeParse(bad).success).toBe(false)
  })
})
