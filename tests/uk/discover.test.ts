import { describe, expect, it, vi } from 'vitest'

import { discoverUkPdf, pdfLinks } from '../../scripts/uk/discover.js'

const BASE =
  'https://media.recordstoreday.co.uk/storage/v1/object/public/platform-documents/catalogue-pdfs'
const BF = `${BASE}/black-friday/da2f067a-4a4c-414e-9cbd-3e090b57e753.pdf`
const OLDER = `${BASE}/black-friday/00000000-0000-0000-0000-000000000000.pdf`

function fetchFor(html: string, heads: Record<string, { etag: string; lastModified: string }>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'HEAD') {
      const h = heads[u]
      return h
        ? new Response(null, { headers: { etag: h.etag, 'last-modified': h.lastModified } })
        : new Response(null, { status: 404 })
    }
    if (u === 'https://www.recordstoreday.co.uk/black-friday') return new Response(html)
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
}

describe('pdfLinks', () => {
  it('finds each catalogue PDF for the event folder once, ignoring other events', () => {
    const html = `<a href="${BF}">List</a> "${BF}\\" <a href="${BASE}/record-store-day/e33ca3ee-ce1d-449b-b3a5-be03b9635dff.pdf">`
    expect(pdfLinks(html, 'black-friday')).toEqual([BF])
  })
})

describe('discoverUkPdf', () => {
  it('returns the linked PDF with its ETag and Last-Modified', async () => {
    const fetchImpl = fetchFor(`<a href="${BF}">`, {
      [BF]: { etag: '"f4c2109c"', lastModified: 'Wed, 04 Nov 2026 16:48:59 GMT' },
    })
    expect(await discoverUkPdf('2026-november', fetchImpl)).toEqual({
      url: BF,
      etag: '"f4c2109c"',
      lastModified: '2026-11-04T16:48:59.000Z',
    })
  })

  it('picks the newest when the page links several', async () => {
    const fetchImpl = fetchFor(`<a href="${OLDER}"> <a href="${BF}">`, {
      [OLDER]: { etag: '"old"', lastModified: 'Mon, 01 Sep 2025 00:00:00 GMT' },
      [BF]: { etag: '"new"', lastModified: 'Wed, 04 Nov 2026 16:48:59 GMT' },
    })
    expect((await discoverUkPdf('2026-november', fetchImpl))?.url).toBe(BF)
  })

  it('returns null before the page links a PDF', async () => {
    expect(await discoverUkPdf('2026-november', fetchFor('<p>Coming soon</p>', {}))).toBeNull()
  })

  it('throws on an unknown season kind or a failing page', async () => {
    await expect(discoverUkPdf('2026-june', fetchFor('', {}))).rejects.toThrow(
      /no recordstoreday.co.uk event page/,
    )
    const down = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
    await expect(discoverUkPdf('2026-november', down)).rejects.toThrow(/HTTP 503/)
  })
})
