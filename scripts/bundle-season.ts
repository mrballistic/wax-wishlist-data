import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { ReleaseListSchema } from './types.js'

const REPO_ROOT = resolve(process.cwd())

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * CLI used by the iOS app's release pipeline. Copies the season's
 * releases.json and art/ directory into the caller-provided destination
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
    await cp(artDir, destArt, { recursive: true })
    console.log(`wrote: ${destArt}`)
  } else {
    console.log(`note: no art/ directory for season ${seasonId}, skipped`)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
