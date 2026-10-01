import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  createGitHubIssueClient,
  etagShort,
  failureIssueTitle,
  incompleteIssueTitle,
  seasonIssuePrefix,
} from '../../scripts/watch/issues.js'

const API = 'https://api.github.com/repos/mrballistic/wax-wishlist-data'
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const client = createGitHubIssueClient({ token: 't', repo: 'mrballistic/wax-wishlist-data' })
const issue = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ number, title, ...extra })

describe('issue titles', () => {
  it('formats the incomplete-rows title and keeps it out of the failure prefix', () => {
    const title = incompleteIssueTitle('2026-november', '"9f1c2ab4ee0011"')
    expect(title).toBe('watch-rsd: 2026-november published without incomplete rows (9f1c2ab4)')
    expect(title.startsWith(seasonIssuePrefix('2026-november'))).toBe(false)
  })

  it('formats the failure title with a short ETag', () => {
    expect(etagShort('"9f1c2ab4ee0011"')).toBe('9f1c2ab4')
    expect(failureIssueTitle('2026-november', '"9f1c2ab4ee0011"')).toBe(
      'watch-rsd: could not publish 2026-november (9f1c2ab4)',
    )
    expect(failureIssueTitle('2026-november', '"x"').startsWith(seasonIssuePrefix('2026-november'))).toBe(true)
  })
})

describe('GitHub issue client', () => {
  it('creates an issue when no open issue has the title', async () => {
    let created: unknown = null
    server.use(
      http.get(`${API}/issues`, () => HttpResponse.json([issue(1, 'something else')])),
      http.post(`${API}/issues`, async ({ request }) => {
        created = await request.json()
        return HttpResponse.json(issue(2, 'x'), { status: 201 })
      }),
    )
    await client.ensure('watch-rsd: bucket unreachable', 'body')
    expect(created).toEqual({ title: 'watch-rsd: bucket unreachable', body: 'body' })
  })

  it('does nothing when an open issue already has the title', async () => {
    let posts = 0
    server.use(
      http.get(`${API}/issues`, () => HttpResponse.json([issue(1, 'watch-rsd: bucket unreachable')])),
      http.post(`${API}/issues`, () => {
        posts++
        return HttpResponse.json(issue(2, 'x'), { status: 201 })
      }),
    )
    await client.ensure('watch-rsd: bucket unreachable', 'body')
    expect(posts).toBe(0)
  })

  it('ignores pull requests when matching titles', async () => {
    let posted = false
    server.use(
      http.get(`${API}/issues`, () =>
        HttpResponse.json([issue(1, 'watch-rsd: bucket unreachable', { pull_request: {} })]),
      ),
      http.post(`${API}/issues`, () => {
        posted = true
        return HttpResponse.json(issue(2, 'x'), { status: 201 })
      }),
    )
    await client.ensure('watch-rsd: bucket unreachable', 'body')
    expect(posted).toBe(true)
  })

  it('pages through open issues', async () => {
    let posts = 0
    const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 10, `other ${i}`))
    server.use(
      http.get(`${API}/issues`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page')
        return HttpResponse.json(page === '2' ? [issue(500, 'watch-rsd: bucket unreachable')] : page1)
      }),
      http.post(`${API}/issues`, () => {
        posts++
        return HttpResponse.json(issue(2, 'x'), { status: 201 })
      }),
    )
    await client.ensure('watch-rsd: bucket unreachable', 'body') // found on page 2 → no POST
    expect(posts).toBe(0)
  })

  it('comments on and closes every issue matching a prefix', async () => {
    const actions: string[] = []
    server.use(
      http.get(`${API}/issues`, () =>
        HttpResponse.json([
          issue(7, 'watch-rsd: could not publish 2026-november (aaaa1111)'),
          issue(8, 'watch-rsd: could not publish 2026-april (bbbb2222)'),
        ]),
      ),
      http.post(`${API}/issues/:n/comments`, ({ params }) => {
        actions.push(`comment ${String(params['n'])}`)
        return HttpResponse.json({}, { status: 201 })
      }),
      http.patch(`${API}/issues/:n`, async ({ params, request }) => {
        actions.push(`close ${String(params['n'])} ${JSON.stringify(await request.json())}`)
        return HttpResponse.json({})
      }),
    )
    await client.closeByPrefix(seasonIssuePrefix('2026-november'), 'Published in abc123.')
    expect(actions).toEqual(['comment 7', 'close 7 {"state":"closed","state_reason":"completed"}'])
  })

  it('truncates very long bodies', async () => {
    let body = ''
    server.use(
      http.get(`${API}/issues`, () => HttpResponse.json([])),
      http.post(`${API}/issues`, async ({ request }) => {
        body = ((await request.json()) as { body: string }).body
        return HttpResponse.json(issue(2, 'x'), { status: 201 })
      }),
    )
    await client.ensure('t', 'x'.repeat(70_000))
    expect(body.length).toBeLessThanOrEqual(60_100)
    expect(body).toContain('truncated')
  })

  it('throws on a GitHub API error', async () => {
    server.use(http.get(`${API}/issues`, () => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 })))
    await expect(client.ensure('t', 'b')).rejects.toThrow(/401/)
  })
})
