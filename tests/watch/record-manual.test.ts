import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUCKET_URL, objectUrl } from '../../scripts/watch/bucket.js'
import { bucketKeyFromUrl, recordManualPublish } from '../../scripts/watch/record-manual.js'
import type { SourceEntry } from '../../scripts/watch/sources.js'

const KEY = '2026/RSD Black Friday 2026/2026_BLACK_FRIDAY_PUBLIC.pdf'
const URL_ = `${BUCKET_URL}2026/RSD%20Black%20Friday%202026/2026_BLACK_FRIDAY_PUBLIC.pdf`
const NOW = new Date('2026-10-29T13:30:00Z')

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

let sourcesPath: string
const other: SourceEntry = {
  key: '2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf',
  etag: '"a0a0a0a0"',
  lastModified: '2026-04-16T00:00:00.000Z',
  seasonId: '2026-april',
  outcome: 'published',
  extractor: 'parser',
  processedAt: '2026-10-01T00:00:00.000Z',
}
beforeEach(async () => {
  sourcesPath = join(await mkdtemp(join(tmpdir(), 'wwd-manual-')), 'sources.json')
  await writeFile(sourcesPath, `${JSON.stringify([other], null, 2)}\n`)
})
const onDisk = async (): Promise<SourceEntry[]> => JSON.parse(await readFile(sourcesPath, 'utf8'))

describe('bucketKeyFromUrl', () => {
  it('decodes each path segment of a bucket URL', () => {
    expect(bucketKeyFromUrl(URL_)).toBe(KEY)
    expect(objectUrl(KEY)).toBe(URL_)
  })

  it('ignores a query string', () => {
    expect(bucketKeyFromUrl(`${URL_}?x=1`)).toBe(KEY)
  })

  it('returns null for other hosts, local paths, and the bare bucket', () => {
    expect(bucketKeyFromUrl('https://example.com/list.pdf')).toBeNull()
    expect(bucketKeyFromUrl('tests/fixtures/2025-november.pdf')).toBeNull()
    expect(bucketKeyFromUrl(BUCKET_URL)).toBeNull()
    expect(bucketKeyFromUrl(`${BUCKET_URL}bad%E0%A4%A.pdf`)).toBeNull()
  })
})

describe('recordManualPublish', () => {
  const input = (pdfSource: string, log = vi.fn()) => ({
    pdfSource,
    seasonId: '2026-november',
    extractor: 'gemini' as const,
    sourcesPath,
    now: () => NOW,
    log,
  })

  it('upserts a published entry from the HEAD response', async () => {
    server.use(
      http.head(URL_, () =>
        new HttpResponse(null, {
          headers: { ETag: '"bf26bf26"', 'Last-Modified': 'Wed, 28 Oct 2026 15:00:00 GMT' },
        }),
      ),
    )
    expect(await recordManualPublish(input(URL_))).toBe('recorded')
    const entries = await onDisk()
    expect(entries).toContainEqual(other)
    expect(entries.find((s) => s.key === KEY)).toEqual({
      key: KEY,
      etag: '"bf26bf26"',
      lastModified: '2026-10-28T15:00:00.000Z',
      seasonId: '2026-november',
      outcome: 'published',
      extractor: 'gemini',
      processedAt: NOW.toISOString(),
    })
  })

  it('warns and leaves sources.json alone when HEAD fails', async () => {
    server.use(http.head(URL_, () => new HttpResponse(null, { status: 403 })))
    const log = vi.fn()
    expect(await recordManualPublish(input(URL_, log))).toBe('head-failed')
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/warning.*403/i))
    expect(await onDisk()).toEqual([other])
  })

  it('warns when HEAD lacks ETag or Last-Modified', async () => {
    server.use(http.head(URL_, () => new HttpResponse(null, { headers: { ETag: '"bf26bf26"' } })))
    const log = vi.fn()
    expect(await recordManualPublish(input(URL_, log))).toBe('head-failed')
    expect(await onDisk()).toEqual([other])
  })

  it('warns on a network error', async () => {
    server.use(http.head(URL_, () => HttpResponse.error()))
    expect(await recordManualPublish(input(URL_))).toBe('head-failed')
  })

  it('logs that the watcher will not know about a non-bucket source', async () => {
    const log = vi.fn()
    expect(await recordManualPublish(input('https://example.com/list.pdf', log))).toBe('not-bucket')
    expect(log).toHaveBeenCalledWith(expect.stringContaining("watcher won't know"))
    expect(await onDisk()).toEqual([other])
  })
})
