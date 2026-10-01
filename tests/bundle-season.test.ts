import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLED_ART_MAX_DIMENSION, optimizeArtDirectory } from '../scripts/bundle-season.js'

async function makeImage(width: number, height: number, dest: string): Promise<void> {
  await sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 40, b: 180 } },
  })
    .jpeg({ quality: 100 })
    .toFile(dest)
}

describe('optimizeArtDirectory', () => {
  let dir: string
  let src: string
  let dest: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wwd-bundle-art-'))
    src = join(dir, 'src')
    dest = join(dir, 'dest')
    await mkdir(src, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('downsizes large images to fit inside the max dimension, keeping the filename', async () => {
    await makeImage(1920, 1440, join(src, 'big.jpg'))

    const result = await optimizeArtDirectory(src, dest)

    const meta = await sharp(join(dest, 'big.jpg')).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(BUNDLED_ART_MAX_DIMENSION)
    expect(meta.height).toBeLessThanOrEqual(BUNDLED_ART_MAX_DIMENSION)
    expect(meta.height).toBe(600)
    expect(result.optimized).toBe(1)
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore)
  })

  it('does not enlarge small images', async () => {
    await makeImage(300, 200, join(src, 'small.jpg'))

    await optimizeArtDirectory(src, dest)

    const meta = await sharp(join(dest, 'small.jpg')).metadata()
    expect(meta.width).toBe(300)
    expect(meta.height).toBe(200)
  })

  it('copies non-image files unchanged', async () => {
    await writeFile(join(src, '.gitkeep'), '')
    await writeFile(join(src, 'notes.txt'), 'hello', 'utf8')

    const result = await optimizeArtDirectory(src, dest)

    expect((await readdir(dest)).sort()).toEqual(['.gitkeep', 'notes.txt'])
    expect(await readFile(join(dest, 'notes.txt'), 'utf8')).toBe('hello')
    expect(result.copied).toBe(2)
    expect(result.optimized).toBe(0)
  })
})
