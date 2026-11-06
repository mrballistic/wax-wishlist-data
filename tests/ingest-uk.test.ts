import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ingestUk,
  type IngestUkDeps,
  MIN_UK_ROWS,
  UkListMismatchError,
} from '../scripts/ingest-uk.js'
import type { Release, UkRow } from '../scripts/types.js'

const SEASON = '2026-november'
const NOW = '2026-11-06T12:00:00.000Z'
const us = (n: number): Release => ({
  id: `artist-${n}-title-${n}`,
  artist: `Artist ${n}`,
  title: `Title ${n}`,
  label: 'Lab',
  format: 'LP',
  category: 'exclusive',
  description: '',
  discogsMasterId: n,
  artFilename: `artist-${n}-title-${n}.jpg`,
})
/** UK rows matching US releases 1..20, then `extra` UK-only rows ("Brit 1 — Song 1", …). */
const ukRows = (extra: number): UkRow[] => [
  ...Array.from({ length: 20 }, (_, i) => ({
    artist: `Artist ${i + 1}`,
    title: `Title ${i + 1}`,
    label: 'Lab',
    format: 'LP',
  })),
  ...Array.from({ length: extra }, (_, i) => ({
    artist: `Brit ${i + 1}`,
    title: `Song ${i + 1}`,
    label: 'Lab',
    format: 'LP',
  })),
]

let root: string
const releasesPath = () => join(root, 'releases', SEASON, 'releases.json')
const read = async (p: string) => JSON.parse(await readFile(p, 'utf8'))

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wwd-uk-'))
  await mkdir(join(root, 'releases', SEASON), { recursive: true })
  await writeFile(releasesPath(), JSON.stringify(Array.from({ length: 25 }, (_, i) => us(i + 1))))
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
})

function deps(rows: UkRow[], over: Partial<IngestUkDeps> = {}) {
  return {
    fetchPdf: vi.fn(async () => Buffer.from('%PDF')),
    parse: vi.fn(async () => rows),
    discogs: vi.fn(async (rs: Release[]) => rs.map((r) => ({ ...r, discogsMasterId: 777 }))),
    art: vi.fn(async () => {}),
    now: () => NOW,
    log: () => {},
    ukSite: () => ({
      slugs: async () => [],
      page: async () => null,
      image: async () => Buffer.alloc(0),
    }),
    ...over,
  } satisfies IngestUkDeps
}

