import type { RawRelease } from '../types.js'

import { createClaudeExtractor } from './claude.js'
import { finalizeRows } from './finalize.js'
import { checkCandidate } from './gate.js'
import { createGeminiExtractor } from './gemini.js'
import { parserExtractor } from './parser.js'
import type { ExtractedRow, Extractor, ExtractorName } from './types.js'

export interface ExtractorAttempt {
  name: ExtractorName
  outcome: 'passed' | 'failed-gate' | 'error'
  rowCount: number | null
  failures: string[]
  report: string
}

export interface CascadeInput {
  pdf: Buffer
  pdfText: string
  extractors: Extractor[]
  previousSameSeason: RawRelease[] | null
  lastComparableCount: number | null
  /** Heading for the report, e.g. "2026-november from `<key>`". */
  title: string
  /**
   * Row repair (scripts/rsd/repair.ts): given an extractor's rows and its
   * partial rows, returns the rows to finalize. Absent: partial rows are
   * dropped, as before.
   */
  repair?: ((rows: ExtractedRow[], partial: ExtractedRow[]) => ExtractedRow[]) | undefined
}

export interface CascadeResult {
  passed: boolean
  extractor: ExtractorName | null
  releases: RawRelease[] | null
  /** Incomplete rows the winner's gate removed; [] when nothing passed. */
  dropped: RawRelease[]
  attempts: ExtractorAttempt[]
  /** The parser ran without error and produced at least one row. */
  parserFoundRows: boolean
  /** At least one LLM extractor returned a result (even an empty one). */
  llmRan: boolean
  report: string
}

/** The env var that enables each extractor (the parser needs none). */
export const EXTRACTOR_ENV: Record<ExtractorName, string | null> = {
  parser: null,
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
}

/** parser always; gemini/claude only when their key is set. */
export function defaultExtractors(env: NodeJS.ProcessEnv = process.env): Extractor[] {
  const extractors: Extractor[] = [parserExtractor]
  const geminiKey = env['GEMINI_API_KEY']
  if (geminiKey) extractors.push(createGeminiExtractor({ apiKey: geminiKey }))
  const anthropicKey = env['ANTHROPIC_API_KEY']
  if (anthropicKey) extractors.push(createClaudeExtractor({ apiKey: anthropicKey }))
  return extractors
}

const cell = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 200)

function render(input: CascadeInput, attempts: ExtractorAttempt[], winner: ExtractorName | null): string {
  const lines = [
    `### ${input.title}`,
    '',
    '| Extractor | Outcome | Rows | Notes |',
    '|---|---|---|---|',
    ...attempts.map(
      (a) => `| ${a.name} | ${a.outcome} | ${a.rowCount ?? '–'} | ${cell(a.failures.join('; '))} |`,
    ),
    '',
    winner ? `**Result:** passed the gate with \`${winner}\`.` : '**Result:** no extractor passed the gate.',
  ]
  for (const a of attempts) if (a.report) lines.push('', a.report)
  return lines.join('\n')
}

/**
 * Run extractors in order and return the first candidate that passes the
 * gate. A thrown error (rate limit, refusal, unset key, malformed output)
 * fails that extractor only; the next one runs.
 */
export async function runCascade(input: CascadeInput): Promise<CascadeResult> {
  const attempts: ExtractorAttempt[] = []
  let winner: { name: ExtractorName; releases: RawRelease[]; dropped: RawRelease[] } | null = null

  for (const extractor of input.extractors) {
    let releases: RawRelease[]
    try {
      const rows = await extractor.extract(input.pdf)
      releases = finalizeRows(input.repair ? input.repair(rows, extractor.partialRows?.() ?? []) : rows)
    } catch (err) {
      const message = err instanceof Error ? err.message : JSON.stringify(err)
      attempts.push({ name: extractor.name, outcome: 'error', rowCount: null, failures: [message], report: '' })
      continue
    }
    const gate = checkCandidate(releases, {
      extractor: extractor.name,
      pdfText: input.pdfText,
      previousSameSeason: input.previousSameSeason,
      lastComparableCount: input.lastComparableCount,
    })
    const note = extractor.detail?.()
    attempts.push({
      name: extractor.name,
      outcome: gate.pass ? 'passed' : 'failed-gate',
      rowCount: releases.length,
      failures: note ? [...gate.failures, note] : gate.failures,
      report: gate.report,
    })
    if (gate.pass) {
      winner = { name: extractor.name, releases: gate.kept, dropped: gate.dropped }
      break
    }
  }

  return {
    passed: winner !== null,
    extractor: winner?.name ?? null,
    releases: winner?.releases ?? null,
    dropped: winner?.dropped ?? [],
    attempts,
    parserFoundRows: attempts.some((a) => a.name === 'parser' && a.outcome !== 'error' && (a.rowCount ?? 0) > 0),
    llmRan: attempts.some((a) => a.name !== 'parser' && a.outcome !== 'error'),
    report: render(input, attempts, winner?.name ?? null),
  }
}
