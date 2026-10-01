import { afterEach, describe, expect, it, vi } from 'vitest'

import { enrichDiscogs } from '../scripts/enrich-discogs.js'
import type { RawRelease } from '../scripts/types.js'

const raw: RawRelease = {
  id: 'artist-title',
  artist: 'Artist',
  title: 'Title',
  label: 'Label',
  format: 'LP',
  category: 'exclusive',
  description: '',
}

// artFilename is the release's art *slot*, not a claim that the file exists:
// wax-wishlist-art-admin lists releases whose slot is empty and commits the
// image to exactly that filename, so it must never be null.
describe('enrichDiscogs artFilename slot', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('assigns <id>.jpg when Discogs credentials are absent', async () => {
    vi.stubEnv('DISCOGS_CONSUMER_KEY', '')
    vi.stubEnv('DISCOGS_CONSUMER_SECRET', '')
    const [out] = await enrichDiscogs([raw])
    expect(out?.artFilename).toBe('artist-title.jpg')
    expect(out?.discogsMasterId).toBeNull()
  })

  it('assigns <id>.jpg when the Discogs lookup throws', async () => {
    vi.useFakeTimers()
    vi.stubEnv('DISCOGS_CONSUMER_KEY', 'k')
    vi.stubEnv('DISCOGS_CONSUMER_SECRET', 's')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const pending = enrichDiscogs([raw])
    await vi.runAllTimersAsync()
    const [out] = await pending
    vi.useRealTimers()
    expect(out?.artFilename).toBe('artist-title.jpg')
    expect(out?.discogsMasterId).toBeNull()
  })
})
