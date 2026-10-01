import { resolve } from 'node:path'

import { defaultExtractors, EXTRACTOR_ENV } from './extract/index.js'
import { pdfTextLayer } from './extract/pdf-text.js'
import type { ExtractorName } from './extract/types.js'
import { fetchPdf, listPdfs } from './watch/bucket.js'
import { createGitOps } from './watch/git.js'
import { createGitHubIssueClient, noopIssueClient } from './watch/issues.js'
import { publishSeason } from './watch/publish.js'
import { runWatch, type WatchOutcome, WatchPublishError } from './watch/run.js'
import { formatOutcomes, writeStepSummary } from './watch/summary.js'

const EXTRACTORS: ExtractorName[] = ['parser', 'gemini', 'claude']
const USAGE =
  'Usage: pnpm tsx scripts/watch-rsd.ts [--dry-run] [--sources=<path>] [--only=parser|gemini|claude] [--prefix=2025/]'

function flag(argv: string[], name: string): string[] {
  return argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const only = flag(argv, 'only')[0]
  if (only !== undefined && !EXTRACTORS.includes(only as ExtractorName)) {
    console.error(USAGE)
    process.exit(1)
    return
  }
  const extractors = defaultExtractors()
  if (only !== undefined && !extractors.some((e) => e.name === only)) {
    console.error(`--only=${only}: that extractor isn't configured; set ${EXTRACTOR_ENV[only as ExtractorName]}.`)
    process.exit(1)
    return
  }
  const prefixes = flag(argv, 'prefix')
  const repoRoot = resolve(process.cwd())
  const token = process.env['GITHUB_TOKEN']
  const repo = process.env['GITHUB_REPOSITORY']
  if (!dryRun && (!token || !repo)) {
    throw new Error('Publishing needs GITHUB_TOKEN and GITHUB_REPOSITORY; pass --dry-run to run locally.')
  }

  const report = async (outcomes: WatchOutcome[]): Promise<void> => {
    if (outcomes.length === 0) console.log('No new or revised PDFs.')
    for (const o of outcomes) {
      console.log(`${o.outcome.padEnd(15)} ${o.seasonId ?? '-'} ${o.extractor ?? ''} ${o.key}`)
    }
    // Locally writeStepSummary would print the table again; the lines above suffice.
    if (process.env['GITHUB_STEP_SUMMARY']) await writeStepSummary(formatOutcomes(outcomes))
  }

  let outcomes: WatchOutcome[]
  try {
    outcomes = await runWatch(
      {
        repoRoot,
        sourcesPath: resolve(repoRoot, flag(argv, 'sources')[0] ?? 'sources.json'),
        dryRun,
        only: only as ExtractorName | undefined,
        prefixes: prefixes.length > 0 ? prefixes : undefined,
      },
      {
        now: () => new Date(),
        listBucket: (prefix) => listPdfs(prefix),
        fetchPdf: (key) => fetchPdf(key),
        pdfText: pdfTextLayer,
        extractors,
        publish: (input) => publishSeason(input),
        issues: token && repo && !dryRun ? createGitHubIssueClient({ token, repo }) : noopIssueClient,
        git: createGitOps(repoRoot),
        summary: writeStepSummary,
        log: (line) => console.log(line),
      },
    )
  } catch (err) {
    // The other seasons were still processed and the state committed: report them.
    if (err instanceof WatchPublishError) await report(err.outcomes)
    throw err
  }
  await report(outcomes)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
