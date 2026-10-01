import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const SEARCH = 'https://api.discogs.com/database/search'

/** Run enrichDiscogs with its rate-limit sleeps fast-forwarded. */
async function run(input: Parameters<typeof enrichDiscogs>[0]): ReturnType<typeof enrichDiscogs> {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    const pending = enrichDiscogs(input)
    await vi.runAllTimersAsync()
    return await pending
  } finally {
    vi.useRealTimers()
  }
}

describe('enrichDiscogs barcode lookup', () => {
  let queries: URLSearchParams[]
  beforeEach(() => {
    queries = []
    vi.stubEnv('DISCOGS_CONSUMER_KEY', 'k')
    vi.stubEnv('DISCOGS_CONSUMER_SECRET', 's')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('takes the master id of the first barcode hit', async () => {
    server.use(
      http.get(SEARCH, ({ request }) => {
        const q = new URL(request.url).searchParams
        queries.push(q)
        return q.get('barcode') === '075678604034'
          ? HttpResponse.json({ results: [{ id: 1, master_id: 4242 }] })
          : HttpResponse.json({ results: [] })
      }),
    )
    const [out] = await run([{ ...raw, upc: '075678604034' }])
    expect(out?.discogsMasterId).toBe(4242)
    expect(out?.upc).toBe('075678604034')
    expect(queries).toHaveLength(1)
    expect(Object.fromEntries(queries[0] ?? [])).toEqual({
      barcode: '075678604034',
      type: 'release',
      per_page: '1',
    })
  })

  it('falls back to the artist/title search when the barcode misses', async () => {
    server.use(
      http.get(SEARCH, ({ request }) => {
        const q = new URL(request.url).searchParams
        queries.push(q)
        if (q.has('barcode')) return HttpResponse.json({ results: [] })
        return HttpResponse.json({ results: [{ master_id: 777 }] })
      }),
    )
    const [out] = await run([{ ...raw, upc: '075678604034' }])
    expect(out?.discogsMasterId).toBe(777)
    expect(queries.map((q) => q.get('type'))).toEqual(['release', 'master'])
    expect(queries[1]?.get('artist')).toBe('Artist')
    expect(queries[1]?.get('release_title')).toBe('Title')
  })

  it('falls back when the barcode hit has no master', async () => {
    server.use(
      http.get(SEARCH, ({ request }) => {
        const q = new URL(request.url).searchParams
        queries.push(q)
        if (q.has('barcode')) return HttpResponse.json({ results: [{ id: 5 }] })
        return HttpResponse.json({ results: [{ master_id: 778 }] })
      }),
    )
    const [out] = await run([{ ...raw, upc: '075678604034' }])
    expect(out?.discogsMasterId).toBe(778)
    expect(queries).toHaveLength(2)
  })

  it('falls back when the barcode request fails at the network', async () => {
    server.use(
      http.get(SEARCH, ({ request }) => {
        const q = new URL(request.url).searchParams
        queries.push(q)
        if (q.has('barcode')) return HttpResponse.error()
        return HttpResponse.json({ results: [{ master_id: 779 }] })
      }),
    )
    const [out] = await run([{ ...raw, upc: '075678604034' }])
    expect(out?.discogsMasterId).toBe(779)
    expect(queries.map((q) => q.get('type'))).toEqual(['release', 'master'])
  })

  it('searches by artist/title only when there is no UPC', async () => {
    server.use(
      http.get(SEARCH, ({ request }) => {
        queries.push(new URL(request.url).searchParams)
        return HttpResponse.json({ results: [{ master_id: 9 }] })
      }),
    )
    const [out] = await run([raw])
    expect(out?.discogsMasterId).toBe(9)
    expect(queries.some((q) => q.has('barcode'))).toBe(false)
  })

  it('keeps a preset id without any request', async () => {
    // No handler: msw errors on any request.
    const [out] = await run([{ ...raw, upc: '075678604034', discogsMasterId: 31 }])
    expect(out?.discogsMasterId).toBe(31)
    expect(out?.artFilename).toBe('artist-title.jpg')
  })

  it('keeps fields it does not own', async () => {
    const preset = {
      ...raw,
      discogsMasterId: 31,
      tracklist: ['A1. One'],
      quantity: 500,
      rsdUrl: 'https://x.test/1',
    }
    const [out] = await run([preset])
    expect(out).toMatchObject({ tracklist: ['A1. One'], quantity: 500, rsdUrl: 'https://x.test/1' })
  })
})
