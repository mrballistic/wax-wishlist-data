import { resolve } from 'node:path'

import { runCascade } from '../extract/index.js'
import type { Extractor, ExtractorName } from '../extract/types.js'

import { prefixesFor } from './bucket.js'
import { loadCalendar, seasonDate } from './calendar.js'
import { classifyKey, hasListSignal } from './classify.js'
import type { GitOps } from './git.js'
import { BUCKET_ISSUE_TITLE, failureIssueTitle, type IssueClient, seasonIssuePrefix } from './issues.js'
import type { PublishInput } from './publish.js'
import { loadGateContext } from './season-context.js'
import {
  type BucketObject,
  loadSources,
  pendingObjects,
  saveSources,
  type SourceOutcome,
  upsertSource,
} from './sources.js'

export interface WatchDeps {
  now: () => Date
  listBucket: (prefix: string) => Promise<BucketObject[]>
  fetchPdf: (key: string) => Promise<Buffer>
  pdfText: (pdf: Buffer) => Promise<string>
  extractors: Extractor[]
  publish: (input: PublishInput) => Promise<void>
  issues: IssueClient
  git: GitOps
  summary: (markdown: string) => Promise<void>
  log: (line: string) => void
}

export interface WatchOptions {
  repoRoot: string
  sourcesPath: string
  /** Report only: no publish, no commit, no issues, no sources.json write. */
  dryRun: boolean
  /** Run a single extractor (rehearsals). */
  only?: ExtractorName | undefined
  /** Override the listed prefixes (rehearsals against past years). */
  prefixes?: string[] | undefined
}

export interface WatchOutcome {
  key: string
  seasonId: string | null
  outcome: SourceOutcome
  extractor: ExtractorName | null
}

const message = (err: unknown): string => (err instanceof Error ? err.message : JSON.stringify(err))

/**
 * One watcher run: list the bucket, find new/revised/failed PDFs, pick one
 * per season, run the cascade, and publish or file an issue. All side
 * effects go through `deps`.
 */
