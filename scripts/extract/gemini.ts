import { EXTRACTION_PROMPT, GEMINI_ROWS_SCHEMA, parseRowsJson } from './prompt.js'
import type { ExtractedRow, Extractor } from './types.js'

/**
 * Pinned so a model change is a reviewed commit. `gemini-flash-latest`
 * resolved to this on 2026-09-30, and it answered structured-output calls on
 * the free tier with the repo's key.
 */
export const GEMINI_MODEL = 'gemini-3.8-flash'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const TIMEOUT_MS = 300_000
const ATTEMPTS = 3
/** Waits before attempts 2 and 3 when the reply has no numeric Retry-After. */
const BACKOFF_MS = [30_000, 120_000]
const MAX_WAIT_MS = 300_000

interface GeminiPart {
  text?: string
  thought?: boolean
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
}

export interface GeminiOptions {
  apiKey: string
  model?: string
  fetchImpl?: typeof fetch
  /** Injectable so tests don't wait out the backoff. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 429 and 5xx are worth another try; other 4xx (bad request, bad key) are not. */
const isTransient = (status: number): boolean => status === 429 || status >= 500

function waitMs(retryAfter: string | null, attempt: number): number {
  const header = retryAfter?.trim() ?? ''
  const ms = /^\d+$/.test(header) ? Number(header) * 1000 : (BACKOFF_MS[attempt - 1] ?? MAX_WAIT_MS)
  return Math.min(ms, MAX_WAIT_MS)
}

/**
 * Send the request, retrying network errors, 429 and 5xx up to ATTEMPTS
 * times in all. Free-tier 429s and 503 "model overloaded" are routine.
 * Returns the first 2xx response; throws with the HTTP status otherwise.
 */
async function sendWithRetry(
  send: () => Promise<Response>,
  model: string,
  sleep: (ms: number) => Promise<void>,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await send()
    } catch (err) {
      const failure = new Error(
        `Gemini ${model} request failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      if (attempt >= ATTEMPTS) throw failure
      await sleep(waitMs(null, attempt))
      continue
    }
    if (res.ok) return res
    const detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
    const failure = new Error(`Gemini ${model} returned HTTP ${res.status}: ${detail}`)
    if (!isTransient(res.status) || attempt >= ATTEMPTS) throw failure
    await sleep(waitMs(res.headers.get('retry-after'), attempt))
  }
}

export function createGeminiExtractor(opts: GeminiOptions): Extractor {
  const model = opts.model ?? GEMINI_MODEL
  return {
    name: 'gemini',
    async extract(pdf: Buffer): Promise<ExtractedRow[]> {
      // Resolved per call, not at creation: msw patches global fetch after module load.
      const fetchImpl = opts.fetchImpl ?? fetch
      const send = (): Promise<Response> => fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        // Key in a header, never the URL, so it can't leak into error text.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') } },
                { text: EXTRACTION_PROMPT },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: GEMINI_ROWS_SCHEMA,
            maxOutputTokens: 65536,
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const res = await sendWithRetry(send, model, opts.sleep ?? defaultSleep)
      const body = (await res.json()) as GeminiResponse
      if (body.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked the request (${body.promptFeedback.blockReason})`)
      }
      const candidate = body.candidates?.[0]
      if (!candidate) throw new Error('Gemini returned no candidates')
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        throw new Error(`Gemini stopped early (finishReason ${candidate.finishReason}); output would be incomplete`)
      }
      const text = (candidate.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
      return parseRowsJson(text, 'Gemini')
    },
  }
}
