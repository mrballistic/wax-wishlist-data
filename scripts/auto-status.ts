import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { writeCurrent, writeSeasons } from './generate-json.js'
import {
  CurrentSeasonSchema,
  type SeasonStatus,
  SeasonsListSchema,
} from './types.js'

const REPO_ROOT = resolve(process.cwd())
const CURRENT_PATH = resolve(REPO_ROOT, 'current.json')
const SEASONS_PATH = resolve(REPO_ROOT, 'seasons.json')

function statusForDate(today: string, date: string): SeasonStatus {
  if (today < date) return 'upcoming'
  if (today > date) return 'past'
  return 'active'
}

async function main(): Promise<void> {
  const today =
    process.env['OVERRIDE_TODAY'] ?? new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error(`Invalid today value: ${today}`)
  }

  const currentRaw = await readFile(CURRENT_PATH, 'utf8')
  const seasonsRaw = await readFile(SEASONS_PATH, 'utf8')
  const current = CurrentSeasonSchema.parse(JSON.parse(currentRaw))
  const seasons = SeasonsListSchema.parse(JSON.parse(seasonsRaw))

  let wroteCurrent = false
  let wroteSeasons = false

  const desiredCurrent = statusForDate(today, current.date)
  if (current.status !== desiredCurrent) {
    console.log(
      `current.json: ${current.id} ${current.status} -> ${desiredCurrent}`,
    )
    current.status = desiredCurrent
    await writeCurrent(CURRENT_PATH, current)
    wroteCurrent = true
  }

  let seasonsChanged = false
  for (const season of seasons) {
    const desired = statusForDate(today, season.date)
    if (season.status !== desired) {
      console.log(`seasons.json: ${season.id} ${season.status} -> ${desired}`)
      season.status = desired
      seasonsChanged = true
    }
  }
  if (seasonsChanged) {
    await writeSeasons(SEASONS_PATH, seasons)
    wroteSeasons = true
  }

  if (!wroteCurrent && !wroteSeasons) {
    console.log(`No status changes for ${today}.`)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
