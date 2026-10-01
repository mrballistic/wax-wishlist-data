import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExtractedRow, Extractor, ExtractorName } from '../../scripts/extract/types.js'
import { BucketError } from '../../scripts/watch/bucket.js'
import type { IssueClient } from '../../scripts/watch/issues.js'
import { runWatch, type WatchDeps } from '../../scripts/watch/run.js'
import type { BucketObject, SourceEntry } from '../../scripts/watch/sources.js'
import { loadRaw, REPO_ROOT, toRows } from '../helpers/releases.js'

const NOW = new Date('2026-10-29T13:30:00Z') // lists 2026/ and 2027/
const APRIL_KEY = '2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf'
const BF_KEY = '2026/RSD Black Friday 2026/2026_BLACK_FRIDAY_PUBLIC.pdf'

const obj = (key: string, etag: string, lastModified: string): BucketObject => ({ key, etag, lastModified, size: 1 })
const APRIL = obj(APRIL_KEY, '"a0a0a0a0"', '2026-04-16T00:00:00.000Z')
const BF = obj(BF_KEY, '"bf26bf26"', '2026-10-28T15:00:00.000Z')

let novemberRows: ExtractedRow[]
let aprilRows: ExtractedRow[]
beforeAll(async () => {
  novemberRows = toRows(await loadRaw('2025-november'))
  aprilRows = toRows(await loadRaw('2026-april'))
})

let repo: string
let sourcesPath: string
const seeded: SourceEntry[] = [
  {
    key: APRIL_KEY,
    etag: APRIL.etag,
    lastModified: APRIL.lastModified,
    seasonId: '2026-april',
    outcome: 'published',
    extractor: 'parser',
    processedAt: '2026-10-01T00:00:00.000Z',
  },
]

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'wwd-watch-'))
  for (const f of ['seasons.json', 'current.json', 'calendar.json']) await cp(join(REPO_ROOT, f), join(repo, f))
  for (const season of ['2025-november', '2026-april']) {
    await mkdir(join(repo, 'releases', season), { recursive: true })
    await cp(join(REPO_ROOT, 'releases', season, 'releases.json'), join(repo, 'releases', season, 'releases.json'))
  }
  sourcesPath = join(repo, 'sources.json')
  await writeFile(sourcesPath, `${JSON.stringify(seeded, null, 2)}\n`)
})

const extractor = (name: ExtractorName, impl: () => Promise<ExtractedRow[]>): Extractor => ({
  name,
  extract: vi.fn(impl),
})

function deps(listing: BucketObject[], extractors: Extractor[], overrides: Partial<WatchDeps> = {}) {
  const issues: IssueClient = {
    ensure: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeByPrefix: vi.fn(async () => {}),
  }
  const d: WatchDeps = {
    now: () => NOW,
    listBucket: vi.fn(async (prefix: string) => listing.filter((o) => o.key.startsWith(prefix))),
    fetchPdf: vi.fn(async () => Buffer.from('%PDF fake')),
    pdfText: async () => '',
    extractors,
    publish: vi.fn(async () => {}),
    issues,
    git: { commitAndPush: vi.fn(async () => 'abc1234') },
    summary: vi.fn(async () => {}),
    log: () => {},
    ...overrides,
  }
  return d
}
const opts = (dryRun = false) => ({ repoRoot: repo, sourcesPath, dryRun })
const sourcesOnDisk = async (): Promise<SourceEntry[]> => JSON.parse(await readFile(sourcesPath, 'utf8'))

