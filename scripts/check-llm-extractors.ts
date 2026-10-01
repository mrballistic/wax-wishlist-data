import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createClaudeExtractor } from './extract/claude.js'
import { finalizeRows } from './extract/finalize.js'
import { checkCandidate } from './extract/gate.js'
import { createGeminiExtractor } from './extract/gemini.js'
import { pdfTextLayer } from './extract/pdf-text.js'
import type { Extractor } from './extract/types.js'
import { loadGateContext } from './watch/season-context.js'

/**
 * Live check of one LLM extractor against a real PDF (spends API quota; not
 * run in CI). With a season id, the gate compares against that season, so
 * `2025-november` + the BF 2025 fixture shows how close the model gets to
 * the published list.
 *
 *   pnpm tsx --env-file=.env scripts/check-llm-extractors.ts gemini tests/fixtures/2025-november.pdf 2025-november
 */
async function main(): Promise<void> {
  const [, , provider, pdfPath, seasonId] = process.argv
  if ((provider !== 'gemini' && provider !== 'claude') || !pdfPath) {
    console.error('Usage: pnpm tsx --env-file=.env scripts/check-llm-extractors.ts <gemini|claude> <pdf> [season-id]')
    process.exit(1)
    return
  }
  const key = process.env[provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY']
  if (!key) throw new Error(`${provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set`)
  const extractor: Extractor =
    provider === 'gemini' ? createGeminiExtractor({ apiKey: key }) : createClaudeExtractor({ apiKey: key })

  const pdf = await readFile(resolve(process.cwd(), pdfPath))
  const started = Date.now()
  const releases = finalizeRows(await extractor.extract(pdf))
  console.log(`${provider}: ${releases.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  const detail = extractor.detail?.()
  if (detail) console.log(detail)

  const context = seasonId
    ? await loadGateContext(process.cwd(), seasonId)
    : { previousSameSeason: null, lastComparableCount: null }
  const gate = checkCandidate(releases, { extractor: extractor.name, pdfText: await pdfTextLayer(pdf), ...context })
  console.log(gate.report)
  process.exit(gate.pass ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
