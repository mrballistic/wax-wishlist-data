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
}

export function createGeminiExtractor(opts: GeminiOptions): Extractor {
  const model = opts.model ?? GEMINI_MODEL
  return {
    name: 'gemini',
    async extract(pdf: Buffer): Promise<ExtractedRow[]> {
      // Resolved per call, not at creation: msw patches global fetch after module load.
      const fetchImpl = opts.fetchImpl ?? fetch
      const res = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
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
      if (!res.ok) {
        const detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
        throw new Error(`Gemini ${model} returned HTTP ${res.status}: ${detail}`)
      }
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
