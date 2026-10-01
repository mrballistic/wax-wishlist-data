import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IndexedArtSource } from '../scripts/art/indexed-source.js'
import type { ScoredCandidate } from '../scripts/art/match.js'
import { buildDefaultIndexedSources, formatCoverageSummary, runArtCascade } from '../scripts/fetch-art.js'
import type { ArtLookupResult, ArtSource, RawRelease } from '../scripts/types.js'

const bucketPrepare = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../scripts/art/rsd-bucket.js', () => ({
  createRsdBucketSource: vi.fn(() => ({
    name: 'rsd-bucket',
    prepare: bucketPrepare,
    accepted: () => null,
    suggestions: () => [],
  })),
}))
vi.mock('../scripts/art/rsd-site.js', () => ({
  createRsdSiteSource: vi.fn(() => ({
    name: 'rsd-site',
    prepare: async () => {},
    accepted: () => null,
    suggestions: () => [],
  })),
}))

function makeRelease(id: string, overrides: Partial<RawRelease> = {}): RawRelease {
  return {
    id,
    artist: `Artist ${id}`,
    title: `Title ${id}`,
    label: 'Test Label',
    format: 'LP',
    category: 'Exclusive Release',
    description: '',
    ...overrides,
  }
}

function constantSource(name: ArtSource['name'], factory: (r: RawRelease) => ArtLookupResult | null): ArtSource {
  return {
    name,
    async lookup(r: RawRelease): Promise<ArtLookupResult | null> {
      return factory(r)
    },
  }
}

describe('runArtCascade', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fetch-art-test-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('picks manual over discogs over musicbrainz, and records a none tier when all miss', async () => {
    const artDir = join(tmp, 'art')
    const manualDir = join(tmp, 'manual-art')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(manualDir, { recursive: true })
    // Real on-disk manual art file so the orchestrator's findManualArtForRelease lookup hits.
    await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toFile(join(manualDir, 'r-manual.jpg'))

    const releases = [
      makeRelease('r-manual'),
      makeRelease('r-discogs'),
      makeRelease('r-mb'),
      makeRelease('r-none'),
    ]

    const fetchImpl = vi.fn(async () => {
      // Simulate a successful image fetch for discogs and mb tiers.
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }) as unknown as typeof fetch

    const resizeImpl = vi.fn(async (_src: string, dest: string) => {
      await writeFile(dest, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))
    })

    const summary = await runArtCascade(releases, {
      artDir,
      manualArtDir: manualDir,
      dryRun: false,
      fetchImpl,
      resizeImpl,
      sources: {
        manual: constantSource('manual', (r) =>
          r.id === 'r-manual'
            ? { releaseId: r.id, tier: 'manual', sourceUrl: null, artFilename: `${r.id}.jpg` }
            : null,
        ),
        discogs: constantSource('discogs', (r) =>
          r.id === 'r-discogs'
            ? {
                releaseId: r.id,
                tier: 'discogs',
                sourceUrl: 'https://img.discogs.com/x.jpg',
                artFilename: `${r.id}.jpg`,
              }
            : null,
        ),
        musicbrainz: constantSource('musicbrainz', (r) =>
          r.id === 'r-mb'
            ? {
                releaseId: r.id,
                tier: 'musicbrainz',
                sourceUrl: `https://coverartarchive.org/release/abc/front`,
                artFilename: `${r.id}.jpg`,
              }
            : null,
        ),
      },
    })

    expect(summary.total).toBe(4)
    expect(summary.counts).toEqual({
      manual: 1,
      'rsd-site': 0,
      'rsd-bucket': 0,
      discogs: 1,
      musicbrainz: 1,
      none: 1,
    })
    expect(summary.results.map((r) => r.tier)).toEqual(['manual', 'discogs', 'musicbrainz', 'none'])
    // Discogs + MB sourceUrls were fetched; manual is local.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(resizeImpl).toHaveBeenCalledTimes(1)
  })

  it('manual wins even when discogs would also hit (tier 3 precedence)', async () => {
    const releases = [makeRelease('both')]

    const summary = await runArtCascade(releases, {
      artDir: join(tmp, 'art'),
      manualArtDir: join(tmp, 'manual-art'),
      dryRun: true,
      sources: {
        manual: constantSource('manual', (r) => ({
          releaseId: r.id,
          tier: 'manual',
          sourceUrl: null,
          artFilename: `${r.id}.jpg`,
        })),
        discogs: constantSource('discogs', (r) => ({
          releaseId: r.id,
          tier: 'discogs',
          sourceUrl: 'https://d/x.jpg',
          artFilename: `${r.id}.jpg`,
        })),
        musicbrainz: constantSource('musicbrainz', () => null),
      },
    })

    expect(summary.counts.manual).toBe(1)
    expect(summary.counts.discogs).toBe(0)
  })

  it('dryRun does not touch the filesystem or call fetch', async () => {
    const fetchImpl = vi.fn()
    const resizeImpl = vi.fn()
    const artDir = join(tmp, 'art-dry')

    const summary = await runArtCascade([makeRelease('dry')], {
      artDir,
      manualArtDir: join(tmp, 'manual-art'),
      dryRun: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resizeImpl,
      sources: {
        manual: constantSource('manual', () => null),
        discogs: constantSource('discogs', (r) => ({
          releaseId: r.id,
          tier: 'discogs',
          sourceUrl: 'https://d/x.jpg',
          artFilename: `${r.id}.jpg`,
        })),
        musicbrainz: constantSource('musicbrainz', () => null),
      },
    })

    expect(summary.counts.discogs).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(resizeImpl).not.toHaveBeenCalled()
    // No art dir should be created in dry-run.
    await expect(readdir(artDir)).rejects.toBeDefined()
  })

  it('demotes a release to none when the source URL returns 404 at download time', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch

    const summary = await runArtCascade([makeRelease('broken')], {
      artDir: join(tmp, 'art'),
      manualArtDir: join(tmp, 'manual-art'),
      dryRun: false,
      fetchImpl,
      sources: {
        manual: constantSource('manual', () => null),
        discogs: constantSource('discogs', (r) => ({
          releaseId: r.id,
          tier: 'discogs',
          sourceUrl: 'https://404.example/x.jpg',
          artFilename: `${r.id}.jpg`,
        })),
        musicbrainz: constantSource('musicbrainz', () => null),
      },
    })

    expect(summary.counts.discogs).toBe(0)
    expect(summary.counts.none).toBe(1)
  })

  it('reports orphan manual-art files for nonexistent release ids', async () => {
    const manualDir = resolve(tmp, 'manual-art')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(manualDir, { recursive: true })
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toFile(`${manualDir}/stale-release.jpg`)

    const summary = await runArtCascade([makeRelease('real-id')], {
      artDir: join(tmp, 'art'),
      manualArtDir: manualDir,
      dryRun: true,
      sources: {
        manual: constantSource('manual', () => null),
        discogs: constantSource('discogs', () => null),
        musicbrainz: constantSource('musicbrainz', () => null),
      },
    })

    expect(summary.orphanManualFiles).toContain('stale-release')
  })
})

