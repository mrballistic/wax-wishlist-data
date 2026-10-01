import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { SeasonsListSchema } from './types.js'
import { listPdfs } from './watch/bucket.js'
import { classifyKey } from './watch/classify.js'
import { type BucketObject, saveSources, type SourceEntry } from './watch/sources.js'

/**
 * One-off: record what's already in the bucket so the watcher's first run
 * doesn't re-ingest history. The newest PDF per already-published season is
 * `published`; older copies are `superseded`; country lists are skipped.
 * Refuses to guess about any PDF whose season isn't published yet.
 */
async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd())
  const prefixes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['2025/', '2026/']
  const seasons = SeasonsListSchema.parse(JSON.parse(await readFile(resolve(repoRoot, 'seasons.json'), 'utf8')))
  const published = new Set(seasons.map((s) => s.id))
  const now = new Date().toISOString()

  const objects: BucketObject[] = []
  for (const prefix of prefixes) objects.push(...(await listPdfs(prefix)))

  const entries: SourceEntry[] = []
  const bySeason = new Map<string, BucketObject[]>()
  const unknown: string[] = []
  for (const obj of objects) {
    const c = classifyKey(obj.key)
    const base = { key: obj.key, etag: obj.etag, lastModified: obj.lastModified, processedAt: now }
    if (c.kind === 'skipped-country') entries.push({ ...base, seasonId: null, outcome: 'skipped-country', extractor: null })
    else if (c.kind === 'season' && published.has(c.seasonId)) bySeason.set(c.seasonId, [...(bySeason.get(c.seasonId) ?? []), obj])
    else unknown.push(`${obj.key} (${c.kind === 'season' ? c.seasonId : c.kind})`)
  }
  if (unknown.length > 0) {
    console.error(`Not seeding; decide these by hand first:\n  ${unknown.join('\n  ')}`)
    process.exit(1)
    return
  }
  for (const [seasonId, objs] of bySeason) {
    const sorted = [...objs].sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    sorted.forEach((obj, i) =>
      entries.push({
        key: obj.key,
        etag: obj.etag,
        lastModified: obj.lastModified,
        processedAt: now,
        seasonId,
        outcome: i === 0 ? 'published' : 'superseded',
        extractor: i === 0 ? 'parser' : null,
      }),
    )
  }
  await saveSources(resolve(repoRoot, 'sources.json'), entries)
  for (const e of entries) console.log(`${e.outcome.padEnd(15)} ${e.seasonId ?? '-'} ${e.key}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
