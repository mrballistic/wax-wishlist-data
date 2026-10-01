import { appendFile } from 'node:fs/promises'

import type { WatchOutcome } from './run.js'

/** Append markdown to the Actions step summary, or print it locally. */
export async function writeStepSummary(markdown: string): Promise<void> {
  const path = process.env['GITHUB_STEP_SUMMARY']
  if (path) await appendFile(path, `${markdown}\n\n`, 'utf8')
  else console.log(markdown)
}

/** The end-of-run outcome table for the step summary. */
export function formatOutcomes(outcomes: WatchOutcome[]): string {
  if (outcomes.length === 0) return 'No new or revised PDFs.'
  const esc = (s: string): string => s.replace(/\|/g, '\\|')
  return [
    '### watch-rsd outcomes',
    '',
    '| Outcome | Season | Extractor | Key |',
    '|---|---|---|---|',
    ...outcomes.map((o) => `| ${o.outcome} | ${o.seasonId ?? '–'} | ${o.extractor ?? '–'} | \`${esc(o.key)}\` |`),
  ].join('\n')
}
