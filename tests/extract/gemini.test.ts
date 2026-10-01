import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createGeminiExtractor, GEMINI_MODEL, GEMINI_MODELS } from '../../scripts/extract/gemini.js'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/:call'
const ROWS = {
  rows: [{ category: 'E', artist: 'a-ha', title: 'Analogue', label: 'Rhino', format: '2 x LP' }],
}
// Shape recorded from a real gemini-3.8-flash reply on 2026-09-30 (thought
// signature shortened).
const reply = (text: string, finishReason = 'STOP') => ({
  candidates: [
    { content: { role: 'model', parts: [{ text, thoughtSignature: 'EqQF…' }] }, finishReason },
  ],
  modelVersion: GEMINI_MODEL,
})

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
afterEach(() => sleep.mockClear())
const extractor = createGeminiExtractor({ apiKey: 'test-key', sleep })
const [M1, M2, M3] = GEMINI_MODELS
const pdf = Buffer.from('%PDF-1.7 fake')

type Scripted = (model: string, n: number) => Response | Promise<Response>
/** Route each model's request through `script`; returns the models called, in order. */
function script(fn: Scripted): string[] {
  const calls: string[] = []
  const counts = new Map<string, number>()
  server.use(
    http.post(ENDPOINT, ({ params }) => {
      const model = String(params['call']).replace(/:generateContent$/, '')
      calls.push(model)
      const n = (counts.get(model) ?? 0) + 1
      counts.set(model, n)
      return fn(model, n)
    }),
  )
  return calls
}
const ok = (): Response => HttpResponse.json(reply(JSON.stringify(ROWS)))
const status = (code: number, headers?: Record<string, string>): Response =>
  HttpResponse.json({ error: { message: 'x' } }, { status: code, ...(headers ? { headers } : {}) })

