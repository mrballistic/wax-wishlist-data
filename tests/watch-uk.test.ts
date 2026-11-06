import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UkListMismatchError } from '../scripts/ingest-uk.js'
import type { UkPdfLink } from '../scripts/uk/discover.js'
import type { UkMatchResult } from '../scripts/uk/merge.js'
import { runWatchUk, ukIssueTitle, type WatchUkDeps } from '../scripts/watch-uk.js'

const SEASON = '2026-november'
const URL_A =
  'https://media.recordstoreday.co.uk/storage/v1/object/public/platform-documents/catalogue-pdfs/black-friday/a.pdf'
const LINK: UkPdfLink = { url: URL_A, etag: '"e1"', lastModified: '2026-11-04T16:48:59.000Z' }
const RESULT: UkMatchResult = { matches: [], ukOnly: [], uncertain: [], staleOverrides: [] }

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wwd-watchuk-'))
  await writeFile(
    join(root, 'current.json'),
    JSON.stringify({
      id: SEASON,
      label: 'Black Friday Drop 2026',
      date: '2026-11-27',
      status: 'upcoming',
      releasesUrl: 'https://example.com/r.json',
      artBaseUrl: 'https://example.com/art/',
    }),
  )
  await mkdir(join(root, 'releases', SEASON), { recursive: true })
  await writeFile(join(root, 'releases', SEASON, 'releases.json'), '[]')
})

const saveUk = (sourceUrl: string, etag?: string) =>
  writeFile(
    join(root, 'releases', SEASON, 'uk.json'),
    JSON.stringify({
      sourceUrl,
      ...(etag ? { etag } : {}),
      fetchedAt: '2026-11-05T00:00:00.000Z',
      rows: [{ artist: 'A', title: 'T', label: 'L', format: 'LP' }],
    }),
  )

function deps(over: Partial<WatchUkDeps> = {}) {
  return {
    today: () => '2026-11-06',
    discover: vi.fn(async () => LINK),
    ingest: vi.fn(async () => RESULT),
    issues: {
      ensure: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      closeByPrefix: vi.fn(async () => {}),
    },
    log: () => {},
    ...over,
  } satisfies WatchUkDeps
}

describe('runWatchUk', () => {
  it('merges a newly linked PDF with its ETag and closes the issue', async () => {
    const d = deps()
    const out = await runWatchUk({ repoRoot: root }, d)
    expect(out.kind).toBe('merged')
    expect(d.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ seasonId: SEASON, pdfUrl: URL_A, etag: '"e1"', dryRun: undefined }),
    )
    expect(d.issues.close).toHaveBeenCalledWith(ukIssueTitle(SEASON), expect.any(String))
  })

  it('does nothing when the URL and ETag match uk.json', async () => {
    await saveUk(URL_A, '"e1"')
    const d = deps()
    expect((await runWatchUk({ repoRoot: root }, d)).kind).toBe('unchanged')
    expect(d.ingest).not.toHaveBeenCalled()
  })

  it('re-merges a revision (same URL, new ETag)', async () => {
    await saveUk(URL_A, '"e0"')
    const d = deps()
    expect((await runWatchUk({ repoRoot: root }, d)).kind).toBe('merged')
  })

  it('waits for the US list', async () => {
    await rm(join(root, 'releases', SEASON, 'releases.json'))
    const d = deps()
    expect((await runWatchUk({ repoRoot: root }, d)).kind).toBe('no-us-list')
    expect(d.discover).not.toHaveBeenCalled()
  })

  it('stops once the season’s date has passed', async () => {
    const d = deps({ today: () => '2026-11-28' })
    expect((await runWatchUk({ repoRoot: root }, d)).kind).toBe('no-season')
    expect(d.discover).not.toHaveBeenCalled()
  })

  it('waits quietly while nothing is linked', async () => {
    const d = deps({ discover: vi.fn(async () => null) })
    expect((await runWatchUk({ repoRoot: root }, d)).kind).toBe('not-linked')
  })

  it('skips a PDF far older than the season', async () => {
    const d = deps({
      discover: vi.fn(async () => ({ ...LINK, lastModified: '2025-11-01T00:00:00.000Z' })),
    })
    expect((await runWatchUk({ repoRoot: root }, d)).kind).toBe('stale')
    expect(d.ingest).not.toHaveBeenCalled()
  })

  it('waits quietly, without an issue, when the list is another event’s', async () => {
    const d = deps({
      ingest: vi.fn(async () => {
        throw new UkListMismatchError('Only 3 of 160 UK rows match')
      }),
    })
    expect((await runWatchUk({ repoRoot: root }, d)).kind).toBe('other-event')
    expect(d.issues.ensure).not.toHaveBeenCalled()
  })

  it('opens one issue and rethrows on a real failure', async () => {
    const d = deps({
      discover: vi.fn(async () => {
        throw new Error('HTTP 503 fetching https://www.recordstoreday.co.uk/black-friday')
      }),
    })
    await expect(runWatchUk({ repoRoot: root }, d)).rejects.toThrow(/503/)
    expect(d.issues.ensure).toHaveBeenCalledWith(
      ukIssueTitle(SEASON),
      expect.stringContaining('503'),
    )
  })

  it('files and closes nothing on a dry run', async () => {
    const d = deps()
    await runWatchUk({ repoRoot: root, dryRun: true }, d)
    expect(d.ingest).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
    expect(d.issues.close).not.toHaveBeenCalled()
  })
})
