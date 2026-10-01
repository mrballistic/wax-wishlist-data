import Anthropic from '@anthropic-ai/sdk'

import { EXTRACTION_PROMPT, parseRowsJson, ROWS_JSON_SCHEMA } from './prompt.js'
import type { ExtractedRow, Extractor } from './types.js'

export const CLAUDE_MODEL = 'claude-opus-5-5'

/** The slice of the SDK client we use; tests pass a fake. */
export type ClaudeClient = Pick<Anthropic, 'beta'>

export interface ClaudeOptions {
  client?: ClaudeClient
  apiKey?: string
}

/**
 * Second LLM fallback, only built when ANTHROPIC_API_KEY is set. Streams
 * (a ~350-row list is a long reply) and reads the result with
 * `finalMessage()`. On a safety-classifier refusal the API re-runs the
 * request on Anthropic's recommended fallback model (`fallbacks: 'default'`).
 */
export function createClaudeExtractor(opts: ClaudeOptions = {}): Extractor {
  const client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {})
  return {
    name: 'claude',
    async extract(pdf: Buffer): Promise<ExtractedRow[]> {
      const stream = client.beta.messages.stream({
        model: CLAUDE_MODEL,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: 'medium',
          format: { type: 'json_schema', schema: ROWS_JSON_SCHEMA },
        },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
              },
              { type: 'text', text: EXTRACTION_PROMPT },
            ],
          },
        ],
      })
      const message = await stream.finalMessage()
      if (message.stop_reason === 'refusal') {
        throw new Error(`Claude declined (${message.stop_details?.category ?? 'no category'})`)
      }
      if (message.stop_reason === 'max_tokens') {
        throw new Error('Claude hit max_tokens; output would be incomplete')
      }
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      return parseRowsJson(text, 'Claude')
    },
  }
}
