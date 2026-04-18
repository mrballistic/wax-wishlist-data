import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { writeCurrent, writeSeasons } from './generate-json.js'
import {
  type CurrentSeason,
  CurrentSeasonSchema,
  type Season,
  SeasonsListSchema,
} from './types.js'

const RAW_BASE =
  'https://raw.githubusercontent.com/mrballistic/wax-wishlist-data/main/releases'

const MONTH_NAMES: Record<string, string> = {
  january: 'January',
  february: 'February',
  march: 'March',
  april: 'April',
  may: 'May',
  june: 'June',
  july: 'July',
  august: 'August',
  september: 'September',
  october: 'October',
  november: 'November',
  december: 'December',
}

function deriveLabel(seasonId: string): string | null {
  // Matches the two shapes we've used so far: `2026-april` and `2025-november`.
  // Anything else (e.g. `2027-summer-drop-2`) cannot be derived safely —
  // callers must pass --label explicitly.
  const m = /^(\d{4})-([a-z]+)$/i.exec(seasonId)
  if (!m) return null
  const [, year, rawMonth] = m
  if (!year || !rawMonth) return null
  const pretty = MONTH_NAMES[rawMonth.toLowerCase()]
  if (!pretty) return null
  if (pretty === 'November') return `Black Friday Drop ${year}`
  return `${pretty} Drop ${year}`
}

function buildSeason(
  seasonId: string,
  date: string,
  label: string,
  status: Season['status'],
): Season {
  return {
    id: seasonId,
    label,
    date,
    status,
    releasesUrl: `${RAW_BASE}/${seasonId}/releases.json`,
    artBaseUrl: `${RAW_BASE}/${seasonId}/art/`,
  }
}

async function loadSeasons(repoRoot: string): Promise<Season[]> {
  const raw = await readFile(resolve(repoRoot, 'seasons.json'), 'utf8')
  return SeasonsListSchema.parse(JSON.parse(raw))
}

async function loadCurrent(repoRoot: string): Promise<CurrentSeason> {
  const raw = await readFile(resolve(repoRoot, 'current.json'), 'utf8')
  return CurrentSeasonSchema.parse(JSON.parse(raw))
}

function sortByDateDesc(seasons: Season[]): Season[] {
  return [...seasons].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

interface Args {
  seasonId: string
  date: string
  label: string | undefined
}

function parseArgs(argv: string[]): Args | null {
  const positional: string[] = []
  let label: string | undefined
  for (const a of argv) {
    if (a.startsWith('--label=')) {
      label = a.slice('--label='.length)
    } else if (!a.startsWith('--')) {
      positional.push(a)
    }
  }
  const [seasonId, date] = positional
  if (!seasonId || !date) return null
  return { seasonId, date, label }
}

/**
 * Register a freshly ingested season so iOS clients will see it on their next
 * `Check for Updates` (FR-008). Announces the season in two places:
 *
 *   1. `seasons.json` — upserted by id and kept sorted newest-first.
 *   2. `current.json` — promoted to point at this season **iff** the new date
 *      is strictly later than the existing `current.json.date`. Re-ingesting
 *      an older season is therefore a safe no-op at the top level.
 *
 * Status defaults to `upcoming` for new entries and is preserved when updating
 * an existing entry (the `update-status` workflow is the single source of
 * truth for lifecycle transitions).
 */
export async function registerSeason(
  seasonId: string,
  date: string,
  labelOverride?: string,
  repoRoot: string = resolve(process.cwd()),
): Promise<{ registered: Season; promotedToCurrent: boolean }> {
  const label = labelOverride ?? deriveLabel(seasonId)
  if (!label) {
    throw new Error(
      `Cannot derive a human label for season "${seasonId}". ` +
        'Pass --label="..." explicitly.',
    )
  }

  const seasons = await loadSeasons(repoRoot)
  const existingIdx = seasons.findIndex((s) => s.id === seasonId)
  const existingStatus = existingIdx >= 0 ? seasons[existingIdx]?.status : undefined
  const status: Season['status'] = existingStatus ?? 'upcoming'
  const entry = buildSeason(seasonId, date, label, status)

  let next: Season[]
  if (existingIdx >= 0) {
    next = [...seasons]
    next[existingIdx] = entry
  } else {
    next = [entry, ...seasons]
  }
  next = sortByDateDesc(next)
  await writeSeasons(resolve(repoRoot, 'seasons.json'), next)

  const current = await loadCurrent(repoRoot)
  let promoted = false
  if (date > current.date) {
    const currentEntry: CurrentSeason = { ...entry }
    await writeCurrent(resolve(repoRoot, 'current.json'), currentEntry)
    promoted = true
  }

  return { registered: entry, promotedToCurrent: promoted }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error(
      'Usage: pnpm tsx scripts/register-season.ts <season-id> <yyyy-mm-dd> [--label="April Drop 2027"]',
    )
    process.exit(1)
    return
  }
  const { seasonId, date, label } = args
  const { registered, promotedToCurrent } = await registerSeason(seasonId, date, label)
  console.log(
    `Registered ${registered.id} (${registered.label}, ${registered.date}, status=${registered.status})`,
  )
  if (promotedToCurrent) {
    console.log(`Promoted ${registered.id} to current.json`)
  } else {
    console.log('current.json unchanged (new date is not strictly later).')
  }
}

function isInvokedAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (entry.includes('vitest') || entry.includes('node_modules')) return false
  return entry.endsWith('register-season.ts') || entry.endsWith('register-season.js')
}

if (isInvokedAsCli()) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
