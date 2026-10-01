import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createGeminiExtractor, GEMINI_MODEL } from '../../scripts/extract/gemini.js'

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
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
const pdf = Buffer.from('%PDF-1.7 fake')

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
  })

  it('ignores thought parts', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.json({
          candidates: [
            {
              content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify(ROWS) }] },
              finishReason: 'STOP',
            },
          ],
        }),
      ),
    )
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
  })

  it('throws on a non-2xx reply, including the status', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.json({ error: { message: 'quota' } }, { status: 429 })))
    await expect(extractor.extract(pdf)).rejects.toThrow(/HTTP 429/)
  })

  it('retries a 503 once after 30s and succeeds', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls++
        return calls === 1
          ? HttpResponse.json({ error: { message: 'overloaded' } }, { status: 503 })
          : HttpResponse.json(reply(JSON.stringify(ROWS)))
      }),
    )
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
    expect(calls).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(30_000)
  })

  it('honours a numeric Retry-After on 429', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls++
        return calls === 1
          ? HttpResponse.json({ error: { message: 'quota' } }, { status: 429, headers: { 'Retry-After': '7' } })
          : HttpResponse.json(reply(JSON.stringify(ROWS)))
      }),
    )
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
    expect(sleep).toHaveBeenCalledWith(7000)
  })

  it('caps a long Retry-After at 300s', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls++
        return calls === 1
          ? HttpResponse.json({}, { status: 429, headers: { 'Retry-After': '3600' } })
          : HttpResponse.json(reply(JSON.stringify(ROWS)))
      }),
    )
    await extractor.extract(pdf)
    expect(sleep).toHaveBeenCalledWith(300_000)
  })

  it('gives up after three 503s with the status in the error', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls++
        return HttpResponse.json({ error: { message: 'overloaded' } }, { status: 503 })
      }),
    )
    await expect(extractor.extract(pdf)).rejects.toThrow(/HTTP 503/)
    expect(calls).toBe(3)
    expect(sleep.mock.calls).toEqual([[30_000], [120_000]])
  })

  it('does not retry a 400', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls++
        return HttpResponse.json({ error: { message: 'bad request' } }, { status: 400 })
      }),
    )
    await expect(extractor.extract(pdf)).rejects.toThrow(/HTTP 400/)
    expect(calls).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries a network error', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls++
        return calls === 1 ? HttpResponse.error() : HttpResponse.json(reply(JSON.stringify(ROWS)))
      }),
    )
    expect(await extractor.extract(pdf)).toEqual(ROWS.rows)
    expect(sleep).toHaveBeenCalledWith(30_000)
  })

  it('throws when the reply was cut off at the token limit', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.json(reply('{"rows":[', 'MAX_TOKENS'))))
    await expect(extractor.extract(pdf)).rejects.toThrow(/MAX_TOKENS/)
  })

  it('throws on malformed JSON', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.json(reply('not json'))))
    await expect(extractor.extract(pdf)).rejects.toThrow(/malformed JSON/)
  })

  it('throws on rows that do not match the schema', async () => {
    const bad = { rows: [{ ...ROWS.rows[0], category: 'X' }] }
    server.use(http.post(ENDPOINT, () => HttpResponse.json(reply(JSON.stringify(bad)))))
    await expect(extractor.extract(pdf)).rejects.toThrow(/did not match the row schema/)
  })

  it('throws when the prompt is blocked', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.json({ promptFeedback: { blockReason: 'OTHER' } })))
    await expect(extractor.extract(pdf)).rejects.toThrow(/blocked/)
  })
})
