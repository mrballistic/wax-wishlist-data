import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { normalizeArtImage } from '../../scripts/art/normalize.js'

const blank = (width: number, height: number) => ({
  create: { width, height, channels: 3 as const, background: { r: 200, g: 40, b: 40 } },
})

describe('normalizeArtImage', () => {
  it('downsizes a large WebP to a JPEG with the longest side at 800', async () => {
    const input = await sharp(blank(1600, 1200)).webp().toBuffer()
    const out = await normalizeArtImage(input)
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
    expect([meta.width, meta.height]).toEqual([800, 600])
  })

  it('never upscales a small PNG', async () => {
    const input = await sharp(blank(300, 300)).png().toBuffer()
    const out = await normalizeArtImage(input)
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height]).toEqual([300, 300])
  })

  it('rejects garbage bytes', async () => {
    await expect(normalizeArtImage(Buffer.from('definitely not an image'))).rejects.toThrow()
  })
})