describe('gemini extractor', () => {
  it('sends the PDF inline with the key header and response schema', async () => {
    let seen: { key: string | null; body: Record<string, unknown> } | null = null
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        seen = {
          key: request.headers.get('x-goog-api-key'),
          body: (await request.json()) as Record<string, unknown>,
        }
        return HttpResponse.json(reply(JSON.stringify(ROWS)))
      }),
    )
    const rows = await extractor.extract(pdf)
    expect(rows).toEqual(ROWS.rows)
    expect(seen).not.toBeNull()
    const body = JSON.stringify(seen)
    expect(body).toContain('"key":"test-key"')
    expect(body).toContain('"mimeType":"application/pdf"')
    expect(body).toContain(pdf.toString('base64'))
    expect(body).toContain('"responseMimeType":"application/json"')
    expect(body).toContain('"maxOutputTokens":65536')
  })

  it('ignores thought parts', async () => {
    script(() =>
      HttpResponse.json({
        candidates: [
          {
            content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify(ROWS) }] },
            finishReason: 'STOP',
          },
        ],
      }),
    )
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
  })

  it('exposes the model chain newest first, with GEMINI_MODEL as its head', () => {
    expect([...GEMINI_MODELS]).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
    ])
    expect(GEMINI_MODEL).toBe('gemini-3.8-flash')
  })

  it('falls over from a 503 to the next model with no sleep, and says so in detail()', async () => {
    const calls = script((m) => (m === M1 ? status(503) : ok()))
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
    expect(calls).toEqual([M1, M2])
    expect(sleep).not.toHaveBeenCalled()
    expect(extractor.detail?.()).toBe(`answered by ${M2} after 1 failed (${M1}: HTTP 503)`)
  })

  it('detail() is just the model when the first answers', async () => {
    script(() => ok())
    await extractor.extract(pdf)
    expect(extractor.detail?.()).toBe(`answered by ${M1}`)
  })

  it('lists every earlier failure in detail()', async () => {
    script((m) => (m === M3 ? ok() : status(503)))
    await extractor.extract(pdf)
    expect(extractor.detail?.()).toBe(
      `answered by ${M3} after 2 failed (${M1}: HTTP 503; ${M2}: HTTP 503)`,
    )
  })

  it('falls over on a 429', async () => {
    const calls = script((m) => (m === M1 ? status(429) : ok()))
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
    expect(calls).toEqual([M1, M2])
  })

  it('falls over on a 404 (model retired)', async () => {
    const calls = script((m) => (m === M1 ? status(404) : ok()))
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
    expect(calls).toEqual([M1, M2])
  })

  it('falls over on a network error', async () => {
    const calls = script((m) => (m === M1 ? HttpResponse.error() : ok()))
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
    expect(calls).toEqual([M1, M2])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('never returns partial output: MAX_TOKENS from one model moves on to the next', async () => {
    const partial = { rows: [{ ...ROWS.rows[0], artist: 'Partial', title: 'Cut off' }] }
    const calls = script((m) =>
      m === M1 ? HttpResponse.json(reply(JSON.stringify(partial), 'MAX_TOKENS')) : ok(),
    )
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
    expect(calls).toEqual([M1, M2])
    expect(extractor.detail?.()).toContain('finishReason MAX_TOKENS')
  })

  it('throws at once on a 400 without trying other models', async () => {
    const calls = script(() => status(400))
    await expect(extractor.extract(pdf)).rejects.toThrow(new RegExp(`${M1}.*HTTP 400`))
    expect(calls).toEqual([M1])
    expect(sleep).not.toHaveBeenCalled()
  })

  it.each([401, 403])('throws at once on a %i', async (code) => {
    const calls = script(() => status(code))
    await expect(extractor.extract(pdf)).rejects.toThrow(new RegExp(`HTTP ${code}`))
    expect(calls).toHaveLength(1)
  })

  it('sleeps 60s once between rounds, then succeeds in round 2', async () => {
    const calls = script((m, n) => (n === 1 ? status(503) : m === M1 ? ok() : status(503)))
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
    expect(calls).toHaveLength(6)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(60_000)
  })

  it('waits the largest Retry-After seen in the round', async () => {
    script((m, n) => {
      if (n > 1) return ok()
      if (m === M1) return status(429, { 'Retry-After': '12' })
      if (m === M2) return status(429, { 'Retry-After': '7' })
      return status(503)
    })
    await extractor.extract(pdf)
    expect(sleep).toHaveBeenCalledWith(12_000)
  })

  it('ignores a non-numeric Retry-After and waits 60s', async () => {
    script((m, n) =>
      n > 1 ? ok() : status(429, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    )
    await extractor.extract(pdf)
    expect(sleep).toHaveBeenCalledWith(60_000)
  })

  it('caps a long Retry-After at 300s', async () => {
    script((m, n) => (n > 1 ? ok() : m === M1 ? status(429, { 'Retry-After': '900' }) : status(503)))
    await extractor.extract(pdf)
    expect(sleep).toHaveBeenCalledWith(300_000)
  })

  it('throws a summary naming every model after two failed rounds', async () => {
    const calls = script((m) => (m === M3 ? HttpResponse.json(reply('{"rows":[', 'MAX_TOKENS')) : status(503)))
    const err = await extractor.extract(pdf).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain('no model produced a usable reply after 2 rounds')
    for (const m of GEMINI_MODELS) expect(msg).toContain(m)
    expect(msg).toContain(`${M1}: HTTP 503`)
    expect(msg).toContain(`${M3}: finishReason MAX_TOKENS`)
    expect(calls).toHaveLength(10)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(extractor.detail?.()).toBeNull()
  })

  it('uses only the given model for the model shorthand', async () => {
    const calls = script(() => status(503))
    const one = createGeminiExtractor({ apiKey: 'test-key', sleep, model: 'gemini-x' })
    await expect(one.extract(pdf)).rejects.toThrow(/gemini-x: HTTP 503/)
    expect(new Set(calls)).toEqual(new Set(['gemini-x']))
  })

  it('lets models win over model', async () => {
    const calls = script(() => ok())
    const e = createGeminiExtractor({ apiKey: 'k', sleep, model: 'gemini-x', models: ['gemini-y', 'gemini-z'] })
    await e.extract(pdf)
    expect(calls).toEqual(['gemini-y'])
  })

  it('moves on from a blocked prompt, malformed JSON and schema mismatch', async () => {
    const bad = { rows: [{ ...ROWS.rows[0], category: 'X' }] }
    const cases: [Response, RegExp][] = [
      [HttpResponse.json({ promptFeedback: { blockReason: 'OTHER' } }), /blocked \(OTHER\)/],
      [HttpResponse.json({}), /no candidates/],
      [HttpResponse.json(reply('not json')), /malformed JSON/],
      [HttpResponse.json(reply(JSON.stringify(bad))), /did not match the row schema/],
    ]
    for (const [res, pattern] of cases) {
      const calls = script(() => res.clone())
      await expect(extractor.extract(pdf)).rejects.toThrow(pattern)
      expect(calls).toHaveLength(10)
      server.resetHandlers()
    }
  })
})
