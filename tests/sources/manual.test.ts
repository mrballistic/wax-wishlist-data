import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createManualSource,
  findManualArtForRelease,
  listManualArtBasenames,
  MANUAL_ART_MAX_BYTES,
  MANUAL_ART_MAX_DIMENSION,
  resizeManualArt,
} from '../../scripts/sources/manual.js'
import type { RawRelease } from '../../scripts/types.js'

const SAMPLE_RELEASE: RawRelease = {
  id: '2025-april-001',
  artist: 'Hana Okonkwo',
  title: 'Threadbare',
  label: 'Meridian Sound',
  format: 'LP',
  category: 'Exclusive Release',
  description: '',
}

async function makeSquareImage(dim: number, dest: string, format: 'jpeg' | 'png' = 'jpeg'): Promise<void> {
  const img = sharp({
    create: {
      width: dim,
      height: dim,
      channels: 3,
      background: { r: 100, g: 40, b: 180 },
    },
  })
  const encoded = format === 'jpeg' ? img.jpeg() : img.png()
  await encoded.toFile(dest)
}

describe('manual source', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'manual-art-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when manual-art dir does not exist', async () => {
    const missingDir = resolve(dir, 'nope')
    const src = createManualSource({ manualArtDir: missingDir })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('finds a .jpg override and returns a tier=manual result', async () => {
    await makeSquareImage(400, join(dir, '2025-april-001.jpg'), 'jpeg')

    const src = createManualSource({ manualArtDir: dir })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).not.toBeNull()
    expect(res?.tier).toBe('manual')
    expect(res?.releaseId).toBe('2025-april-001')
    expect(res?.artFilename).toBe('2025-april-001.jpg')
    expect(res?.sourceUrl).toBeNull()
  })

  it('finds a .png override', async () => {
    await makeSquareImage(400, join(dir, '2025-april-001.png'), 'png')

    const src = createManualSource({ manualArtDir: dir })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res?.tier).toBe('manual')
    // Output filename is always .jpg after normalization.
    expect(res?.artFilename).toBe('2025-april-001.jpg')
  })

  it('prefers .jpg over .png tiebreaker when both exist', async () => {
    await makeSquareImage(400, join(dir, '2025-april-001.jpg'), 'jpeg')
    await makeSquareImage(400, join(dir, '2025-april-001.png'), 'png')

    const candidate = await findManualArtForRelease(dir, '2025-april-001')
    expect(candidate?.ext).toBe('.jpg')
  })

  it('matches case-insensitively against release id', async () => {
    await makeSquareImage(400, join(dir, '2025-APRIL-001.JPG'), 'jpeg')

    const src = createManualSource({ manualArtDir: dir })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res?.tier).toBe('manual')
  })

  it('returns null when no matching basename exists', async () => {
    await makeSquareImage(400, join(dir, 'other-release.jpg'), 'jpeg')

    const src = createManualSource({ manualArtDir: dir })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('rejects oversize files with a warning', async () => {
    const path = join(dir, '2025-april-001.jpg')
    // Write a raw file larger than the limit — content validity doesn't matter here.
    const bytes = Buffer.alloc(MANUAL_ART_MAX_BYTES + 1, 0xff)
    await writeFile(path, bytes)

    const src = createManualSource({ manualArtDir: dir })
    const res = await src.lookup(SAMPLE_RELEASE)
    expect(res).toBeNull()
  })

  it('listManualArtBasenames returns all supported files stripped of extensions', async () => {
    await makeSquareImage(100, join(dir, 'foo.jpg'), 'jpeg')
    await makeSquareImage(100, join(dir, 'bar.png'), 'png')
    await writeFile(join(dir, 'README.md'), '# ignored')
    await writeFile(join(dir, 'notes.txt'), 'ignored')

    const names = await listManualArtBasenames(dir)
    expect(new Set(names)).toEqual(new Set(['foo', 'bar']))
  })

  it('resizeManualArt produces a JPEG at or below the max dimension', async () => {
    const src = join(dir, 'big.jpg')
    const dest = join(dir, 'small.jpg')
    await makeSquareImage(1200, src, 'jpeg')

    await resizeManualArt(src, dest)

    const meta = await sharp(dest).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width ?? 0).toBeLessThanOrEqual(MANUAL_ART_MAX_DIMENSION)
    expect(meta.height ?? 0).toBeLessThanOrEqual(MANUAL_ART_MAX_DIMENSION)
  })

  it('resizeManualArt does not upscale images already below the max', async () => {
    const src = join(dir, 'small-src.png')
    const dest = join(dir, 'small-dest.jpg')
    await makeSquareImage(200, src, 'png')

    await resizeManualArt(src, dest)

    const meta = await sharp(dest).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(200)
    expect(meta.height).toBe(200)
  })

  it('resizeManualArt preserves aspect ratio for non-square source images', async () => {
    const src = join(dir, 'tall.jpg')
    const dest = join(dir, 'tall-out.jpg')
    await sharp({
      create: {
        width: 1200,
        height: 1800,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .jpeg()
      .toFile(src)

    await resizeManualArt(src, dest)

    const meta = await sharp(dest).metadata()
    // Longest side (height) should be 600; width proportional.
    expect(meta.height).toBe(MANUAL_ART_MAX_DIMENSION)
    expect(meta.width).toBe(400)
  })

  it('writes the resized JPEG to disk', async () => {
    const src = join(dir, 'big.jpg')
    const dest = join(dir, 'out.jpg')
    await makeSquareImage(1000, src, 'jpeg')

    await resizeManualArt(src, dest)

    const buf = await readFile(dest)
    // JPEG magic bytes
    expect(buf[0]).toBe(0xff)
    expect(buf[1]).toBe(0xd8)
    const st = await stat(dest)
    expect(st.size).toBeGreaterThan(0)
  })
})
