import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { writeCurrent, writeSeasons } from './generate-json.js'
import {
  CurrentSeasonSchema,
  type SeasonStatus,
  SeasonStatusSchema,
  SeasonsListSchema,
} from './types.js'

const REPO_ROOT = resolve(process.cwd())
const CURRENT_PATH = resolve(REPO_ROOT, 'current.json')
const SEASONS_PATH = resolve(REPO_ROOT, 'seasons.json')

async function main(): Promise<void> {
  const [, , seasonId, rawStatus] = process.argv
  if (!seasonId || !rawStatus) {
    console.error('Usage: pnpm tsx scripts/update-status.ts <season-id> <upcoming|active|past>')
    process.exit(1)
    return
  }

  const statusParse = SeasonStatusSchema.safeParse(rawStatus)
  if (!statusParse.success) {
    console.error(`Invalid status: ${rawStatus}. Must be upcoming|active|past.`)
    process.exit(1)
    return
  }
  const newStatus: SeasonStatus = statusParse.data

  const currentRaw = await readFile(CURRENT_PATH, 'utf8')
  const seasonsRaw = await readFile(SEASONS_PATH, 'utf8')
  const current = CurrentSeasonSchema.parse(JSON.parse(currentRaw))
  const seasons = SeasonsListSchema.parse(JSON.parse(seasonsRaw))

  if (current.id === seasonId) {
    current.status = newStatus
    await writeCurrent(CURRENT_PATH, current)
    console.log(`Updated current.json: ${seasonId} -> ${newStatus}`)
  } else {
    console.log(`current.json id is ${current.id}, not ${seasonId}; leaving untouched.`)
  }

  let changed = false
  for (const season of seasons) {
    if (season.id === seasonId && season.status !== newStatus) {
      season.status = newStatus
      changed = true
    }
  }
  if (changed) {
    await writeSeasons(SEASONS_PATH, seasons)
    console.log(`Updated seasons.json entry for ${seasonId}.`)
  } else {
    console.log(`No seasons.json change needed for ${seasonId}.`)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
