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
  it('returns no-match when auth credentials are missing', async () => {
    const src = createDiscogsSource({})
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('returns no-match when only one half of the key/secret pair is set', async () => {
    const src = createDiscogsSource({ consumerKey: 'k' })
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

    const src = createDiscogsSource({ consumerKey: 'k', consumerSecret: 's' })
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

    const src = createDiscogsSource({ consumerKey: 'k', consumerSecret: 's' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res?.sourceUrl).toBe('https://img.discogs.com/t.jpg')
  })

  it('returns null when Discogs returns an empty results array', async () => {
    server.use(
      http.get('https://api.discogs.com/database/search', () =>
        HttpResponse.json({ results: [] }),
      ),
    )
    const src = createDiscogsSource({ consumerKey: 'k', consumerSecret: 's' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('returns null when Discogs responds 5xx', async () => {
    server.use(
      http.get('https://api.discogs.com/database/search', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    const src = createDiscogsSource({ consumerKey: 'k', consumerSecret: 's' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('returns null when both cover_image and thumb are absent', async () => {
    server.use(
      http.get('https://api.discogs.com/database/search', () =>
        HttpResponse.json({ results: [{ master_id: 1 }] }),
      ),
    )
    const src = createDiscogsSource({ consumerKey: 'k', consumerSecret: 's' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('retries once with an edition suffix stripped when the first search misses', async () => {
    const capturedTitles: string[] = []
    server.use(
      http.get('https://api.discogs.com/database/search', ({ request }) => {
        const url = new URL(request.url)
        const title = url.searchParams.get('release_title') ?? ''
        capturedTitles.push(title)
        // First search ("…Deluxe Edition") misses; retry with the bare
        // title ("Low Tide at Dawn") returns a hit.
        if (title.toLowerCase().includes('deluxe')) {
          return HttpResponse.json({ results: [] })
        }
        return HttpResponse.json({
          results: [{ cover_image: 'https://img.discogs.com/bare.jpg' }],
        })
      }),
    )

    const decorated: RawRelease = { ...SAMPLE_RELEASE, title: 'Low Tide at Dawn (Deluxe Edition)' }
    const src = createDiscogsSource({ consumerKey: 'k', consumerSecret: 's' })
    const res = await src.lookup(decorated)
    expect(res?.sourceUrl).toBe('https://img.discogs.com/bare.jpg')
    expect(capturedTitles).toEqual(['Low Tide at Dawn (Deluxe Edition)', 'Low Tide at Dawn'])
  })

  it('does not retry when the title has no strippable suffix', async () => {
    let calls = 0
    server.use(
      http.get('https://api.discogs.com/database/search', () => {
        calls += 1
        return HttpResponse.json({ results: [] })
      }),
    )

    const src = createDiscogsSource({ consumerKey: 'k', consumerSecret: 's' })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
    expect(calls).toBe(1)
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
    const src = createDiscogsSource({ consumerKey: 'mykey', consumerSecret: 'mysecret' })
    await src.lookup(SAMPLE_RELEASE)
    expect(capturedAuth).toBe('Discogs key=mykey, secret=mysecret')
    expect(capturedUA).toContain('wax-wishlist-data')
  })
})
