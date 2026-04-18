import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createMusicBrainzSource,
  MUSICBRAINZ_USER_AGENT,
} from '../../scripts/sources/musicbrainz.js'
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

const MBID = '11111111-2222-3333-4444-555555555555'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const noSleep = (): Promise<void> => Promise.resolve()

describe('musicbrainz source', () => {
  it('sends the hardcoded User-Agent on the search request', async () => {
    let capturedUA: string | null = null
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', ({ request }) => {
        capturedUA = request.headers.get('user-agent')
        return HttpResponse.json({ releases: [] })
      }),
    )
    const src = createMusicBrainzSource({ sleepImpl: noSleep })
    await src.lookup(SAMPLE_RELEASE)
    expect(capturedUA).toBe(MUSICBRAINZ_USER_AGENT)
  })

  it('returns a lookup result when a score >= 90 hit exists and CAA redirects', async () => {
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', () =>
        HttpResponse.json({
          releases: [
            { id: MBID, score: 95, title: 'Low Tide at Dawn' },
            { id: 'other', score: 80 },
          ],
        }),
      ),
      http.get(`https://coverartarchive.org/release/${MBID}/front`, () =>
        HttpResponse.redirect('https://archive.org/download/blah/front.jpg', 307),
      ),
    )

    const src = createMusicBrainzSource({ sleepImpl: noSleep })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).not.toBeNull()
    expect(res?.tier).toBe('musicbrainz')
    expect(res?.sourceUrl).toBe(`https://coverartarchive.org/release/${MBID}/front`)
    expect(res?.artFilename).toBe('2026-april-042.jpg')
  })

  it('rejects a hit with score < 90 and returns null', async () => {
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', () =>
        HttpResponse.json({
          releases: [{ id: MBID, score: 85, title: 'Low Tide at Dawn' }],
        }),
      ),
    )
    const src = createMusicBrainzSource({ sleepImpl: noSleep })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('returns null when MB search returns no hits', async () => {
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', () =>
        HttpResponse.json({ releases: [] }),
      ),
    )
    const src = createMusicBrainzSource({ sleepImpl: noSleep })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('returns null when CAA responds 404 (no front cover for mbid)', async () => {
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', () =>
        HttpResponse.json({ releases: [{ id: MBID, score: 99 }] }),
      ),
      http.get(`https://coverartarchive.org/release/${MBID}/front`, () =>
        HttpResponse.text('Not Found', { status: 404 }),
      ),
    )
    const src = createMusicBrainzSource({ sleepImpl: noSleep })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('retries on HTTP 503 up to 3 times, then succeeds', async () => {
    let attempts = 0
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', () => {
        attempts += 1
        if (attempts <= 2) {
          return HttpResponse.text('busy', { status: 503 })
        }
        return HttpResponse.json({ releases: [{ id: MBID, score: 95 }] })
      }),
      http.get(`https://coverartarchive.org/release/${MBID}/front`, () =>
        HttpResponse.redirect('https://archive.org/download/x/front.jpg', 307),
      ),
    )

    const sleepSpy = vi.fn(noSleep)
    const src = createMusicBrainzSource({ sleepImpl: sleepSpy })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).not.toBeNull()
    expect(attempts).toBe(3)
    // Called for rate-limit before each attempt (3) + 2 exponential-backoff sleeps
    // between retries + 1 rate-limit before CAA is not called (CAA has no sleep).
    expect(sleepSpy.mock.calls.length).toBeGreaterThanOrEqual(5)
  })

  it('gives up after 3 retries of persistent 503', async () => {
    let attempts = 0
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', () => {
        attempts += 1
        return HttpResponse.text('down', { status: 503 })
      }),
    )
    const src = createMusicBrainzSource({ sleepImpl: noSleep })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
    // Initial + 3 retries = 4 attempts
    expect(attempts).toBe(4)
  })

  it('treats HTTP 400 as no-match (does not retry)', async () => {
    let attempts = 0
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', () => {
        attempts += 1
        return HttpResponse.text('bad query', { status: 400 })
      }),
    )
    const src = createMusicBrainzSource({ sleepImpl: noSleep })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
    expect(attempts).toBe(1)
  })

  it('escapes double quotes in the Lucene query', async () => {
    let capturedQuery: string | null = null
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', ({ request }) => {
        capturedQuery = new URL(request.url).searchParams.get('query')
        return HttpResponse.json({ releases: [] })
      }),
    )
    const src = createMusicBrainzSource({ sleepImpl: noSleep })
    await src.lookup({ ...SAMPLE_RELEASE, title: 'She said "hi"' })
    expect(capturedQuery).toContain('release:"She said \\"hi\\""')
  })

  it('sleeps before each MB request to respect 1 req/sec rate limit', async () => {
    const sleepSpy = vi.fn(noSleep)
    server.use(
      http.get('https://musicbrainz.org/ws/2/release/', () =>
        HttpResponse.json({ releases: [] }),
      ),
    )
    const src = createMusicBrainzSource({ sleepImpl: sleepSpy })
    await src.lookup(SAMPLE_RELEASE)
    // One MB call → at least one sleep at 1000ms
    expect(sleepSpy).toHaveBeenCalledWith(1000)
  })
})