describe('formatCoverageSummary', () => {
  it('matches the FR-F-004 format exactly for the example numbers', () => {
    const summary = {
      total: 72,
      counts: { 'rsd-site': 5, 'rsd-bucket': 2, discogs: 35, musicbrainz: 18, manual: 3, none: 9 },
      kept: 0,
      results: [],
      orphanManualFiles: [],
      suggestions: new Map(),
    }
    const out = formatCoverageSummary(summary)
    expect(out).toContain('=== Art Coverage Summary ===')
    expect(out).toContain('Total releases: 72')
    expect(out).toContain('  RSD site:                5 (7%)')
    expect(out).toContain('  RSD bucket:              2 (3%)')
    expect(out).toContain('Tier 1 (Discogs):      35 (49%)')
    expect(out).toContain('Tier 2 (MusicBrainz):  18 (25%)')
    expect(out).toContain('Tier 3 (Manual):         3 (4%)')
    expect(out).toContain('Tier 4 (No art):         9 (13%)')
    expect(out).toContain('Coverage: 63 / 72 (88%)')
  })

  it('counts kept files toward coverage and reports them on their own line', () => {
    const out = formatCoverageSummary({
      total: 10,
      counts: { 'rsd-site': 0, 'rsd-bucket': 0, discogs: 2, musicbrainz: 1, manual: 0, none: 2 },
      kept: 5,
      results: [],
      orphanManualFiles: [],
      suggestions: new Map(),
    })
    expect(out).toContain('Already on disk:         5 (50%)')
    expect(out).toContain('Coverage: 8 / 10 (80%)')
  })

  it('handles zero releases gracefully', () => {
    const out = formatCoverageSummary({
      total: 0,
      counts: { 'rsd-site': 0, 'rsd-bucket': 0, discogs: 0, musicbrainz: 0, manual: 0, none: 0 },
      kept: 0,
      results: [],
      orphanManualFiles: [],
      suggestions: new Map(),
    })
    expect(out).toContain('Total releases: 0')
    expect(out).toContain('Coverage: 0 / 0 (0%)')
  })
})

