import { resolve } from 'node:path'

import { droppedLines } from '../extract/gate.js'
import { runCascade } from '../extract/index.js'
import type { Extractor, ExtractorName } from '../extract/types.js'

import { prefixesFor } from './bucket.js'
import { loadCalendar, seasonDate } from './calendar.js'
import { classifyKey, hasListSignal } from './classify.js'
import type { GitOps } from './git.js'
import {
  BUCKET_ISSUE_TITLE,
  failureIssueTitle,
  incompleteIssueTitle,
  type IssueClient,
  seasonIssuePrefix,
} from './issues.js'
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
 * Thrown at the end of a run in which a gate-passed list failed to publish.
 * The run still processed every other season and committed its state first;
 * `outcomes` carries the full table so the CLI can still report it.
 */
export class WatchPublishError extends Error {
  override name = 'WatchPublishError'
  constructor(
    readonly failures: { seasonId: string; key: string; error: string }[],
    readonly outcomes: WatchOutcome[],
  ) {
    super(`Publishing failed for ${failures.map((f) => `${f.seasonId} (${f.key}): ${f.error}`).join('; ')}`)
  }
}

/**
 * One watcher run: list the bucket, find new/revised/failed PDFs, try each
 * season's candidates newest-first until one publishes or fails (skipping
 * not-a-list PDFs), and publish or file an issue. All side effects go
 * through `deps`. Rejects with `WatchPublishError` after the state commit if
 * any publish step threw.
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
  const publishFailures: { seasonId: string; key: string; error: string }[] = []

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

  const processKey = async (obj: BucketObject, seasonId: string): Promise<SourceOutcome> => {
    const fail = async (body: string): Promise<SourceOutcome> => {
      record(obj, seasonId, 'failed', null)
      if (live) await deps.issues.ensure(failureIssueTitle(seasonId, obj.etag), `Source: \`${obj.key}\`\n\n${body}`)
      return 'failed'
    }

    const date = seasonDate(seasonId, calendar)
    if (!date) {
      return fail(`No date for ${seasonId}: add the year's April date to calendar.json. The watcher retries daily.`)
    }

    let pdf: Buffer
    try {
      pdf = await deps.fetchPdf(obj.key)
    } catch (err) {
      return fail(`Downloading the PDF failed: ${message(err)}`)
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
        if (result.dropped.length > 0) deps.log(`[dry-run] would drop ${result.dropped.length} incomplete rows`)
        return 'published'
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
        if (result.dropped.length > 0) {
          try {
            await deps.issues.ensure(
              incompleteIssueTitle(seasonId, obj.etag),
              [
                `Source: \`${obj.key}\``,
                `Published${sha ? ` in ${sha}` : ''} via ${result.extractor}, without ${result.dropped.length} rows that had an empty artist, title, label or format.`,
                '',
                ...droppedLines(result.dropped),
                '',
                'If these are real releases, add them by hand (for example via wax-wishlist-art-admin, or by editing `releases/' +
                  `${seasonId}/releases.json\`). Format of each row: category | artist | title | label | format.`,
              ].join('\n'),
            )
          } catch (issueErr) {
            // The publish already succeeded; don't mark the key failed.
            deps.log(
              `opening the incomplete-rows issue for ${seasonId} failed: ${message(issueErr)}`,
            )
          }
        }
      } catch (err) {
        // Keep going with the other seasons; the run rejects at the end.
        deps.log(`publishing ${seasonId} from ${obj.key} failed: ${message(err)}`)
        publishFailures.push({ seasonId, key: obj.key, error: message(err) })
        record(obj, seasonId, 'failed', null)
        try {
          await deps.issues.ensure(
            failureIssueTitle(seasonId, obj.etag),
            `Source: \`${obj.key}\`\n\nThe list passed the gate but publishing failed: ${message(err)}\n\n${result.report}`,
          )
        } catch (issueErr) {
          // Don't let a GitHub hiccup mask the publish error.
          deps.log(`opening the failure issue for ${seasonId} also failed: ${message(issueErr)}`)
        }
        return 'failed'
      }
      return 'published'
    }

    // Pledge forms, logo packs and the like: no list in the name, the parser
    // found nothing, and an LLM actually looked and found no valid list.
    if (!hasListSignal(obj.key) && !result.parserFoundRows && result.llmRan) {
      record(obj, null, 'not-a-list', null)
      return 'not-a-list'
    }
    return fail(result.report)
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
    // Newest first. A not-a-list PDF (a pledge form uploaded after the real
    // list) must not bury the list, so fall through to the next older one;
    // stop at the first that publishes or fails. Everything after that, and
    // anything not newer than the published copy, is superseded.
    const ordered = [...candidates].sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    let settled = false
    for (const obj of ordered) {
      const eligible = !newestPublished || obj.lastModified > newestPublished
      if (settled || !eligible) {
        record(obj, seasonId, 'superseded', null)
        continue
      }
      if ((await processKey(obj, seasonId)) !== 'not-a-list') settled = true
    }
  }

  if (live && stateChanged) {
    await saveSources(opts.sourcesPath, sources)
    await deps.git.commitAndPush('chore: watch-rsd state', ['sources.json'])
  }
  if (publishFailures.length > 0) throw new WatchPublishError(publishFailures, outcomes)
  return outcomes
}
