import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatCoverageSummary, runArtCascade } from '../scripts/fetch-art.js'
import type { ArtLookupResult, ArtSource, RawRelease } from '../scripts/types.js'

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
    expect(summary.counts).toEqual({ manual: 1, discogs: 1, musicbrainz: 1, none: 1 })
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
      counts: { discogs: 42, musicbrainz: 18, manual: 3, none: 9 },
      results: [],
      orphanManualFiles: [],
    }
    const out = formatCoverageSummary(summary)
    expect(out).toContain('=== Art Coverage Summary ===')
    expect(out).toContain('Total releases: 72')
    expect(out).toContain('Tier 1 (Discogs):      42 (58%)')
    expect(out).toContain('Tier 2 (MusicBrainz):  18 (25%)')
    expect(out).toContain('Tier 3 (Manual):         3 (4%)')
    expect(out).toContain('Tier 4 (No art):         9 (13%)')
    expect(out).toContain('Coverage: 63 / 72 (88%)')
  })

  it('handles zero releases gracefully', () => {
    const out = formatCoverageSummary({
      total: 0,
      counts: { discogs: 0, musicbrainz: 0, manual: 0, none: 0 },
      results: [],
      orphanManualFiles: [],
    })
    expect(out).toContain('Total releases: 0')
    expect(out).toContain('Coverage: 0 / 0 (0%)')
  })
})
