import { beforeAll, describe, expect, it, vi } from 'vitest'

import { defaultExtractors, runCascade } from '../../scripts/extract/index.js'
import type { ExtractedRow, Extractor, ExtractorName } from '../../scripts/extract/types.js'
import type { RawRelease } from '../../scripts/types.js'
import { loadRaw, toRows } from '../helpers/releases.js'

let november: RawRelease[]
let rows: ExtractedRow[]
beforeAll(async () => {
  november = await loadRaw('2025-november')
  rows = toRows(november)
})

const returns = (name: ExtractorName, out: ExtractedRow[]): Extractor => ({
  name,
  extract: vi.fn(async () => out),
})
const throws = (name: ExtractorName, message: string): Extractor => ({
  name,
  extract: vi.fn(async () => {
    throw new Error(message)
  }),
})
const input = (extractors: Extractor[], pdfText = '') => ({
  pdf: Buffer.from(''),
  pdfText,
  extractors,
  previousSameSeason: null,
  lastComparableCount: 173,
  title: '2026-november from test.pdf',
})

describe('runCascade', () => {
  it('stops at the parser when it passes', async () => {
    const gemini = returns('gemini', rows)
    const r = await runCascade(input([returns('parser', rows), gemini]))
    expect(r.passed).toBe(true)
    expect(r.extractor).toBe('parser')
    expect(r.releases).toHaveLength(173)
    expect(gemini.extract).not.toHaveBeenCalled()
  })

  it('falls through a parser error to a passing Gemini', async () => {
    const text = november.map((x) => `${x.artist} ${x.title}`).join('\n')
    const r = await runCascade(input([throws('parser', 'no grid'), returns('gemini', rows)], text))
    expect(r.extractor).toBe('gemini')
    expect(r.attempts.map((a) => a.outcome)).toEqual(['error', 'passed'])
    expect(r.parserFoundRows).toBe(false)
    expect(r.llmRan).toBe(true)
  })

  it('reports every attempt when nothing passes', async () => {
    const r = await runCascade(
      input([returns('parser', rows.slice(0, 10)), returns('gemini', rows), throws('claude', 'HTTP 529')]),
    )
    expect(r.passed).toBe(false)
    expect(r.releases).toBeNull()
    expect(r.attempts.map((a) => [a.name, a.outcome])).toEqual([
      ['parser', 'failed-gate'],
      ['gemini', 'failed-gate'],
      ['claude', 'error'],
    ])
    expect(r.parserFoundRows).toBe(true)
    expect(r.llmRan).toBe(true)
    expect(r.report).toContain('| claude | error |')
    expect(r.report).toContain('HTTP 529')
  })

  it('does not count an LLM that errored as having run', async () => {
    const r = await runCascade(input([throws('parser', 'no grid'), throws('gemini', 'HTTP 429')]))
    expect(r.llmRan).toBe(false)
  })

  it('counts an LLM that returned no rows as having run', async () => {
    const r = await runCascade(input([throws('parser', 'no grid'), returns('gemini', [])]))
    expect(r.llmRan).toBe(true)
    expect(r.parserFoundRows).toBe(false)
  })
})

describe('defaultExtractors', () => {
  it('always includes the parser and adds LLMs by key', () => {
    expect(defaultExtractors({}).map((e) => e.name)).toEqual(['parser'])
    expect(defaultExtractors({ GEMINI_API_KEY: 'g' }).map((e) => e.name)).toEqual(['parser', 'gemini'])
    expect(defaultExtractors({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }).map((e) => e.name)).toEqual([
      'parser',
      'gemini',
      'claude',
    ])
  })
})