describe('runArtCascade — existing art on disk', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fetch-art-existing-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  const discogsHit = constantSource('discogs', (r) => ({
    releaseId: r.id,
    tier: 'discogs',
    sourceUrl: 'https://img.discogs.com/x.jpg',
    artFilename: `${r.id}.jpg`,
  }))

  it('keeps an existing art file (e.g. committed by art-admin) instead of overwriting it', async () => {
    const { mkdir, readFile } = await import('node:fs/promises')
    const artDir = join(tmp, 'art')
    await mkdir(artDir, { recursive: true })
    const handPicked = Buffer.from('hand-picked-image')
    await writeFile(join(artDir, 'r-existing.jpg'), handPicked)

    const discogsLookup = vi.fn(discogsHit.lookup)
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('discogs-image'))) as unknown as typeof fetch

    const summary = await runArtCascade([makeRelease('r-existing')], {
      artDir,
      manualArtDir: join(tmp, 'manual-art'),
      fetchImpl,
      sources: {
        manual: constantSource('manual', () => null),
        discogs: { name: 'discogs', lookup: discogsLookup },
        musicbrainz: constantSource('musicbrainz', () => null),
      },
    })

    expect(await readFile(join(artDir, 'r-existing.jpg'))).toEqual(handPicked)
    expect(discogsLookup).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(summary.kept).toBe(1)
    expect(summary.counts).toEqual({
      manual: 0,
      'rsd-site': 0,
      'rsd-bucket': 0,
      discogs: 0,
      musicbrainz: 0,
      none: 0,
    })
  })

  it('still lets a manual-art override replace an existing file', async () => {
    const { mkdir } = await import('node:fs/promises')
    const artDir = join(tmp, 'art')
    await mkdir(artDir, { recursive: true })
    await writeFile(join(artDir, 'r-override.jpg'), Buffer.from('old'))

    const resizeImpl = vi.fn(async (_src: string, dest: string) => {
      await writeFile(dest, Buffer.from('new'))
    })

    const summary = await runArtCascade([makeRelease('r-override')], {
      artDir,
      manualArtDir: join(tmp, 'manual-art'),
      resizeImpl,
      sources: {
        manual: constantSource('manual', (r) => ({
          releaseId: r.id,
          tier: 'manual',
          sourceUrl: null,
          artFilename: `${r.id}.jpg`,
        })),
        discogs: discogsHit,
        musicbrainz: constantSource('musicbrainz', () => null),
      },
    })

    expect(summary.counts.manual).toBe(1)
    expect(summary.kept).toBe(0)
  })
})

