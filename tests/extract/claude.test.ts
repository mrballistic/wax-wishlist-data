import { describe, expect, it } from 'vitest'

import { CLAUDE_MODEL, type ClaudeClient, createClaudeExtractor } from '../../scripts/extract/claude.js'

const ROWS = {
  rows: [{ category: 'L', artist: 'Collective Soul', title: 'Touch and Go', label: 'Fuzze-Flex Records', format: 'LP' }],
}

/** A stand-in for the SDK client; `finalMessage` resolves to a recorded-shape BetaMessage. */
function fakeClient(message: Record<string, unknown>, seen: unknown[] = []): ClaudeClient {
  return {
    beta: {
      messages: {
        stream: (params: unknown) => {
          seen.push(params)
          return { finalMessage: async () => message }
        },
      },
    },
  } as unknown as ClaudeClient
}

const ok = (text: string) => ({
  stop_reason: 'end_turn',
  stop_details: null,
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text },
  ],
})
const pdf = Buffer.from('%PDF-1.7 fake')

describe('claude extractor', () => {
  it('sends the PDF as a base64 document with structured output and fallbacks', async () => {
    const seen: unknown[] = []
    const rows = await createClaudeExtractor({ client: fakeClient(ok(JSON.stringify(ROWS)), seen) }).extract(pdf)
    expect(rows).toEqual(ROWS.rows)
    const params = JSON.stringify(seen[0])
    expect(params).toContain(`"model":"${CLAUDE_MODEL}"`)
    expect(params).toContain('"fallbacks":"default"')
    expect(params).toContain('server-side-fallback-2026-07-01')
    expect(params).toContain('"type":"json_schema"')
    expect(params).toContain('"media_type":"application/pdf"')
    expect(params).toContain(pdf.toString('base64'))
  })

  it('throws on a refusal', async () => {
    const client = fakeClient({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] })
    await expect(createClaudeExtractor({ client }).extract(pdf)).rejects.toThrow(/declined \(cyber\)/)
  })

  it('throws when cut off at max_tokens', async () => {
    const client = fakeClient({ ...ok('{"rows":['), stop_reason: 'max_tokens' })
    await expect(createClaudeExtractor({ client }).extract(pdf)).rejects.toThrow(/max_tokens/)
  })

  it('throws on malformed JSON', async () => {
    const client = fakeClient(ok('nope'))
    await expect(createClaudeExtractor({ client }).extract(pdf)).rejects.toThrow(/malformed JSON/)
  })
})
