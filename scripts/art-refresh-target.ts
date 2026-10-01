import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { CurrentSeasonSchema } from './types.js'

/** The season id to refresh art for, or null once its date has passed. */
export function refreshTarget(current: { id: string; date: string }, today: string): string | null {
  return current.date >= today ? current.id : null
}

async function main(): Promise<void> {
  const raw = await readFile(resolve(process.cwd(), 'current.json'), 'utf8')
  const current = CurrentSeasonSchema.parse(JSON.parse(raw))
  const today = process.env.OVERRIDE_TODAY ?? new Date().toISOString().slice(0, 10)
  const id = refreshTarget(current, today)
  if (id) console.log(id)
}

function isInvokedAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (entry.includes('vitest') || entry.includes('node_modules')) return false
  return entry.endsWith('art-refresh-target.ts') || entry.endsWith('art-refresh-target.js')
}

if (isInvokedAsCli()) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
