import { type ExtractedRow, ExtractedRowsSchema } from './types.js'

/** One prompt for every LLM extractor, so their outputs are comparable. */
export const EXTRACTION_PROMPT = [
  'This PDF is a Record Store Day release list: a table with one release per row.',
  'Transcribe every release row into the `rows` array, in document order.',
  '- `category` is the single letter in the first column: E, L or F.',
  '- Copy `artist`, `title`, `label` and `format` exactly as printed: same spelling, capitalization, punctuation and accents. Do not correct, expand or abbreviate anything.',
  '- If a field wraps onto a second line, join the lines with a single space.',
  '- Skip column headers, page headers and footers, legends, and anything that is not a release row.',
  '- If the document has no release table, return {"rows": []}.',
].join('\n')

const ROW_FIELDS = ['category', 'artist', 'title', 'label', 'format'] as const

/** JSON Schema for Claude structured outputs. */
export const ROWS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...ROW_FIELDS],
        properties: {
          category: { type: 'string', enum: ['E', 'L', 'F'] },
          artist: { type: 'string' },
          title: { type: 'string' },
          label: { type: 'string' },
          format: { type: 'string' },
        },
      },
    },
  },
}

/** Gemini `responseSchema` (OpenAPI subset: no additionalProperties). */
export const GEMINI_ROWS_SCHEMA = {
  type: 'OBJECT',
  required: ['rows'],
  properties: {
    rows: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: [...ROW_FIELDS],
        propertyOrdering: [...ROW_FIELDS],
        properties: {
          category: { type: 'STRING', enum: ['E', 'L', 'F'] },
          artist: { type: 'STRING' },
          title: { type: 'STRING' },
          label: { type: 'STRING' },
          format: { type: 'STRING' },
        },
      },
    },
  },
}

/** Parse and validate an LLM's JSON reply. Throws with a short reason. */
export function parseRowsJson(text: string, source: string): ExtractedRow[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${source} returned malformed JSON (${text.length} chars)`)
  }
  const parsed = ExtractedRowsSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `${source} output did not match the row schema: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown'}`,
    )
  }
  return parsed.data.rows
}
