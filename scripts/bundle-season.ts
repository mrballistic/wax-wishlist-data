import { copyFile, cp, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import sharp from 'sharp'

import { ReleaseListSchema } from './types.js'

const REPO_ROOT = resolve(process.cwd())

/**
 * Longest-side cap for bundled art. The app renders art at most ~400pt wide,
 * so 800px covers @2x without shipping full-resolution source scans.
 */
export const BUNDLED_ART_MAX_DIMENSION = 800

/** mozjpeg quality for bundled art; visually lossless at app display sizes. */
export const BUNDLED_ART_JPEG_QUALITY = 78

export interface OptimizeArtResult {
  /** Files re-encoded through sharp. */
  optimized: number
  /** Files sharp couldn't decode, copied through unchanged. */
  copied: number
  /** Total bytes of every file read from `srcDir`. */
  bytesBefore: number
  /** Total bytes of every file written to `destDir`. */
  bytesAfter: number
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Copy `srcDir` into `destDir` (recursively), re-encoding every image sharp
 * can decode as a JPEG that fits inside
 * {@link BUNDLED_ART_MAX_DIMENSION}×{@link BUNDLED_ART_MAX_DIMENSION}.
 *
 * Filenames are preserved exactly (the season JSON references them by name),
 * small images are never upscaled, and EXIF orientation is baked in before
 * metadata is stripped. Anything sharp can't read (e.g. `.gitkeep`) is
 * copied byte-for-byte.
 */
export async function optimizeArtDirectory(
  srcDir: string,
  destDir: string,
): Promise<OptimizeArtResult> {
  const result: OptimizeArtResult = { optimized: 0, copied: 0, bytesBefore: 0, bytesAfter: 0 }
  await mkdir(destDir, { recursive: true })

  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = resolve(srcDir, entry.name)
    const destPath = resolve(destDir, entry.name)

    if (entry.isDirectory()) {
      const sub = await optimizeArtDirectory(srcPath, destPath)
      result.optimized += sub.optimized
      result.copied += sub.copied
      result.bytesBefore += sub.bytesBefore
      result.bytesAfter += sub.bytesAfter
      continue
    }
    if (!entry.isFile()) continue

    result.bytesBefore += (await stat(srcPath)).size
    try {
      await sharp(srcPath)
        .rotate()
        .resize({
          width: BUNDLED_ART_MAX_DIMENSION,
          height: BUNDLED_ART_MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: BUNDLED_ART_JPEG_QUALITY, mozjpeg: true })
        .toFile(destPath)
      result.optimized += 1
    } catch {
      // Not an image sharp understands — ship it unchanged.
      await copyFile(srcPath, destPath)
      result.copied += 1
    }
    result.bytesAfter += (await stat(destPath)).size
  }

  return result
}

/**
 * CLI used by the iOS app's release pipeline. Copies the season's
 * releases.json and art/ directory (images downsized via
 * {@link optimizeArtDirectory}) into the caller-provided destination
 * so the bundled seed is available for first-launch seeding.
 *
 * Usage: pnpm tsx scripts/bundle-season.ts <season-id> <destinationDir>
 */
async function main(): Promise<void> {
  const [, , seasonId, destDir] = process.argv
  if (!seasonId || !destDir) {
    console.error('Usage: pnpm tsx scripts/bundle-season.ts <season-id> <destinationDir>')
    process.exit(1)
    return
  }

  const seasonDir = resolve(REPO_ROOT, 'releases', seasonId)
  const releasesPath = resolve(seasonDir, 'releases.json')
  const artDir = resolve(seasonDir, 'art')

  if (!(await exists(releasesPath))) {
    console.error(`Missing releases.json at ${releasesPath}`)
    process.exit(1)
    return
  }

  const releasesRaw = await readFile(releasesPath, 'utf8')
  ReleaseListSchema.parse(JSON.parse(releasesRaw))

  const resolvedDest = resolve(destDir)
  await mkdir(resolvedDest, { recursive: true })

  const destReleases = resolve(resolvedDest, 'releases.json')
  await cp(releasesPath, destReleases)
  console.log(`wrote: ${destReleases}`)

  if (await exists(artDir)) {
    const destArt = resolve(resolvedDest, 'art')
    const art = await optimizeArtDirectory(artDir, destArt)
    console.log(`wrote: ${destArt}`)
    console.log(
      `art: ${art.optimized} optimized, ${art.copied} copied, ` +
        `${art.bytesBefore} -> ${art.bytesAfter} bytes`,
    )
  } else {
    console.log(`note: no art/ directory for season ${seasonId}, skipped`)
  }
}

function isInvokedAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (entry.includes('vitest') || entry.includes('node_modules')) return false
  return entry.endsWith('bundle-season.ts') || entry.endsWith('bundle-season.js')
}

if (isInvokedAsCli()) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