describe('runWatch', () => {
  it('publishes a new Black Friday list', async () => {
    const d = deps([APRIL, BF], [extractor('parser', async () => novemberRows)])
    const out = await runWatch(opts(), d)

    expect(out).toEqual([{ key: BF_KEY, seasonId: '2026-november', outcome: 'published', extractor: 'parser' }])
    expect(d.publish).toHaveBeenCalledWith(
      expect.objectContaining({ seasonId: '2026-november', date: '2026-11-27', repoRoot: repo }),
    )
    expect(d.git.commitAndPush).toHaveBeenCalledWith(
      `chore: ingest 2026-november from ${BF_KEY} (parser)`,
      ['current.json', 'seasons.json', 'sources.json', 'releases/2026-november'],
    )
    expect(d.issues.closeByPrefix).toHaveBeenCalledWith(
      'watch-rsd: could not publish 2026-november (',
      expect.stringContaining('abc1234'),
    )
    expect(d.issues.close).toHaveBeenCalledWith('watch-rsd: bucket unreachable', expect.any(String))
    expect(d.git.commitAndPush).toHaveBeenCalledTimes(1)
    expect((await sourcesOnDisk()).find((s) => s.key === BF_KEY)).toMatchObject({
      outcome: 'published',
      etag: BF.etag,
      extractor: 'parser',
    })
  })

  it('publishes a revision (changed ETag) within bounds', async () => {
    const revised = { ...APRIL, etag: '"a1a1a1a1"', lastModified: '2026-04-17T00:00:00.000Z' }
    const d = deps([revised], [extractor('parser', async () => aprilRows)])
    const out = await runWatch(opts(), d)
    expect(out[0]).toMatchObject({ seasonId: '2026-april', outcome: 'published' })
    expect(d.summary).toHaveBeenCalledWith(expect.stringContaining('Revision of 353 releases'))
  })

  it('fails a revision that removes too much and opens one issue', async () => {
    const revised = { ...APRIL, etag: '"a1a1a1a1"', lastModified: '2026-04-17T00:00:00.000Z' }
    const d = deps([revised], [extractor('parser', async () => aprilRows.slice(0, 250))])
    const out = await runWatch(opts(), d)
    expect(out[0]).toMatchObject({ outcome: 'failed' })
    expect(d.publish).not.toHaveBeenCalled()
    expect(d.issues.ensure).toHaveBeenCalledWith(
      'watch-rsd: could not publish 2026-april (a1a1a1a1)',
      expect.stringContaining('revision removes'),
    )
    expect((await sourcesOnDisk()).find((s) => s.key === APRIL_KEY)?.outcome).toBe('failed')
  })

  it('processes only the newest of two new keys for one season', async () => {
    const older = obj('2026/BF draft/2026_BLACK_FRIDAY_PUBLIC.pdf', '"0ld0ld00"', '2026-10-20T00:00:00.000Z')
    const parser = extractor('parser', async () => novemberRows)
    const d = deps([APRIL, older, BF], [parser])
    const out = await runWatch(opts(), d)
    expect(out).toEqual(
      expect.arrayContaining([
        { key: older.key, seasonId: '2026-november', outcome: 'superseded', extractor: null },
        { key: BF_KEY, seasonId: '2026-november', outcome: 'published', extractor: 'parser' },
      ]),
    )
    expect(parser.extract).toHaveBeenCalledTimes(1)
  })

  it('falls back to an older list when the newest candidate is not a list', async () => {
    const pledge = obj('2026/RSD Black Friday 2026/RSD_BF26_Pledge_Form.pdf', '"91ed9e01"', '2026-10-28T18:00:00.000Z')
    const parser = extractor('parser', async () => novemberRows)
    vi.mocked(parser.extract).mockImplementation(async (pdf: Buffer) => {
      if (pdf.toString() === pledge.key) throw new Error('Could not detect a 5-column grid')
      return novemberRows
    })
    const gemini = extractor('gemini', async () => [])
    const d = deps([APRIL, BF, pledge], [parser, gemini], {
      fetchPdf: vi.fn(async (key: string) => Buffer.from(key)),
    })
    const out = await runWatch(opts(), d)
    expect(out).toEqual(
      expect.arrayContaining([
        { key: pledge.key, seasonId: null, outcome: 'not-a-list', extractor: null },
        { key: BF_KEY, seasonId: '2026-november', outcome: 'published', extractor: 'parser' },
      ]),
    )
    expect(out).toHaveLength(2)
    expect(d.publish).toHaveBeenCalledTimes(1)
    expect(d.issues.ensure).not.toHaveBeenCalled()
  })

  it('keeps going after a publish failure and rejects at the end', async () => {
    const april27 = obj('2027/RSD 2027/2027_RSD_PUBLIC_PDF.pdf', '"27272727"', '2026-10-15T00:00:00.000Z')
    const calendar = JSON.parse(await readFile(join(repo, 'calendar.json'), 'utf8'))
    await writeFile(join(repo, 'calendar.json'), JSON.stringify({ ...calendar, '2027': '2027-04-17' }))
    const publish = vi.fn(async (input: { seasonId: string }) => {
      if (input.seasonId === '2026-november') throw new Error('Discogs exploded')
    })
    const parser = extractor('parser', async () => novemberRows)
    vi.mocked(parser.extract).mockImplementation(async (pdf: Buffer) =>
      pdf.toString() === april27.key ? aprilRows : novemberRows,
    )
    const d = deps([APRIL, BF, april27], [parser], {
      publish,
      fetchPdf: vi.fn(async (key: string) => Buffer.from(key)),
    })
    await expect(runWatch(opts(), d)).rejects.toThrow(/2026-november/)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ seasonId: '2027-april' }))
    expect(d.issues.ensure).toHaveBeenCalledWith(
      'watch-rsd: could not publish 2026-november (bf26bf26)',
      expect.stringContaining('Discogs exploded'),
    )
    const onDisk = await sourcesOnDisk()
    expect(onDisk.find((s) => s.key === BF_KEY)?.outcome).toBe('failed')
    expect(onDisk.find((s) => s.key === april27.key)?.outcome).toBe('published')
  })

  it('pending key older than the published copy is superseded', async () => {
    const stale = obj('2026/old/2026_RSD_PUBLIC_PDF.pdf', '"57a1e000"', '2026-03-01T00:00:00.000Z')
    const parser = extractor('parser', async () => aprilRows)
    const d = deps([APRIL, stale], [parser])
    const out = await runWatch(opts(), d)
    expect(out).toEqual([{ key: stale.key, seasonId: '2026-april', outcome: 'superseded', extractor: null }])
    expect(parser.extract).not.toHaveBeenCalled()
    expect(d.publish).not.toHaveBeenCalled()
  })

  it('records a non-list PDF as not-a-list without an issue', async () => {
    const pledge = obj('2026/Forms/RSD26_Pledge_Form.pdf', '"91ed9e00"', '2026-10-01T00:00:00.000Z')
    const d = deps(
      [APRIL, pledge],
      [
        extractor('parser', async () => {
          throw new Error('Could not detect a 5-column grid')
        }),
        extractor('gemini', async () => []),
      ],
    )
    const out = await runWatch(opts(), d)
    expect(out).toEqual([{ key: pledge.key, seasonId: null, outcome: 'not-a-list', extractor: null }])
    expect(d.issues.ensure).not.toHaveBeenCalled()
  })

  it('fails (with an issue) instead of not-a-list when no LLM ran', async () => {
    const pledge = obj('2026/Forms/RSD26_Pledge_Form.pdf', '"91ed9e00"', '2026-10-01T00:00:00.000Z')
    const d = deps(
      [APRIL, pledge],
      [
        extractor('parser', async () => {
          throw new Error('Could not detect a 5-column grid')
        }),
      ],
    )
    const out = await runWatch(opts(), d)
    expect(out[0]?.outcome).toBe('failed')
    expect(d.issues.ensure).toHaveBeenCalledTimes(1)
  })

  it('skips country lists without downloading them', async () => {
    const italia = obj('2026/RSD_2026_Italia/2026_RSD_PUBLIC_PDF_Italia.pdf', '"17a11a00"', '2026-02-01T00:00:00.000Z')
    const d = deps([APRIL, italia], [extractor('parser', async () => aprilRows)])
    const out = await runWatch(opts(), d)
    expect(out).toEqual([{ key: italia.key, seasonId: null, outcome: 'skipped-country', extractor: null }])
    expect(d.fetchPdf).not.toHaveBeenCalled()
    expect(d.git.commitAndPush).toHaveBeenCalledWith('chore: watch-rsd state', ['sources.json'])
  })

  it('opens the bucket issue and rethrows when listing fails', async () => {
    const d = deps([], [], {
      listBucket: vi.fn(async () => {
        throw new BucketError('HTTP 403 listing 2026/')
      }),
    })
    await expect(runWatch(opts(), d)).rejects.toThrow(/403/)
    expect(d.issues.ensure).toHaveBeenCalledWith('watch-rsd: bucket unreachable', expect.stringContaining('403'))
  })

  it('repeat failure with same ETag opens no new state commit', async () => {
    const failed: SourceEntry = {
      key: BF_KEY,
      etag: BF.etag,
      lastModified: BF.lastModified,
      seasonId: '2026-november',
      outcome: 'failed',
      extractor: null,
      processedAt: '2026-10-28T13:30:00.000Z',
    }
    await writeFile(sourcesPath, `${JSON.stringify([...seeded, failed], null, 2)}\n`)
    const d = deps([APRIL, BF], [extractor('parser', async () => novemberRows.slice(0, 10))])
    const out = await runWatch(opts(), d)
    expect(out[0]?.outcome).toBe('failed')
    expect(d.issues.ensure).toHaveBeenCalledTimes(1) // the client dedupes by title
    expect(d.git.commitAndPush).not.toHaveBeenCalled()
  })

  it('fails an April season with no calendar date before downloading', async () => {
    const april27 = obj('2027/RSD 2027/2027_RSD_PUBLIC_PDF.pdf', '"27272727"', '2026-10-15T00:00:00.000Z')
    const d = deps([APRIL, april27], [extractor('parser', async () => aprilRows)])
    const out = await runWatch(opts(), d)
    expect(out[0]).toMatchObject({ seasonId: '2027-april', outcome: 'failed' })
    expect(d.fetchPdf).not.toHaveBeenCalled()
    expect(d.issues.ensure).toHaveBeenCalledWith(
      'watch-rsd: could not publish 2027-april (27272727)',
      expect.stringContaining('calendar.json'),
    )
  })

  it('dry run reports but writes, publishes, commits and files nothing', async () => {
    const before = await readFile(sourcesPath, 'utf8')
    const d = deps([APRIL, BF], [extractor('parser', async () => novemberRows)])
    const out = await runWatch(opts(true), d)
    expect(out[0]).toMatchObject({ outcome: 'published', seasonId: '2026-november' })
    expect(d.publish).not.toHaveBeenCalled()
    expect(d.git.commitAndPush).not.toHaveBeenCalled()
    expect(d.issues.ensure).not.toHaveBeenCalled()
    expect(d.issues.close).not.toHaveBeenCalled()
    expect(await readFile(sourcesPath, 'utf8')).toBe(before)
  })

  it('runs only the requested extractor with --only', async () => {
    const parser = extractor('parser', async () => novemberRows)
    const gemini = extractor('gemini', async () => [])
    await runWatch({ ...opts(true), only: 'gemini' }, deps([APRIL, BF], [parser, gemini]))
    expect(parser.extract).not.toHaveBeenCalled()
    expect(gemini.extract).toHaveBeenCalledTimes(1)
  })

  it('lists explicit prefixes when given', async () => {
    const d = deps([APRIL], [])
    await runWatch({ ...opts(true), prefixes: ['2025/'] }, d)
    expect(d.listBucket).toHaveBeenCalledWith('2025/')
    expect(d.listBucket).toHaveBeenCalledTimes(1)
  })

  it('supersedes an older pending copy when the published key is missing from the listing', async () => {
    const stale = obj('2026/old/2026_RSD_PUBLIC_PDF.pdf', '"57a1e000"', '2026-03-01T00:00:00.000Z')
    const parser = extractor('parser', async () => aprilRows)
    const d = deps([stale], [parser])
    const out = await runWatch(opts(), d)
    expect(out).toEqual([{ key: stale.key, seasonId: '2026-april', outcome: 'superseded', extractor: null }])
    expect(parser.extract).not.toHaveBeenCalled()
    expect(d.publish).not.toHaveBeenCalled()
  })

  it('fails (not not-a-list) a list-signal key when the parser throws and the LLM finds nothing', async () => {
    const extra = obj('2026/Forms/RSD26_PUBLIC_Extra.pdf', '"e47a0000"', '2026-10-01T00:00:00.000Z')
    const d = deps(
      [APRIL, extra],
      [
        extractor('parser', async () => {
          throw new Error('Could not detect a 5-column grid')
        }),
        extractor('gemini', async () => []),
      ],
    )
    const out = await runWatch(opts(), d)
    expect(out[0]).toMatchObject({ key: extra.key, outcome: 'failed' })
    expect(d.issues.ensure).toHaveBeenCalledTimes(1)
  })

  it('fails a non-signal key whose parser rows miss the gate when the LLM finds nothing', async () => {
    const odd = obj('2026/Forms/RSD26_Something.pdf', '"0dd00000"', '2026-10-01T00:00:00.000Z')
    const d = deps(
      [APRIL, odd],
      [extractor('parser', async () => aprilRows.slice(0, 10)), extractor('gemini', async () => [])],
    )
    const out = await runWatch(opts(), d)
    expect(out[0]).toMatchObject({ key: odd.key, outcome: 'failed' })
    expect(d.issues.ensure).toHaveBeenCalledTimes(1)
  })
})
