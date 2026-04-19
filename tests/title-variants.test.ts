import { describe, expect, it } from 'vitest'

import { stripEditionSuffix } from '../scripts/title-variants.js'

describe('stripEditionSuffix', () => {
  it('strips trailing parenthetical with edition keyword', () => {
    expect(stripEditionSuffix('Album (Deluxe Edition)')).toBe('Album')
    expect(stripEditionSuffix('OK Computer (OKNOTOK 1997 2017 Anniversary)')).toBe('OK Computer')
    expect(stripEditionSuffix('Album (20th Anniversary Expanded Edition)')).toBe('Album')
    expect(stripEditionSuffix('Album (Remastered)')).toBe('Album')
  })

  it('strips trailing edition phrase without parentheses', () => {
    expect(stripEditionSuffix('Analogue 20th Anniversary Deluxe Edition')).toBe('Analogue')
    expect(stripEditionSuffix('Album Deluxe')).toBe('Album')
    expect(stripEditionSuffix('Album Remastered 2020')).toBe('Album')
    expect(stripEditionSuffix('Album 10th Anniversary Edition')).toBe('Album')
  })

  it('returns null when no edition suffix is present', () => {
    expect(stripEditionSuffix('Kid A')).toBeNull()
    expect(stripEditionSuffix('The Bends')).toBeNull()
    expect(stripEditionSuffix('Live À L\'Olympia')).toBeNull()
  })

  it('returns null when the title is all edition words', () => {
    expect(stripEditionSuffix('Deluxe')).toBeNull()
    expect(stripEditionSuffix('Edition')).toBeNull()
  })

  it('returns null when the parenthetical contains no edition keyword', () => {
    // Common non-edition parenthetical on RSD titles: "(Live)", "(Demo)".
    // The helper should leave these alone so the lookup still uses them.
    expect(stripEditionSuffix('Album (Live)')).toBeNull()
    expect(stripEditionSuffix('Album (feat. Someone)')).toBeNull()
  })

  it('handles whitespace noise on the tail', () => {
    expect(stripEditionSuffix('Album  (Deluxe Edition)  ')).toBe('Album')
    expect(stripEditionSuffix('Album Deluxe   ')).toBe('Album')
  })
})
