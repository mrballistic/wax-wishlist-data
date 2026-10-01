import sharp from 'sharp'

/** Same cap as the season bundle: covers the app's largest art at @2x. */
export const ART_MAX_DIMENSION = 800
export const ART_JPEG_QUALITY = 85

/** Any image sharp can decode → a JPEG no larger than 800×800, EXIF orientation applied. */
export async function normalizeArtImage(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: ART_MAX_DIMENSION, height: ART_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: ART_JPEG_QUALITY, mozjpeg: true })
    .toBuffer()
}
