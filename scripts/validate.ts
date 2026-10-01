import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ZodTypeAny } from 'zod'

import { CurrentSeasonSchema, ReleaseListSchema, SeasonsListSchema } from './types.js'
import { CalendarSchema } from './watch/calendar.js'
import { SourcesSchema } from './watch/sources.js'

const REPO_ROOT = resolve(process.cwd())
const CURRENT_PATH = resolve(REPO_ROOT, 'current.json')
const SEASONS_PATH = resolve(REPO_ROOT, 'seasons.json')
const SOURCES_PATH = resolve(REPO_ROOT, 'sources.json')
const CALENDAR_PATH = resolve(REPO_ROOT, 'calendar.json')
const RELEASES_DIR = resolve(REPO_ROOT, 'releases')

type Problem = { path: string; message: string }

/**
 * Per-season art coverage, reported but never fatal: a release whose
 * `artFilename` slot has no file yet is a normal state (the app shows a
 * placeholder until the cascade or wax-wishlist-art-admin fills it).
 */
const coverageLines: string[] = []

async function validateCurrent(): Promise<Problem[]> {
  const problems: Problem[] = []
  try {
    const raw = await readFile(CURRENT_PATH, 'utf8')
    const result = CurrentSeasonSchema.safeParse(JSON.parse(raw))
    if (!result.success) {
      problems.push({ path: CURRENT_PATH, message: result.error.toString() })
    }
  } catch (err) {
    problems.push({ path: CURRENT_PATH, message: `${(err as Error).message}` })
  }
  return problems
}

async function validateSeasons(): Promise<Problem[]> {
  const problems: Problem[] = []
  try {
    const raw = await readFile(SEASONS_PATH, 'utf8')
    const result = SeasonsListSchema.safeParse(JSON.parse(raw))
    if (!result.success) {
      problems.push({ path: SEASONS_PATH, message: result.error.toString() })
    }
  } catch (err) {
    problems.push({ path: SEASONS_PATH, message: `${(err as Error).message}` })
  }
  return problems
}

/** Watcher state files: validated when present (sources.json is seeded in a later step). */
async function validateOptional(path: string, schema: ZodTypeAny): Promise<Problem[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  try {
    const result = schema.safeParse(JSON.parse(raw))
    return result.success ? [] : [{ path, message: result.error.toString() }]
  } catch (err) {
    return [{ path, message: `${(err as Error).message}` }]
  }
}

async function validateReleases(): Promise<Problem[]> {
  const problems: Problem[] = []
  let entries: string[] = []
  try {
    entries = await readdir(RELEASES_DIR)
  } catch {
    return problems
  }

  for (const entry of entries) {
    const dir = resolve(RELEASES_DIR, entry)
    const info = await stat(dir).catch(() => null)
    if (!info?.isDirectory()) continue
    const releasesPath = resolve(dir, 'releases.json')
    try {
      const raw = await readFile(releasesPath, 'utf8')
      const result = ReleaseListSchema.safeParse(JSON.parse(raw))
      if (!result.success) {
        problems.push({ path: releasesPath, message: result.error.toString() })
        continue
      }
      const artFiles = new Set(await readdir(resolve(dir, 'art')).catch(() => []))
      const covered = result.data.filter((r) => r.artFilename && artFiles.has(r.artFilename))
      coverageLines.push(`  ${entry}: ${covered.length} / ${result.data.length} art files present`)
    } catch (err) {
      problems.push({ path: releasesPath, message: `${(err as Error).message}` })
    }
  }
  return problems
}

async function main(): Promise<void> {
  const problems = [
    ...(await validateCurrent()),
    ...(await validateSeasons()),
    ...(await validateOptional(SOURCES_PATH, SourcesSchema)),
    ...(await validateOptional(CALENDAR_PATH, CalendarSchema)),
    ...(await validateReleases()),
  ]

  if (coverageLines.length > 0) {
    console.log(['Art coverage:', ...coverageLines].join('\n'))
  }

  if (problems.length === 0) {
    console.log('All JSON files validated against Zod schemas.')
    return
  }

  for (const p of problems) {
    console.error(`INVALID ${p.path}\n  ${p.message}`)
  }
  process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
