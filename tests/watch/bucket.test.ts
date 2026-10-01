import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { BucketError, BUCKET_URL, listPdfs, objectUrl, prefixesFor } from '../../scripts/watch/bucket.js'
import { REPO_ROOT } from '../helpers/releases.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const contents = (key: string, etag: string) =>
  `<Contents><Key>${key}</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>&quot;${etag}&quot;</ETag><Size>10</Size></Contents>`
const page = (body: string, next: string | null) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}${body}</ListBucketResult>`
const xml = (body: string) => new HttpResponse(body, { headers: { 'content-type': 'application/xml' } })

describe('listPdfs', () => {
  it('parses the recorded 2026 listing down to its PDFs', async () => {
    const recorded = await readFile(join(REPO_ROOT, 'tests/fixtures/bucket/list-2026.xml'), 'utf8')
    server.use(http.get(BUCKET_URL, () => xml(recorded)))
    const pdfs = await listPdfs('2026/')
    expect(pdfs.map((p) => p.key).sort()).toEqual([
      '2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf',
      '2026/RSD 2026_v2/RSD26_PDF_4-3.pdf',
    ])
    expect(pdfs[0]?.etag).toMatch(/^"[0-9a-f-]+"$/) // multipart uploads add a -N suffix
    expect(pdfs[0]?.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('follows continuation tokens', async () => {
    const seen: (string | null)[] = []
    server.use(
      http.get(BUCKET_URL, ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('list-type')).toBe('2')
        expect(url.searchParams.get('prefix')).toBe('2025/')
        const token = url.searchParams.get('continuation-token')
        seen.push(token)
        return token === 'abc/+='
          ? xml(page(contents('2025/b.pdf', 'bbb'), null))
          : xml(page(contents('2025/a.pdf', 'aaa') + contents('2025/x.xlsx', 'xxx'), 'abc/+='))
      }),
    )
    const pdfs = await listPdfs('2025/')
    expect(pdfs.map((p) => p.key)).toEqual(['2025/a.pdf', '2025/b.pdf'])
    expect(seen).toEqual([null, 'abc/+='])
  })

  it('throws BucketError on 403', async () => {
    server.use(http.get(BUCKET_URL, () => new HttpResponse('<Error>AccessDenied</Error>', { status: 403 })))
    await expect(listPdfs('2026/')).rejects.toBeInstanceOf(BucketError)
  })

  it('throws BucketError on malformed XML', async () => {
    server.use(http.get(BUCKET_URL, () => xml('<html>maintenance</html>')))
    await expect(listPdfs('2026/')).rejects.toThrow(/malformed/)
  })

  it('throws BucketError on a network error', async () => {
    server.use(http.get(BUCKET_URL, () => HttpResponse.error()))
    await expect(listPdfs('2026/')).rejects.toBeInstanceOf(BucketError)
  })
})

describe('prefixesFor', () => {
  it('adds next year from September 1 (UTC)', () => {
    expect(prefixesFor(new Date('2026-08-31T23:59:59Z'))).toEqual(['2026/'])
    expect(prefixesFor(new Date('2026-09-01T00:00:00Z'))).toEqual(['2026/', '2027/'])
  })
})

describe('objectUrl', () => {
  it('objectUrl encodes spaces per segment', () => {
    expect(objectUrl('2025/RSD Black Friday 2025 l/2025_BLACK_FRIDAY_PUBLIC.pdf')).toBe(
      'https://recordstoreday.s3.us-east-1.amazonaws.com/2025/RSD%20Black%20Friday%202025%20l/2025_BLACK_FRIDAY_PUBLIC.pdf',
    )
  })
})
