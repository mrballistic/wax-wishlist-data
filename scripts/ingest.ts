import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { enrichDiscogs } from './enrich-discogs.js'
import { writeCurrent, writeReleases, writeSeasons } from './generate-json.js'
import { parsePdf } from './parse-pdf.js'
import {
  type CurrentSeason,
  CurrentSeasonSchema,
  type Season,
  SeasonsListSchema,
} from './types.js'

const REPO_ROOT = resolve(process.cwd())

async function fetchPdfBuffer(source: string): Promise<Buffer> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source)
    if (!res.ok) {
      throw new Error(`Failed to fetch PDF (${res.status}) from ${source}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }
  return readFile(resolve(REPO_ROOT, source))
}

async function loadCurrent(): Promise<CurrentSeason> {
  const raw = await readFile(resolve(REPO_ROOT, 'current.json'), 'utf8')
  return CurrentSeasonSchema.parse(JSON.parse(raw))
}

async function loadSeasons(): Promise<Season[]> {
  const raw = await readFile(resolve(REPO_ROOT, 'seasons.json'), 'utf8')
  return SeasonsListSchema.parse(JSON.parse(raw))
}

async function main(): Promise<void> {
  const [, , seasonId, pdfSource] = process.argv
  if (!seasonId || !pdfSource) {
    console.error('Usage: pnpm tsx scripts/ingest.ts <season-id> <pdfUrl-or-path>')
    process.exit(1)
    return
  }

  console.log(`Ingesting season=${seasonId} from ${pdfSource}`)
  const pdfBuffer = await fetchPdfBuffer(pdfSource)
  const raw = await parsePdf(pdfBuffer)
  console.log(`Parsed ${raw.length} raw releases`)

  const releases = await enrichDiscogs(raw)
  console.log(`Enriched ${releases.length} releases (Discogs token ${process.env['DISCOGS_TOKEN'] ? 'set' : 'absent'})`)

  const releasesPath = resolve(REPO_ROOT, 'releases', seasonId, 'releases.json')
  await writeReleases(releasesPath, releases)
  console.log(`Wrote ${releasesPath}`)

  // Refresh seasons.json entry if it already tracks this id.
  const seasons = await loadSeasons()
  const current = await loadCurrent()
  const idx = seasons.findIndex((s) => s.id === seasonId)
  if (idx >= 0 && seasons[idx]) {
    await writeSeasons(resolve(REPO_ROOT, 'seasons.json'), seasons)
  }
  if (current.id === seasonId) {
    await writeCurrent(resolve(REPO_ROOT, 'current.json'), current)
  }

  console.log('Ingest complete.')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