describe('runArtCascade — indexed RSD sources', () => {
  let tmp: string
  let png: Buffer

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fetch-art-indexed-'))
    png = await sharp({
      create: { width: 1200, height: 1200, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer()
    bucketPrepare.mockClear()
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  const scored = (
    source: ScoredCandidate['source'],
    n: number,
    score: number,
    imageUrl = `https://img.example/${source}/${n}.jpg`,
  ): ScoredCandidate => ({
    source,
    key: `${source}-${n}`,
    imageUrl,
    thumbUrl: imageUrl,
    label: `${n}.jpg`,
    score,
  })

  function fakeIndexed(
    name: IndexedArtSource['name'],
    accepted: Record<string, ScoredCandidate> = {},
    suggestions: Record<string, ScoredCandidate[]> = {},
  ): IndexedArtSource & { prepare: ReturnType<typeof vi.fn> } {
    return {
      name,
      prepare: vi.fn(async () => {}),
      accepted: (id: string) => accepted[id] ?? null,
      suggestions: (id: string) => suggestions[id] ?? [],
    }
  }

  const discogsHit = constantSource('discogs', (r) => ({
    releaseId: r.id,
    tier: 'discogs',
    sourceUrl: `https://img.discogs.com/${r.id}.jpg`,
    artFilename: `${r.id}.jpg`,
  }))
  const miss = (name: ArtSource['name']): ArtSource => constantSource(name, () => null)

  it('an rsd-site hit wins over discogs and is written as a normalized JPEG', async () => {
    const { readFile } = await import('node:fs/promises')
    const artDir = join(tmp, 'art')
    const site = fakeIndexed('rsd-site', { r1: scored('rsd-site', 1, 0.95) })
    const fetchImpl = vi.fn(async () => new Response(png)) as unknown as typeof fetch

    const summary = await runArtCascade([makeRelease('r1')], {
      artDir,
      manualArtDir: join(tmp, 'manual-art'),
      fetchImpl,
      indexedSources: [site],
      sources: { manual: miss('manual'), discogs: discogsHit, musicbrainz: miss('musicbrainz') },
    })

    expect(summary.counts['rsd-site']).toBe(1)
    expect(summary.counts.discogs).toBe(0)
    expect(summary.results[0]).toEqual({
      releaseId: 'r1',
      tier: 'rsd-site',
      sourceUrl: 'https://img.example/rsd-site/1.jpg',
      artFilename: 'r1.jpg',
    })
    const written = await readFile(join(artDir, 'r1.jpg'))
    expect([...written.subarray(0, 2)]).toEqual([0xff, 0xd8])
    const meta = await sharp(written).metadata()
    expect(meta.width).toBeLessThanOrEqual(800)
  })

  it('manual hits and existing files win; prepare never sees those releases', async () => {
    const { mkdir } = await import('node:fs/promises')
    const artDir = join(tmp, 'art')
    await mkdir(artDir, { recursive: true })
    await writeFile(join(artDir, 'r-existing.jpg'), Buffer.from('kept'))
    const all = { 'r-manual': scored('rsd-site', 1, 0.95), 'r-existing': scored('rsd-site', 2, 0.95) }
    const site = fakeIndexed('rsd-site', all)
    const bucket = fakeIndexed('rsd-bucket', {
      'r-manual': scored('rsd-bucket', 1, 0.95),
      'r-existing': scored('rsd-bucket', 2, 0.95),
    })
    const releases = [makeRelease('r-manual'), makeRelease('r-existing'), makeRelease('r-open')]

    const summary = await runArtCascade(releases, {
      artDir,
      manualArtDir: join(tmp, 'manual-art'),
      dryRun: true,
      indexedSources: [site, bucket],
      sources: {
        manual: constantSource('manual', (r) =>
          r.id === 'r-manual'
            ? { releaseId: r.id, tier: 'manual', sourceUrl: null, artFilename: `${r.id}.jpg` }
            : null,
        ),
        discogs: miss('discogs'),
        musicbrainz: miss('musicbrainz'),
      },
    })

    expect(summary.counts.manual).toBe(1)
    expect(summary.kept).toBe(1)
    expect(summary.counts['rsd-site']).toBe(0)
    expect(site.prepare).toHaveBeenCalledTimes(1)
    expect(site.prepare.mock.calls[0]?.[0].map((r: RawRelease) => r.id)).toEqual(['r-open'])
    expect(site.prepare.mock.calls[0]?.[1]).toBe(releases)
    expect(bucket.prepare.mock.calls[0]?.[0].map((r: RawRelease) => r.id)).toEqual(['r-open'])
  })

  it('a later indexed source is not asked about releases an earlier one accepted', async () => {
    const site = fakeIndexed('rsd-site', { r1: scored('rsd-site', 1, 0.95) })
    const bucket = fakeIndexed('rsd-bucket')

    await runArtCascade([makeRelease('r1'), makeRelease('r2')], {
      artDir: join(tmp, 'art'),
      manualArtDir: join(tmp, 'manual-art'),
      dryRun: true,
      indexedSources: [site, bucket],
      sources: { manual: miss('manual'), discogs: miss('discogs'), musicbrainz: miss('musicbrainz') },
    })

    expect(bucket.prepare.mock.calls[0]?.[0].map((r: RawRelease) => r.id)).toEqual(['r2'])
  })

  it('an rsd-bucket hit whose image 404s falls through to discogs', async () => {
    const bucket = fakeIndexed('rsd-bucket', { r1: scored('rsd-bucket', 1, 0.95) })
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('rsd-bucket') ? new Response('nope', { status: 404 }) : new Response(png),
    ) as unknown as typeof fetch

    const summary = await runArtCascade([makeRelease('r1')], {
      artDir: join(tmp, 'art'),
      manualArtDir: join(tmp, 'manual-art'),
      fetchImpl,
      indexedSources: [bucket],
      sources: { manual: miss('manual'), discogs: discogsHit, musicbrainz: miss('musicbrainz') },
    })

    expect(summary.counts['rsd-bucket']).toBe(0)
    expect(summary.counts.discogs).toBe(1)
    expect(summary.results[0]?.tier).toBe('discogs')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('an undecodable rsd image falls through to the next tier', async () => {
    const bucket = fakeIndexed('rsd-bucket', { r1: scored('rsd-bucket', 1, 0.95) })
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('rsd-bucket') ? new Response('not an image') : new Response(png),
    ) as unknown as typeof fetch

    const summary = await runArtCascade([makeRelease('r1')], {
      artDir: join(tmp, 'art'),
      manualArtDir: join(tmp, 'manual-art'),
      fetchImpl,
      indexedSources: [bucket],
      sources: { manual: miss('manual'), discogs: discogsHit, musicbrainz: miss('musicbrainz') },
    })

    expect(summary.counts.discogs).toBe(1)
  })

  it('collects up to 3 suggestions, sorted by score and deduped by imageUrl, for releases with no art', async () => {
    const shared = 'https://img.example/same.jpg'
    const site = fakeIndexed('rsd-site', {}, {
      r1: [scored('rsd-site', 1, 0.7, shared), scored('rsd-site', 2, 0.55)],
    })
    const bucket = fakeIndexed('rsd-bucket', {}, {
      r1: [scored('rsd-bucket', 3, 0.8), scored('rsd-bucket', 4, 0.65, shared), scored('rsd-bucket', 5, 0.6)],
    })

    const summary = await runArtCascade([makeRelease('r1'), makeRelease('r2')], {
      artDir: join(tmp, 'art'),
      manualArtDir: join(tmp, 'manual-art'),
      dryRun: true,
      indexedSources: [site, bucket],
      sources: { manual: miss('manual'), discogs: miss('discogs'), musicbrainz: miss('musicbrainz') },
    })

    expect(summary.counts.none).toBe(2)
    const got = summary.suggestions.get('r1') ?? []
    expect(got.map((c) => [c.imageUrl, c.score])).toEqual([
      ['https://img.example/rsd-bucket/3.jpg', 0.8],
      [shared, 0.7],
      ['https://img.example/rsd-bucket/5.jpg', 0.6],
    ])
    expect(summary.suggestions.has('r2')).toBe(false)
  })

  it('dry-run with default sources does not call prepare', async () => {
    const summary = await runArtCascade([makeRelease('r1')], {
      artDir: join(tmp, 'art'),
      manualArtDir: join(tmp, 'manual-art'),
      dryRun: true,
      seasonId: '2025-november',
      sources: { manual: miss('manual'), discogs: miss('discogs'), musicbrainz: miss('musicbrainz') },
    })

    expect(bucketPrepare).not.toHaveBeenCalled()
    expect(summary.counts.none).toBe(1)
  })

  it('a non-dry run with a seasonId prepares the default bucket source', async () => {
    await runArtCascade([makeRelease('r1')], {
      artDir: join(tmp, 'art'),
      manualArtDir: join(tmp, 'manual-art'),
      seasonId: '2025-november',
      sources: { manual: miss('manual'), discogs: miss('discogs'), musicbrainz: miss('musicbrainz') },
    })

    expect(bucketPrepare).toHaveBeenCalledTimes(1)
  })
})

describe('buildDefaultIndexedSources', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is empty without a season and the site then bucket sources with one', async () => {
    const { createRsdBucketSource } = await import('../scripts/art/rsd-bucket.js')
    const { createRsdSiteSource } = await import('../scripts/art/rsd-site.js')
    vi.stubEnv('BRIGHT_DATA_KEY', '')
    expect(buildDefaultIndexedSources({})).toEqual([])
    const sources = buildDefaultIndexedSources({ seasonId: '2025-november' })
    expect(sources.map((s) => s.name)).toEqual(['rsd-site', 'rsd-bucket'])
    expect(createRsdSiteSource).toHaveBeenLastCalledWith({ seasonId: '2025-november', unlocker: null })
    expect(createRsdBucketSource).toHaveBeenLastCalledWith({ year: '2025' })
  })
})
