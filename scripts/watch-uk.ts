import { access, appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { ingestUk, type IngestUkOptions, UkListMismatchError } from './ingest-uk.js'
import { CurrentSeasonSchema } from './types.js'
import { discoverUkPdf, type UkPdfLink } from './uk/discover.js'
import { loadUkList } from './uk/files.js'
import { formatUkReport, type UkMatchResult } from './uk/merge.js'
import { createGitHubIssueClient, type IssueClient, noopIssueClient } from './watch/issues.js'

/** A linked PDF last modified this long before the season's date belongs to an earlier event. */
export const MAX_PDF_AGE_DAYS = 300

export const ukIssueTitle = (seasonId: string): string =>
  `watch-uk: could not merge the UK list for ${seasonId}`

export type WatchUkOutcome =
  | { kind: 'no-season' }
  | { kind: 'no-us-list'; seasonId: string }
  | { kind: 'not-linked'; seasonId: string }
  | { kind: 'stale'; seasonId: string; link: UkPdfLink }
  | { kind: 'other-event'; seasonId: string; link: UkPdfLink; reason: string }
  | { kind: 'unchanged'; seasonId: string; link: UkPdfLink }
  | { kind: 'merged'; seasonId: string; link: UkPdfLink; result: UkMatchResult }

export interface WatchUkDeps {
  today: () => string
  discover: (seasonId: string) => Promise<UkPdfLink | null>
  ingest: (opts: IngestUkOptions) => Promise<UkMatchResult>
  issues: IssueClient
  log: (line: string) => void
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

/**
 * One UK watcher run for the upcoming season (current.json): find the list
 * PDF its recordstoreday.co.uk event page links, and merge it when it's new
 * or revised (URL or ETag differs from uk.json). Skips quietly before the US
 * list is published, before the UK page links a PDF, and while the page
 * still links an earlier event's PDF (too old, or it barely overlaps the US
 * list). A failure opens one issue per season
 * and rethrows; the next clean run closes it.
 */
export async function runWatchUk(
  opts: { repoRoot: string; dryRun?: boolean },
  deps: WatchUkDeps,
): Promise<WatchUkOutcome> {
  const current = CurrentSeasonSchema.parse(
    JSON.parse(await readFile(resolve(opts.repoRoot, 'current.json'), 'utf8')),
  )
  if (current.date < deps.today()) return { kind: 'no-season' }
  const seasonId = current.id
  if (!(await exists(resolve(opts.repoRoot, 'releases', seasonId, 'releases.json')))) {
    return { kind: 'no-us-list', seasonId }
  }

  const title = ukIssueTitle(seasonId)
  try {
    const link = await deps.discover(seasonId)
    if (!link) return { kind: 'not-linked', seasonId }

    const oldest = new Date(
      Date.parse(`${current.date}T00:00:00Z`) - MAX_PDF_AGE_DAYS * 86_400_000,
    ).toISOString()
    if (link.lastModified && link.lastModified < oldest) return { kind: 'stale', seasonId, link }

    const saved = await loadUkList(opts.repoRoot, seasonId)
    if (saved && saved.sourceUrl === link.url && (link.etag === null || saved.etag === link.etag)) {
      if (!opts.dryRun) await deps.issues.close(title, `The UK list for ${seasonId} is up to date.`)
      return { kind: 'unchanged', seasonId, link }
    }

    let result: UkMatchResult
    try {
      result = await deps.ingest({
        repoRoot: opts.repoRoot,
        seasonId,
        pdfUrl: link.url,
        etag: link.etag ?? undefined,
        dryRun: opts.dryRun,
      })
    } catch (err) {
      // The UK page often keeps linking last year's list (re-uploaded, so its
      // date can look recent) until the new one is out: wait quietly.
      if (err instanceof UkListMismatchError)
        return { kind: 'other-event', seasonId, link, reason: err.message }
      throw err
    }
    if (!opts.dryRun) await deps.issues.close(title, `Merged ${link.url}.`)
    return { kind: 'merged', seasonId, link, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err)
    if (!opts.dryRun) {
      try {
        await deps.issues.ensure(
          title,
          [
            `The UK watcher failed for ${seasonId}:`,
            '',
            `    ${message}`,
            '',
            'Retries daily. To merge by hand: run the `ingest-uk` workflow with the PDF URL linked from the season’s',
            'recordstoreday.co.uk event page. This issue closes itself after the next clean run.',
          ].join('\n'),
        )
      } catch (issueErr) {
        deps.log(
          `opening the issue also failed: ${issueErr instanceof Error ? issueErr.message : String(issueErr)}`,
        )
      }
    }
    throw err
  }
}

function describe(o: WatchUkOutcome): string {
  switch (o.kind) {
    case 'no-season':
      return 'No upcoming season.'
    case 'no-us-list':
      return `${o.seasonId}: US list not published yet; the UK list waits for it.`
    case 'not-linked':
      return `${o.seasonId}: recordstoreday.co.uk doesn’t link a list PDF yet.`
    case 'stale':
      return `${o.seasonId}: the linked PDF (${o.link.lastModified}) is from an earlier event; waiting for the new one.`
    case 'other-event':
      return `${o.seasonId}: the linked PDF looks like another event’s list; waiting for the new one. ${o.reason}`
    case 'unchanged':
      return `${o.seasonId}: UK list unchanged (${o.link.url}).`
    case 'merged':
      return `${o.seasonId}: merged ${o.link.url}.`
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const token = process.env['GITHUB_TOKEN']
  const repo = process.env['GITHUB_REPOSITORY']
  const outcome = await runWatchUk(
    { repoRoot: resolve(process.cwd()), dryRun },
    {
      today: () => process.env['OVERRIDE_TODAY'] ?? new Date().toISOString().slice(0, 10),
      discover: (seasonId) => discoverUkPdf(seasonId),
      ingest: (o) => ingestUk(o),
      issues: token && repo && !dryRun ? createGitHubIssueClient({ token, repo }) : noopIssueClient,
      log: (line) => console.log(line),
    },
  )
  console.log(describe(outcome))
  if (outcome.kind === 'merged') console.log(formatUkReport(outcome.result, outcome.seasonId))
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary) {
    await appendFile(
      summary,
      `${describe(outcome)}\n\n${outcome.kind === 'merged' ? formatUkReport(outcome.result, outcome.seasonId) : ''}`,
    )
  }
}

function isInvokedAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (entry.includes('vitest') || entry.includes('node_modules')) return false
  return entry.endsWith('watch-uk.ts') || entry.endsWith('watch-uk.js')
}

if (isInvokedAsCli()) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
