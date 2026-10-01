import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createUnlocker, UNLOCKER_ENDPOINT, UnlockerBudgetError, unlockerFromEnv } from '../../scripts/art/brightdata.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const PAGE = 'https://recordstoreday.com/SomePage'

describe('createUnlocker', () => {
  it('POSTs the documented request shape and returns the page text', async () => {
    let seen: { auth: string | null; body: unknown } | null = null
    server.use(
      http.post(UNLOCKER_ENDPOINT, async ({ request }) => {
        seen = { auth: request.headers.get('authorization'), body: await request.json() }
        return HttpResponse.text('<html>ok</html>')
      }),
    )
    const u = createUnlocker({ apiKey: 'k', zone: 'z' })
    expect(await u.fetchPage(PAGE)).toBe('<html>ok</html>')
    expect(seen).toEqual({ auth: 'Bearer k', body: { zone: 'z', url: PAGE, format: 'raw' } })
    expect(u.requestsMade()).toBe(1)
  })

  it('throws on HTTP errors without leaking the api key', async () => {
    server.use(http.post(UNLOCKER_ENDPOINT, () => HttpResponse.text('forbidden', { status: 403 })))
    const u = createUnlocker({ apiKey: 'secret-key-123', zone: 'z' })
    const err = await u.fetchPage(PAGE).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('HTTP 403')
    expect((err as Error).message).not.toContain('secret-key-123')
  })

  it('throws on an empty body', async () => {
    server.use(http.post(UNLOCKER_ENDPOINT, () => HttpResponse.text('  \n')))
    const u = createUnlocker({ apiKey: 'k', zone: 'z' })
    await expect(u.fetchPage(PAGE)).rejects.toThrow(/empty page/)
  })

  it('stops at the request budget without making another request', async () => {
    let calls = 0
    server.use(
      http.post(UNLOCKER_ENDPOINT, () => {
        calls += 1
        return HttpResponse.text('<html>ok</html>')
      }),
    )
    const u = createUnlocker({ apiKey: 'k', zone: 'z', maxRequests: 2 })
    await u.fetchPage(PAGE)
    await u.fetchPage(PAGE)
    await expect(u.fetchPage(PAGE)).rejects.toBeInstanceOf(UnlockerBudgetError)
    expect(calls).toBe(2)
  })
})

describe('unlockerFromEnv', () => {
  it('is null unless both key and zone are set', () => {
    expect(unlockerFromEnv({})).toBeNull()
    expect(unlockerFromEnv({ BRIGHT_DATA_KEY: 'k' })).toBeNull()
    expect(unlockerFromEnv({ BRIGHT_DATA_KEY: 'k', BRIGHT_DATA_ZONE: 'z' })).not.toBeNull()
  })
})
