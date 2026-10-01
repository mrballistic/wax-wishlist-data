import { EXTRACTION_PROMPT, GEMINI_ROWS_SCHEMA, parseRowsJson } from './prompt.js'
import type { ExtractedRow, Extractor } from './types.js'

/**
 * Tried in order, newest first. Lite models are deliberately excluded: on
 * 2026-10-01 they miscounted the 173-row BF 2025 list as 198-200 rows. Edit
 * this list as Google retires and adds models (a retired one answers 404,
 * which just moves on to the next).
 */
export const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
] as const

/** The preferred model; kept for existing imports. */
export const GEMINI_MODEL = GEMINI_MODELS[0]

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
/** A full real extraction took ~81s and a 503 can take ~77s to arrive. */
const TIMEOUT_MS = 180_000
const ROUNDS = 2
const DEFAULT_WAIT_MS = 60_000
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
  /** Models to try in order. Defaults to GEMINI_MODELS. */
  models?: readonly string[]
  /** Shorthand for `models: [model]`; ignored when `models` is given. */
  model?: string
  fetchImpl?: typeof fetch
  /** Injectable so tests don't wait out the between-rounds pause. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Why one model gave no usable reply, and whether it should stop the whole chain. */
class ModelFailure extends Error {
  constructor(
    message: string,
    readonly fatal = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
  }
}

const short = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 80)

function retryAfterMs(header: string | null): number | null {
  const h = header?.trim() ?? ''
  return /^\d+$/.test(h) ? Number(h) * 1000 : null
}

function requestBody(pdf: Buffer): string {
  return JSON.stringify({
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
  })
}

/** One request to one model. Throws ModelFailure on anything but usable rows. */
async function tryModel(
  model: string,
  fetchImpl: typeof fetch,
  apiKey: string,
  body: string,
): Promise<ExtractedRow[]> {
  let res: Response
  try {
    res = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
      method: 'POST',
      // Key in a header, never the URL, so it can't leak into error text.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new ModelFailure(`request failed: ${short(err instanceof Error ? err.message : String(err))}`)
  }
  if (!res.ok) {
    const s = res.status
    const label = `HTTP ${s}`
    // 400/401/403 mean a bad request or key, which affects every model.
    if (s === 400 || s === 401 || s === 403) {
      const detail = short(await res.text().catch(() => ''))
      throw new ModelFailure(detail ? `${label}: ${detail}` : label, true)
    }
    throw new ModelFailure(label, false, retryAfterMs(res.headers.get('retry-after')))
  }
  let reply: GeminiResponse
  try {
    reply = (await res.json()) as GeminiResponse
  } catch {
    throw new ModelFailure('reply was not JSON')
  }
  if (reply.promptFeedback?.blockReason) {
    throw new ModelFailure(`blocked (${reply.promptFeedback.blockReason})`)
  }
  const candidate = reply.candidates?.[0]
  if (!candidate) throw new ModelFailure('no candidates')
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    // Partial output must never be returned.
    throw new ModelFailure(`finishReason ${candidate.finishReason}`)
  }
  const text = (candidate.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
  try {
    return parseRowsJson(text, 'Gemini')
  } catch (err) {
    throw new ModelFailure(short(err instanceof Error ? err.message : String(err)))
  }
}

export function createGeminiExtractor(opts: GeminiOptions): Extractor {
  const models: readonly string[] = opts.models ?? (opts.model ? [opts.model] : GEMINI_MODELS)
  let lastDetail: string | null = null
  return {
    name: 'gemini',
    detail: () => lastDetail,
    async extract(pdf: Buffer): Promise<ExtractedRow[]> {
      lastDetail = null
      // Resolved per call, not at creation: msw patches global fetch after module load.
      const fetchImpl = opts.fetchImpl ?? fetch
      const sleep = opts.sleep ?? defaultSleep
      const body = requestBody(pdf)
      // Every failure so far, in order; the last one per model feeds the summary.
      const failures: string[] = []
      const lastByModel = new Map<string, string>()

      for (let round = 1; round <= ROUNDS; round++) {
        let longestRetryAfter = 0
        for (const model of models) {
          try {
            const rows = await tryModel(model, fetchImpl, opts.apiKey, body)
            lastDetail =
              failures.length === 0
                ? `answered by ${model}`
                : `answered by ${model} after ${failures.length} failed (${failures.join('; ')})`
            return rows
          } catch (err) {
            if (!(err instanceof ModelFailure)) throw err
            if (err.fatal) throw new Error(`Gemini ${model} returned ${err.message}`)
            longestRetryAfter = Math.max(longestRetryAfter, err.retryAfterMs ?? 0)
            const entry = `${model}: ${err.message}`
            failures.push(entry)
            lastByModel.set(model, entry)
          }
        }
        if (round < ROUNDS) {
          await sleep(Math.min(longestRetryAfter || DEFAULT_WAIT_MS, MAX_WAIT_MS))
        }
      }
      throw new Error(
        `Gemini: no model produced a usable reply after ${ROUNDS} rounds (${[...lastByModel.values()].join('; ')})`,
      )
    },
  }
}