describe('ingestUk', () => {
  it('tags regions, appends UK exclusives with Discogs ids, saves uk.json and stamps current.json', async () => {
    const d = deps(ukRows(2))
    const result = await ingestUk(
      { repoRoot: root, seasonId: SEASON, pdfUrl: 'https://example.com/uk.pdf' },
      d,
    )

    expect(result.matches).toHaveLength(20)
    const written: Release[] = await read(releasesPath())
    expect(written).toHaveLength(27)
    expect(written.find((r) => r.id === 'artist-1-title-1')?.regions).toEqual(['us', 'uk'])
    expect(written.find((r) => r.id === 'artist-25-title-25')?.regions).toEqual(['us'])
    expect(written.find((r) => r.id === 'brit-1-song-1')).toMatchObject({
      regions: ['uk'],
      discogsMasterId: 777,
    })
    // Discogs only for the UK exclusives, never the US list.
    expect(vi.mocked(d.discogs).mock.calls[0]?.[0].map((r: Release) => r.id)).toEqual([
      'brit-1-song-1',
      'brit-2-song-2',
    ])
    expect(d.art).toHaveBeenCalledWith(expect.objectContaining({ seasonId: SEASON }))

    expect(await read(join(root, 'releases', SEASON, 'uk.json'))).toMatchObject({
      sourceUrl: 'https://example.com/uk.pdf',
      fetchedAt: NOW,
    })
    expect((await read(join(root, 'current.json'))).contentUpdatedAt).toBe(NOW)
  })

  it('fills UK exclusives from recordstoreday.co.uk before writing', async () => {
    const d = deps(ukRows(1), {
      ukSite: () => ({
        slugs: async () => ['brit-1-song-1'],
        page: async () => ({
          url: 'https://www.recordstoreday.co.uk/release/brit-1-song-1',
          artist: 'Brit 1',
          title: 'Song 1',
          label: 'Lab',
          date: '2026-11-27',
          image: null,
          description: 'From the UK site',
        }),
        image: async () => Buffer.alloc(0),
      }),
    })
    await ingestUk({ repoRoot: root, seasonId: SEASON, pdfUrl: 'https://example.com/uk.pdf' }, d)
    const written: Release[] = await read(releasesPath())
    expect(written.find((r) => r.id === 'brit-1-song-1')).toMatchObject({
      description: 'From the UK site',
      rsdUrl: 'https://www.recordstoreday.co.uk/release/brit-1-song-1',
    })
  })

  it('re-merges the saved uk.json without a URL, applying overrides', async () => {
    await ingestUk(
      { repoRoot: root, seasonId: SEASON, pdfUrl: 'https://example.com/uk.pdf' },
      deps(ukRows(0)),
    )
    await writeFile(
      join(root, 'releases', SEASON, 'uk-overrides.json'),
      JSON.stringify({ ukOnly: ['artist-1-title-1-lp'] }),
    )
    const d = deps([])
    await ingestUk({ repoRoot: root, seasonId: SEASON }, d)

    expect(d.fetchPdf).not.toHaveBeenCalled()
    const written: Release[] = await read(releasesPath())
    expect(written.find((r) => r.id === 'artist-1-title-1')?.regions).toEqual(['us'])
    expect(written.find((r) => r.id === 'artist-1-title-1-uk')?.regions).toEqual(['uk'])
  })

  it('refuses a parse with too few rows and writes nothing', async () => {
    const before = await readFile(releasesPath(), 'utf8')
    await expect(
      ingestUk(
        { repoRoot: root, seasonId: SEASON, pdfUrl: 'https://example.com/uk.pdf' },
        deps(ukRows(0).slice(0, MIN_UK_ROWS - 1)),
      ),
    ).rejects.toThrow(/Parsed only 19 rows/)
    expect(await readFile(releasesPath(), 'utf8')).toBe(before)
  })

  it('saves the ETag it was given', async () => {
    await ingestUk(
      { repoRoot: root, seasonId: SEASON, pdfUrl: 'https://example.com/uk.pdf', etag: '"abc"' },
      deps(ukRows(0)),
    )
    expect((await read(join(root, 'releases', SEASON, 'uk.json'))).etag).toBe('"abc"')
  })

  it('refuses a list that barely overlaps the US one, writing nothing', async () => {
    const before = await readFile(releasesPath(), 'utf8')
    const other = Array.from({ length: 25 }, (_, i) => ({
      artist: `Other ${i + 1}`,
      title: `Record ${i + 1}`,
      label: 'L',
      format: 'LP',
    }))
    await expect(
      ingestUk(
        { repoRoot: root, seasonId: SEASON, pdfUrl: 'https://example.com/uk.pdf' },
        deps(other),
      ),
    ).rejects.toBeInstanceOf(UkListMismatchError)
    expect(await readFile(releasesPath(), 'utf8')).toBe(before)
  })

  it('needs the US list published first', async () => {
    await expect(
      ingestUk(
        { repoRoot: root, seasonId: '2027-april', pdfUrl: 'https://example.com/uk.pdf' },
        deps(ukRows(0)),
      ),
    ).rejects.toThrow(/publish the US list first/)
  })

  it('needs a URL the first time', async () => {
    await expect(ingestUk({ repoRoot: root, seasonId: SEASON }, deps([]))).rejects.toThrow(
      /pass the UK PDF URL/,
    )
  })

  it('writes nothing on a dry run', async () => {
    const before = await readFile(releasesPath(), 'utf8')
    const d = deps(ukRows(2))
    const result = await ingestUk(
      { repoRoot: root, seasonId: SEASON, pdfUrl: 'https://example.com/uk.pdf', dryRun: true },
      d,
    )
    expect(result.ukOnly).toHaveLength(2)
    expect(await readFile(releasesPath(), 'utf8')).toBe(before)
    expect(d.discogs).not.toHaveBeenCalled()
    expect(d.art).not.toHaveBeenCalled()
  })
})