export async function runWatch(opts: WatchOptions, deps: WatchDeps): Promise<WatchOutcome[]> {
  const live = !opts.dryRun
  const startedAt = deps.now().toISOString()

  const objects: BucketObject[] = []
  try {
    for (const prefix of opts.prefixes ?? prefixesFor(deps.now())) {
      objects.push(...(await deps.listBucket(prefix)))
    }
  } catch (err) {
    if (live) {
      await deps.issues.ensure(
        BUCKET_ISSUE_TITLE,
        [
          `Listing the RSD bucket failed at ${startedAt}:`,
          '',
          `    ${message(err)}`,
          '',
          'Manual `ingest` with a PDF URL still works. This issue closes itself after the next successful listing.',
        ].join('\n'),
      )
    }
    throw err
  }
  if (live) await deps.issues.close(BUCKET_ISSUE_TITLE, `Bucket listing succeeded again at ${startedAt}.`)

  let sources = await loadSources(opts.sourcesPath)
  const calendar = await loadCalendar(resolve(opts.repoRoot, 'calendar.json'))
  const outcomes: WatchOutcome[] = []
  let stateChanged = false

  const record = (
    obj: BucketObject,
    seasonId: string | null,
    outcome: SourceOutcome,
    extractor: ExtractorName | null,
  ): void => {
    outcomes.push({ key: obj.key, seasonId, outcome, extractor })
    const prev = sources.find((s) => s.key === obj.key)
    // Unchanged (e.g. the same failure again): no state churn, no commit.
    if (prev && prev.etag === obj.etag && prev.outcome === outcome && prev.seasonId === seasonId) return
    sources = upsertSource(sources, {
      key: obj.key,
      etag: obj.etag,
      lastModified: obj.lastModified,
      seasonId,
      outcome,
      extractor,
      processedAt: deps.now().toISOString(),
    })
    stateChanged = true
  }

  const processKey = async (obj: BucketObject, seasonId: string): Promise<void> => {
    const fail = async (body: string): Promise<void> => {
      record(obj, seasonId, 'failed', null)
      if (live) await deps.issues.ensure(failureIssueTitle(seasonId, obj.etag), `Source: \`${obj.key}\`\n\n${body}`)
    }

    const date = seasonDate(seasonId, calendar)
    if (!date) {
      await fail(`No date for ${seasonId}: add the year's April date to calendar.json. The watcher retries daily.`)
      return
    }

    let pdf: Buffer
    try {
      pdf = await deps.fetchPdf(obj.key)
    } catch (err) {
      await fail(`Downloading the PDF failed: ${message(err)}`)
      return
    }
    const pdfText = await deps.pdfText(pdf).catch((err: unknown) => {
      deps.log(`pdf text layer failed for ${obj.key}: ${message(err)}`)
      return ''
    })
    const context = await loadGateContext(opts.repoRoot, seasonId)
    const extractors = opts.only ? deps.extractors.filter((e) => e.name === opts.only) : deps.extractors
    const result = await runCascade({
      pdf,
      pdfText,
      extractors,
      ...context,
      title: `${seasonId} from \`${obj.key}\``,
    })
    await deps.summary(result.report)

    if (result.passed && result.releases && result.extractor) {
      record(obj, seasonId, 'published', result.extractor)
      if (!live) {
        deps.log(`[dry-run] would publish ${seasonId}: ${result.releases.length} releases via ${result.extractor}`)
        return
      }
      try {
        await deps.publish({ repoRoot: opts.repoRoot, seasonId, date, releases: result.releases })
        await saveSources(opts.sourcesPath, sources)
        const sha = await deps.git.commitAndPush(
          `chore: ingest ${seasonId} from ${obj.key} (${result.extractor})`,
          ['current.json', 'seasons.json', 'sources.json', `releases/${seasonId}`],
        )
        stateChanged = false // sources.json went out with this commit
        await deps.issues.closeByPrefix(
          seasonIssuePrefix(seasonId),
          `Published ${sha ? `in ${sha}` : '(no file changes)'} from \`${obj.key}\` via ${result.extractor}.`,
        )
      } catch (err) {
        await deps.issues.ensure(
          failureIssueTitle(seasonId, obj.etag),
          `Source: \`${obj.key}\`\n\nThe list passed the gate but publishing failed: ${message(err)}\n\n${result.report}`,
        )
        throw err
      }
      return
    }

    // Pledge forms, logo packs and the like: no list in the name, the parser
    // found nothing, and an LLM actually looked and found no valid list.
    if (!hasListSignal(obj.key) && !result.parserFoundRows && result.llmRan) {
      record(obj, null, 'not-a-list', null)
      return
    }
    await fail(result.report)
  }

  const bySeason = new Map<string, BucketObject[]>()
  for (const obj of pendingObjects(objects, sources)) {
    const c = classifyKey(obj.key)
    if (c.kind === 'ignored') continue
    if (c.kind === 'skipped-country') {
      record(obj, null, 'skipped-country', null)
      continue
    }
    bySeason.set(c.seasonId, [...(bySeason.get(c.seasonId) ?? []), obj])
  }

  for (const [seasonId, candidates] of bySeason) {
    // Published copies compete too, judged by the lastModified recorded in
    // sources.json (not this run's listing, which may not include them): an
    // older key that shows up late must never overwrite a newer list.
    const newestPublished = sources
      .filter((s) => s.seasonId === seasonId && s.outcome === 'published' && !candidates.some((c) => c.key === s.key))
      .map((s) => s.lastModified)
      .sort()
      .at(-1)
    const newest = [...candidates].sort((a, b) => b.lastModified.localeCompare(a.lastModified))[0]
    const winner = newest && (!newestPublished || newest.lastModified > newestPublished) ? newest : undefined
    for (const obj of candidates) if (obj !== winner) record(obj, seasonId, 'superseded', null)
    if (winner) await processKey(winner, seasonId)
  }

  if (live && stateChanged) {
    await saveSources(opts.sourcesPath, sources)
    await deps.git.commitAndPush('chore: watch-rsd state', ['sources.json'])
  }
  return outcomes
}
