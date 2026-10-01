import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { createRsdBucketSource, isArtImageKey, MAX_BUCKET_IMAGE_BYTES } from '../../scripts/art/rsd-bucket.js'
import type { RawRelease } from '../../scripts/types.js'
import { BucketError, objectUrl } from '../../scripts/watch/bucket.js'
import type { BucketObject } from '../../scripts/watch/sources.js'
import { loadRaw, REPO_ROOT } from '../helpers/releases.js'

const obj = (key: string, size = 1000): BucketObject => ({
  key,
  etag: '"x"',
  lastModified: '2025-01-01T00:00:00.000Z',
  size,
})

describe('isArtImageKey', () => {
  it('accepts image extensions case-insensitively', () => {
    for (const ext of ['JPG', 'png', 'tiff', 'webp']) {
      expect(isArtImageKey(`2025/Artwork RSD 2025/UMG - RSD 2025/x.${ext}`)).toBe(true)
    }
  })
  it('rejects logos, macOS junk, non-images and folders', () => {
    for (const key of [
      '2026/Logos/rsd.png',
      '2025/x/__MACOSX/._a.jpg',
      '2025/x/.DS_Store',
      '2025/x/list.pdf',
      '2025/x/',
    ]) {
      expect(isArtImageKey(key)).toBe(false)
    }
  })
})

describe('createRsdBucketSource', () => {
  let season: RawRelease[]
  let keys: string[]
  beforeAll(async () => {
    season = await loadRaw('2025-april')
    keys = JSON.parse(await readFile(join(REPO_ROOT, 'tests/fixtures/art/bucket-2025-keys.json'), 'utf8')) as string[]
  })

  it('matches the season against listed keys and skips oversized files', async () => {
    const huge = '2025/Artwork RSD 2025/01-ALL ART COMBINED/Huge Thing.png'
    const list = vi.fn(async () => [...keys.map((k) => obj(k)), obj(huge, 30 * 1024 * 1024)])
    const log = vi.fn()
    const source = createRsdBucketSource({ year: '2025', list, log })
    await source.prepare(season, season)

    expect(source.accepted('alison-moyet-hometime')?.imageUrl).toBe(
      objectUrl('2025/Artwork RSD 2025/01-ALL ART COMBINED/Alison Moyet copy.png'),
    )
    expect(source.suggestions('charles-mingus-in-argentina-the-buenos-aires-concerts').length).toBeGreaterThan(0)
    expect(MAX_BUCKET_IMAGE_BYTES).toBe(25 * 1024 * 1024)
    const all = season.flatMap((r) => [source.accepted(r.id), ...source.suggestions(r.id)])
    expect(all.some((c) => c?.key === huge)).toBe(false)
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith('2025/')
  })

  it('logs and stays empty when listing fails', async () => {
    const list = vi.fn(async () => {
      throw new BucketError('HTTP 503 listing 2025/')
    })
    const log = vi.fn()
    const source = createRsdBucketSource({ year: '2025', list, log })
    await expect(source.prepare(season, season)).resolves.toBeUndefined()
    expect(source.accepted(season[0]?.id ?? 'x')).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'))
  })
})
