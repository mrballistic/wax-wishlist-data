import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createDiscogsSource } from '../../scripts/sources/discogs.js'
import type { RawRelease } from '../../scripts/types.js'

const SAMPLE_RELEASE: RawRelease = {
  id: '2026-april-042',
  artist: 'Azure Parallax',
  title: 'Low Tide at Dawn',
  label: 'Halcyon Pressing Co.',
  format: 'LP',
  category: 'Exclusive Release',
  description: '',
}

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('discogs source', () => {
  it('returns no-match when no auth token is configured', async () => {
    const src = createDiscogsSource({})
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('returns a lookup result with cover_image on a hit', async () => {
    server.use(
      http.get('https://api.discogs.com/database/search', () =>
        HttpResponse.json({
          results: [
            {
              master_id: 12345,
              id: 99999,
              cover_image: 'https://img.discogs.com/xyz/cover.jpg',
              thumb: 'https://img.discogs.com/xyz/thumb.jpg',
            },
          ],
        }),
      ),
    )

    const src = createDiscogsSource({ token: 'test-token' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).not.toBeNull()
    expect(res?.tier).toBe('discogs')
    expect(res?.sourceUrl).toBe('https://img.discogs.com/xyz/cover.jpg')
    expect(res?.artFilename).toBe('2026-april-042.jpg')
    expect(res?.releaseId).toBe('2026-april-042')
  })

  it('falls back to thumb when cover_image is missing', async () => {
    server.use(
      http.get('https://api.discogs.com/database/search', () =>
        HttpResponse.json({
          results: [{ master_id: 12345, thumb: 'https://img.discogs.com/t.jpg' }],
        }),
      ),
    )

    const src = createDiscogsSource({ token: 't' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res?.sourceUrl).toBe('https://img.discogs.com/t.jpg')
  })

  it('returns null when Discogs returns an empty results array', async () => {
    server.use(
      http.get('https://api.discogs.com/database/search', () =>
        HttpResponse.json({ results: [] }),
      ),
    )
    const src = createDiscogsSource({ token: 't' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('returns null when Discogs responds 5xx', async () => {
    server.use(
      http.get('https://api.discogs.com/database/search', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    const src = createDiscogsSource({ token: 't' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('returns null when both cover_image and thumb are absent', async () => {
    server.use(
      http.get('https://api.discogs.com/database/search', () =>
        HttpResponse.json({ results: [{ master_id: 1 }] }),
      ),
    )
    const src = createDiscogsSource({ token: 't' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('sends the auth and user-agent headers on the lookup request', async () => {
    let capturedAuth: string | null = null
    let capturedUA: string | null = null
    server.use(
      http.get('https://api.discogs.com/database/search', ({ request }) => {
        capturedAuth = request.headers.get('authorization')
        capturedUA = request.headers.get('user-agent')
        return HttpResponse.json({
          results: [{ cover_image: 'https://img.discogs.com/x.jpg' }],
        })
      }),
    )
    const src = createDiscogsSource({ token: 'mytok' })
    await src.lookup(SAMPLE_RELEASE)
    expect(capturedAuth).toBe('Discogs token=mytok')
    expect(capturedUA).toContain('wax-wishlist-data')
  })
})
