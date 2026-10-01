# Automatic Season Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect new and revised RSD release-list PDFs in RSD's public S3 bucket every day, extract them through a parser → Gemini → Claude cascade, publish only what passes one quality gate, and open a GitHub issue for everything else.

**Architecture:** `scripts/extract/` holds a common extractor contract, shared post-processing (`finalizeRows`, which owns release ids), the quality gate and the cascade. `scripts/watch/` holds the bucket client, state files (`sources.json`, `calendar.json`), key classification, issue and git side effects, the publish step, and the `runWatch` orchestrator. Every side effect is an injected dependency, so the orchestrator is tested with fakes. `ingest.ts` (manual) is rewired onto the same extract → gate → publish path before the watcher lands.

**Tech Stack:** TypeScript (ESM, Node 24, `tsx`), Zod 3.23.8, pdfjs-dist, Vitest 2 + msw 2, `@anthropic-ai/sdk`, Gemini REST API via `fetch`, GitHub REST API via `fetch`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-30-automatic-season-ingest-design.md`

## Global Constraints

- App-facing JSON contract is frozen: do not change any schema in `scripts/types.ts` or the shape of `current.json`, `seasons.json`, `releases/<id>/releases.json`.
- `artFilename` is always `<id>.jpg`; the art cascade only fills empty slots (existing behaviour of `enrichDiscogs` / `runArtCascade` — reuse, don't reimplement).
- Release ids depend only on artist + title (slug, `-2`/`-3` suffixes), never on which extractor ran.
- Gate thresholds, verbatim from the spec: ≥ 25 rows; artist/title/label/format non-empty on every row; category ∈ {exclusive, small-run, rsd-first}; unique ids; 0.6×–1.6× of the last same-kind season (non-revisions, when known); revisions ≤ 15% of previous ids removed and count change ≤ 25%; LLM rows (gemini, claude) ≥ 98% of artists and ≥ 98% of titles found in the PDF text layer after normalization (case-fold, NFKD, strip punctuation, collapse whitespace); empty text layer fails.
- Cascade order: `parser` always → `gemini` iff `GEMINI_API_KEY` set → `claude` iff `ANTHROPIC_API_KEY` set; stop at the first gate pass; a thrown extractor error is a failure of that extractor only.
- Gemini model constant: `gemini-3.8-flash` (what `gemini-flash-latest` resolved to on 2026-09-30, verified with the repo key). Claude model: `claude-opus-5-5`, streaming + `finalMessage()`, `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01`.
- Issue titles, verbatim: `watch-rsd: could not publish <season-id> (<etag-short>)` and `watch-rsd: bucket unreachable`. (The spec's `watch-rsd: unrecognized list PDF <key>` is unreachable: the year always falls back to the listing prefix, so every PDF resolves to a season. It is not implemented.)
- Commit message on publish: `chore: ingest <season-id> from <key> (<extractor>)`.
- No network in tests: every msw server uses `onUnhandledRequest: 'error'`.
- Code style: ESM imports with `.js` suffix; `import/order` alphabetized with blank lines between groups; no `any`, no non-null assertions (`!`); `consistent-type-imports`. Run `pnpm lint && pnpm typecheck && pnpm test` before every commit.
- Do not bump `zod` (pinned 3.23.8). The Anthropic SDK's Zod helper needs ≥ 3.25, so both LLM extractors use a hand-written JSON schema and validate the reply with our own Zod schema.
- Workflows use `actions/checkout@v7` and `actions/setup-node@v7` (current repo convention).
- Every commit ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An older copy of a season's PDF appears after a newer one was published** (e.g. RSD re-uploads the first BF draft into a new folder). Expected: it's recorded `superseded` and never overwrites the newer list. Test: Task 11, "pending key older than the published copy is superseded".
2. **Artist names made only of punctuation** (the band `!!!`) normalize to an empty string. Expected: grounding falls back to a raw substring check instead of counting them as found everywhere or nowhere. Test: Task 2, "`!!!` is grounded by raw substring".
3. **An LLM reply truncated at the token limit** could still be ≥ 0.6× of last season. Expected: Gemini `finishReason` ≠ `STOP` and Claude `stop_reason: 'max_tokens'` throw instead of returning a partial list. Tests: Task 3 and Task 4.
4. **The same failure repeats every day.** Expected: no duplicate issue and no daily `sources.json` commit churn. Test: Task 11, "repeat failure with same ETag opens no new state commit".
5. **Bucket keys contain spaces** (`2025/RSD Black Friday 2025 l/…`). Expected: download URLs encode each path segment. Test: Task 10, "objectUrl encodes spaces per segment".

---

### Task 1: Extractor contract, shared post-processing, parser refactor

**Files:**
- Create: `scripts/extract/types.ts`
- Create: `scripts/extract/finalize.ts`
- Move: `scripts/parse-pdf.ts` → `scripts/extract/parser.ts` (then edit)
- Create (new thin wrapper): `scripts/parse-pdf.ts`
- Create: `tests/helpers/releases.ts`
- Create: `tests/extract/finalize.test.ts`
- Create: `tests/fixtures/2025-november.pdf` (download)
- Modify: `tests/parse-pdf.test.ts` (append one test)

**Interfaces:**
- Produces:
  - `type ExtractorName = 'parser' | 'gemini' | 'claude'`
  - `ExtractedRowSchema`, `type ExtractedRow = { category: 'E'|'L'|'F'; artist: string; title: string; label: string; format: string }`
  - `ExtractedRowsSchema` (`{ rows: ExtractedRow[] }`)
  - `interface Extractor { name: ExtractorName; extract(pdf: Buffer): Promise<ExtractedRow[]> }`
  - `finalizeRows(rows: ExtractedRow[]): RawRelease[]`, `slugify(input: string): string`
  - `parseRows(pdf: Buffer): Promise<ExtractedRow[]>`, `parserExtractor: Extractor`
  - `parsePdf(pdf: Buffer): Promise<RawRelease[]>` (unchanged signature)
  - Test helpers: `loadRaw(seasonId): Promise<RawRelease[]>`, `toRows(releases: RawRelease[]): ExtractedRow[]`, `makeRelease(i: number, overrides?: Partial<RawRelease>): RawRelease`

- [ ] **Step 1: Download the Black Friday 2025 fixture**

```bash
curl -sf -o tests/fixtures/2025-november.pdf \
  "https://recordstoreday.s3.us-east-1.amazonaws.com/2025/RSD%20Black%20Friday%202025%20l/2025_BLACK_FRIDAY_PUBLIC.pdf"
ls -la tests/fixtures/2025-november.pdf   # expect ~128 KB
```

- [ ] **Step 2: Create the contract**

`scripts/extract/types.ts`:

```ts
import { z } from 'zod'

/** Which extractor produced a candidate list. Recorded in sources.json and commit messages. */
export type ExtractorName = 'parser' | 'gemini' | 'claude'

/**
 * One release row as printed in an RSD list PDF, before ids and category
 * slugs are assigned. Every extractor returns this shape, so post-processing
 * (and therefore release ids) never depends on which extractor ran.
 */
export const ExtractedRowSchema = z
  .object({
    category: z.enum(['E', 'L', 'F']),
    artist: z.string(),
    title: z.string(),
    label: z.string(),
    format: z.string(),
  })
  .strict()
export type ExtractedRow = z.infer<typeof ExtractedRowSchema>

/** Wire shape both LLM extractors are asked to return. */
export const ExtractedRowsSchema = z.object({ rows: z.array(ExtractedRowSchema) }).strict()

export interface Extractor {
  name: ExtractorName
  /** Throws on transport/config failure or malformed output; returns rows otherwise. */
  extract(pdf: Buffer): Promise<ExtractedRow[]>
}
```

- [ ] **Step 3: Write the test helpers**

`tests/helpers/releases.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ExtractedRow } from '../../scripts/extract/types.js'
import type { RawRelease } from '../../scripts/types.js'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const LETTER: Record<string, ExtractedRow['category']> = {
  exclusive: 'E',
  'small-run': 'L',
  'rsd-first': 'F',
}

/** A published season's releases.json, stripped to RawRelease fields. */
export async function loadRaw(seasonId: string): Promise<RawRelease[]> {
  const raw = await readFile(join(REPO_ROOT, 'releases', seasonId, 'releases.json'), 'utf8')
  const list = JSON.parse(raw) as (RawRelease & Record<string, unknown>)[]
  return list.map((r) => ({
    id: r.id,
    artist: r.artist,
    title: r.title,
    label: r.label,
    format: r.format,
    category: r.category,
    description: r.description,
  }))
}

/** Turn releases back into extractor rows (what a perfect extractor would return). */
export function toRows(releases: RawRelease[]): ExtractedRow[] {
  return releases.map((r) => ({
    category: LETTER[r.category] ?? 'E',
    artist: r.artist,
    title: r.title,
    label: r.label,
    format: r.format,
  }))
}

export function makeRelease(i: number, overrides: Partial<RawRelease> = {}): RawRelease {
  return {
    id: `artist-${i}-title-${i}`,
    artist: `Artist ${i}`,
    title: `Title ${i}`,
    label: 'Label',
    format: 'LP',
    category: 'exclusive',
    description: '',
    ...overrides,
  }
}
```

- [ ] **Step 4: Write the failing finalize tests**

`tests/extract/finalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { finalizeRows } from '../../scripts/extract/finalize.js'
import type { ExtractedRow } from '../../scripts/extract/types.js'

const row = (overrides: Partial<ExtractedRow> = {}): ExtractedRow => ({
  category: 'E',
  artist: 'a-ha',
  title: 'Analogue',
  label: 'Rhino',
  format: '2 x LP',
  ...overrides,
})

describe('finalizeRows', () => {
  it('maps E/L/F to category slugs', () => {
    const out = finalizeRows([
      row({ category: 'E', title: 'One' }),
      row({ category: 'L', title: 'Two' }),
      row({ category: 'F', title: 'Three' }),
    ])
    expect(out.map((r) => r.category)).toEqual(['exclusive', 'small-run', 'rsd-first'])
  })

  it('collapses whitespace in every field', () => {
    const [r] = finalizeRows([row({ artist: '  a-ha ', title: 'Analogue\n 20th  Anniversary' })])
    expect(r?.artist).toBe('a-ha')
    expect(r?.title).toBe('Analogue 20th Anniversary')
  })

  it('builds ids from artist + title only', () => {
    const [a] = finalizeRows([row({ label: 'Rhino', format: 'LP' })])
    const [b] = finalizeRows([row({ label: 'Warner', format: 'CD', category: 'F' })])
    expect(a?.id).toBe('a-ha-analogue')
    expect(b?.id).toBe('a-ha-analogue')
  })

  it('dedupes exact tuples and suffixes distinct formats of one title', () => {
    const out = finalizeRows([row(), row(), row({ format: 'CD' })])
    expect(out.map((r) => r.id)).toEqual(['a-ha-analogue', 'a-ha-analogue-2'])
  })

  it('keeps incomplete rows so the gate can reject them', () => {
    const out = finalizeRows([row({ label: '  ' })])
    expect(out).toHaveLength(1)
    expect(out[0]?.label).toBe('')
  })

  it('skips rows whose artist and title slug to nothing', () => {
    expect(finalizeRows([row({ artist: '', title: '…' })])).toEqual([])
  })

  it('sets an empty description', () => {
    expect(finalizeRows([row()])[0]?.description).toBe('')
  })
})
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm vitest run tests/extract/finalize.test.ts`
Expected: FAIL — cannot resolve `../../scripts/extract/finalize.js`.

- [ ] **Step 6: Implement `finalize.ts`**

`scripts/extract/finalize.ts`:

```ts
import type { RawRelease } from '../types.js'

import type { ExtractedRow } from './types.js'

/**
 * RSD uses single-letter category codes in column 1:
 *   E = Exclusive Release
 *   L = Limited Run / Regional Focus Release
 *   F = RSD First Release
 * Emit machine-readable slugs; the iOS app's `Release.Category` enum
 * maps these back to display strings ("Exclusive", "Small Run", "RSD
 * First"). Keeping the wire format as slugs keeps the display copy in
 * the client where it belongs.
 */
const CATEGORY_MAP: Record<ExtractedRow['category'], string> = {
  E: 'exclusive',
  L: 'small-run',
  F: 'rsd-first',
}

/**
 * Slugify a string for use in a release id. Lowercase, alphanumerics
 * separated by single hyphens, trimmed.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/['"`’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Shared post-processing for every extractor's rows: whitespace
 * normalization, category slugs, exact-tuple dedupe and slug ids.
 *
 * Ids depend only on artist + title, so they stay stable across extractor
 * changes and PDF revisions — art slots, user wishlists and
 * wax-wishlist-art-admin all key on them. Duplicate slugs get `-2`, `-3`.
 *
 * Dedup is on the full product tuple (artist + title + format + label +
 * category): byte-identical rows are a PDF/extractor hiccup, while
 * different formats of the same title (Jeff Buckley "Live À L'Olympia" as
 * 2xLP and CD) survive as distinct products.
 *
 * Incomplete rows are kept on purpose: the gate reports them instead of
 * this function silently dropping them.
 */
export function finalizeRows(rows: ExtractedRow[]): RawRelease[] {
  const releases: RawRelease[] = []
  const seenIds = new Map<string, number>()
  const seenTuples = new Set<string>()

  for (const row of rows) {
    const artist = clean(row.artist)
    const title = clean(row.title)
    const label = clean(row.label)
    const format = clean(row.format)
    const category = CATEGORY_MAP[row.category]

    const tupleKey = [artist, title, format, label, category].join('|')
    if (seenTuples.has(tupleKey)) continue
    seenTuples.add(tupleKey)

    const baseSlug = slugify(`${artist} ${title}`)
    if (!baseSlug) continue
    const count = (seenIds.get(baseSlug) ?? 0) + 1
    seenIds.set(baseSlug, count)
    const id = count === 1 ? baseSlug : `${baseSlug}-${count}`

    releases.push({ id, artist, title, label, format, category, description: '' })
  }
  return releases
}
```

- [ ] **Step 7: Run finalize tests**

Run: `pnpm vitest run tests/extract/finalize.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 8: Move the parser and make it return `ExtractedRow[]`**

```bash
git mv scripts/parse-pdf.ts scripts/extract/parser.ts
```

Edit `scripts/extract/parser.ts`:

1. Replace the import line `import { type RawRelease, RawReleaseSchema } from './types.js'` with:

```ts
import type { ExtractedRow, Extractor } from './types.js'
```

2. Replace the whole `CATEGORY_MAP` doc comment + constant with:

```ts
const CATEGORY_CODES = new Set(['E', 'L', 'F'])

function isCategoryCode(s: string): s is ExtractedRow['category'] {
  return CATEGORY_CODES.has(s)
}
```

3. Delete the `interface ParsedRow { … }` block.

4. In `detectColumnGrid`, replace `if (!(cat in CATEGORY_MAP)) continue` with `if (!isCategoryCode(cat)) continue`.

5. Change `extractRowsFromPage`'s signature to return `ExtractedRow[]`, declare `const out: ExtractedRow[] = []`, and replace

```ts
    const cat = first.s.trim()
    const categoryLabel = CATEGORY_MAP[cat]
    if (!categoryLabel) continue
```

with

```ts
    const cat = first.s.trim()
    if (!isCategoryCode(cat)) continue
```

and the final push with `out.push({ category: cat, artist, title, label, format })`.

6. Delete the `slugify` function (it now lives in `finalize.ts`).

7. Replace the entire `parsePdf` function and its doc comment with:

```ts
/**
 * Read release rows from a Record Store Day list PDF by text position.
 *
 * Uses `pdfjs-dist` to read positional text items (X/Y coordinates)
 * instead of stripped text, since the RSD PDF layout has no delimiters
 * between columns — the whitespace between columns is positional.
 *
 * Rows are matched by:
 *   1. A category letter (E/L/F) at the leftmost column.
 *   2. Four non-empty text groups at the artist/title/label/format
 *      column positions.
 *
 * Rows where the label column is empty (usually because the title text
 * overflowed into it) are skipped. Throws when no column grid can be
 * detected, which the cascade records as "parser found no rows".
 */
export async function parseRows(pdfBuffer: Buffer): Promise<ExtractedRow[]> {
  const data = new Uint8Array(pdfBuffer)
  const doc = await getDocument({ data, verbosity: 0 }).promise

  // First pass: collect all fragments and their row groupings across every
  // page so we can detect the column grid from the document's own data.
  const pages: TextFragment[][] = []
  const allRows: TextFragment[][] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const fragments: TextFragment[] = content.items
      .filter((it): it is TextItem => 'str' in it && it.str.trim().length > 0)
      .map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str }))
    pages.push(fragments)
    allRows.push(...groupIntoRows(fragments))
  }

  const grid = detectColumnGrid(allRows)
  if (!grid) {
    throw new Error(
      `Could not detect a 5-column grid from the PDF: fewer than ${MIN_REFERENCE_ROWS} ` +
        `well-formed data rows (E/L/F + 4 fields) were found. The layout may have ` +
        `changed — inspect the PDF's text positions and extend scripts/extract/parser.ts.`,
    )
  }

  return pages.flatMap((fragments) => extractRowsFromPage(fragments, grid))
}

export const parserExtractor: Extractor = { name: 'parser', extract: parseRows }
```

- [ ] **Step 9: Recreate `scripts/parse-pdf.ts` as a wrapper**

```ts
import { finalizeRows } from './extract/finalize.js'
import { parseRows } from './extract/parser.js'
import type { RawRelease } from './types.js'

/**
 * Parse a Record Store Day release list PDF with the positional parser.
 * Kept for existing callers and tests; `ingest` and the watcher go through
 * the extractor cascade in `scripts/extract/`.
 */
export async function parsePdf(pdfBuffer: Buffer): Promise<RawRelease[]> {
  return finalizeRows(await parseRows(pdfBuffer))
}
```

- [ ] **Step 10: Add the Black Friday 2025 parser test**

Append to the `describe` block in `tests/parse-pdf.test.ts` (add `import { loadRaw } from './helpers/releases.js'` to the imports, keeping import order):

```ts
  it('reproduces the published 2025-november list from the Black Friday 2025 PDF', async () => {
    const pdf = await loadFixture('2025-november.pdf')
    const releases = await parsePdf(pdf)
    const published = await loadRaw('2025-november')
    // Verified 2026-09-30: 173 parsed, 173 published, identical id sets.
    expect(new Set(releases.map((r) => r.id))).toEqual(new Set(published.map((r) => r.id)))
  })
```

- [ ] **Step 11: Run the full suite and checks**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all PASS, including every pre-existing `tests/parse-pdf.test.ts` test unchanged.

- [ ] **Step 12: Commit**

```bash
git add scripts/extract scripts/parse-pdf.ts tests/helpers tests/extract tests/parse-pdf.test.ts tests/fixtures/2025-november.pdf
git commit -m "refactor(extract): extractor contract and shared post-processing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: PDF text layer and quality gate

**Files:**
- Create: `scripts/extract/pdf-text.ts`
- Create: `scripts/extract/gate.ts`
- Test: `tests/extract/gate.test.ts`, `tests/extract/pdf-text.test.ts`

**Interfaces:**
- Consumes: `ExtractorName` (Task 1), `RawRelease` (`scripts/types.ts`), test helpers (Task 1).
- Produces:
  - `pdfTextLayer(pdf: Buffer): Promise<string>`
  - `GATE` constants object
  - `interface GateContext { extractor: ExtractorName; pdfText: string; previousSameSeason: RawRelease[] | null; lastComparableCount: number | null }`
  - `interface GateResult { pass: boolean; failures: string[]; report: string }`
  - `checkCandidate(candidate: RawRelease[], ctx: GateContext): GateResult`
  - `normalizeForGrounding(s: string): string`, `groundedFraction(values: string[], pdfText: string): number`
  - `interface ReleaseDiff { added: RawRelease[]; removed: RawRelease[]; changed: { id: string; before: { label: string; format: string }; after: { label: string; format: string } }[] }`, `diffReleases(prev: RawRelease[], next: RawRelease[]): ReleaseDiff`

- [ ] **Step 1: Write the failing gate tests**

`tests/extract/gate.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest'

import {
  checkCandidate,
  diffReleases,
  type GateContext,
  groundedFraction,
  normalizeForGrounding,
} from '../../scripts/extract/gate.js'
import type { RawRelease } from '../../scripts/types.js'
import { loadRaw, makeRelease } from '../helpers/releases.js'

const base: GateContext = {
  extractor: 'parser',
  pdfText: '',
  previousSameSeason: null,
  lastComparableCount: null,
}
const many = (n: number): RawRelease[] => Array.from({ length: n }, (_, i) => makeRelease(i))
const textOf = (rows: RawRelease[]): string =>
  rows.map((r) => `E ${r.artist} ${r.title} ${r.label} ${r.format}`).join('\n')

let november: RawRelease[]
beforeAll(async () => {
  november = await loadRaw('2025-november')
})

describe('checkCandidate — always-on rules', () => {
  it('passes the published 2025-november list as an unchanged revision', () => {
    const r = checkCandidate(november, { ...base, previousSameSeason: november })
    expect(r.failures).toEqual([])
    expect(r.pass).toBe(true)
  })

  it('needs at least 25 rows', () => {
    expect(checkCandidate(many(24), base).pass).toBe(false)
    expect(checkCandidate(many(25), base).pass).toBe(true)
  })

  it('rejects a row with an empty field', () => {
    const rows = many(30)
    rows[3] = makeRelease(3, { label: '' })
    const r = checkCandidate(rows, base)
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/missing artist, title, label or format/)
  })

  it('rejects an unknown category', () => {
    const rows = many(30)
    rows[0] = makeRelease(0, { category: 'Exclusive Release' })
    expect(checkCandidate(rows, base).failures.join(' ')).toMatch(/unknown category/)
  })

  it('rejects duplicate ids', () => {
    const rows = many(30)
    rows[1] = makeRelease(1, { id: rows[0]?.id ?? '' })
    expect(checkCandidate(rows, base).failures.join(' ')).toMatch(/duplicate ids/)
  })
})

describe('checkCandidate — plausible size (new season)', () => {
  const ctx = { ...base, lastComparableCount: 100 }
  it('accepts 0.6× and 1.6× inclusive', () => {
    expect(checkCandidate(many(60), ctx).pass).toBe(true)
    expect(checkCandidate(many(160), ctx).pass).toBe(true)
  })
  it('rejects just outside the band', () => {
    expect(checkCandidate(many(59), ctx).pass).toBe(false)
    expect(checkCandidate(many(161), ctx).pass).toBe(false)
  })
  it('does not apply to revisions', () => {
    const prev = many(30)
    const r = checkCandidate(prev, { ...base, previousSameSeason: prev, lastComparableCount: 1000 })
    expect(r.pass).toBe(true)
  })
})

describe('checkCandidate — bounded revision', () => {
  it('allows removing 15% of previous ids, not more', () => {
    // 25 / 173 = 14.45% removed (and count change 14.45%)
    expect(checkCandidate(november.slice(25), { ...base, previousSameSeason: november }).pass).toBe(true)
    // 26 / 173 = 15.03%
    const r = checkCandidate(november.slice(26), { ...base, previousSameSeason: november })
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/removes 26 of 173/)
  })

  it('allows a count change up to 25%', () => {
    const extra = (n: number) => Array.from({ length: n }, (_, i) => makeRelease(1000 + i))
    // 43 / 173 = 24.86%
    expect(checkCandidate([...november, ...extra(43)], { ...base, previousSameSeason: november }).pass).toBe(true)
    // 44 / 173 = 25.43%
    const r = checkCandidate([...november, ...extra(44)], { ...base, previousSameSeason: november })
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/changes the count from 173 to 217/)
  })

  it('reports added, removed and changed rows', () => {
    const next = november.slice(1).map((r, i) => (i === 0 ? { ...r, format: 'CD' } : r))
    const r = checkCandidate(next, { ...base, previousSameSeason: november })
    expect(r.report).toMatch(/Removed/)
    expect(r.report).toMatch(/Changed/)
  })
})

describe('checkCandidate — grounding (LLM extractors only)', () => {
  it('passes when every artist and title is in the text layer', () => {
    const r = checkCandidate(november, { ...base, extractor: 'gemini', pdfText: textOf(november) })
    expect(r.pass).toBe(true)
  })

  it('passes at 3 fabricated titles of 173 (98.27%) and fails at 4 (97.69%)', () => {
    const text = textOf(november)
    const fake = (n: number) =>
      november.map((r, i) => (i < n ? { ...r, title: `Fabricated Title Number ${i}` } : r))
    expect(checkCandidate(fake(3), { ...base, extractor: 'gemini', pdfText: text }).pass).toBe(true)
    const r = checkCandidate(fake(4), { ...base, extractor: 'claude', pdfText: text })
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/titles appear in the PDF text/)
  })

  it('fails an LLM candidate when the PDF has no text layer', () => {
    const r = checkCandidate(november, { ...base, extractor: 'gemini', pdfText: '  ' })
    expect(r.failures.join(' ')).toMatch(/no text layer/)
  })

  it('skips grounding for the parser', () => {
    expect(checkCandidate(november, { ...base, pdfText: '' }).pass).toBe(true)
  })
})

describe('grounding helpers', () => {
  it('normalizes case, accents, punctuation and whitespace', () => {
    expect(normalizeForGrounding("  Live À L'Olympia — 2xLP ")).toBe('live a l olympia 2xlp')
  })

  it('matches whole words only', () => {
    expect(groundedFraction(['Cure'], 'The Cured')).toBe(0)
    expect(groundedFraction(['Cure'], 'The Cure, Disintegration')).toBe(1)
  })

  it('`!!!` is grounded by raw substring', () => {
    expect(groundedFraction(['!!!'], 'E !!! Louden Up Now Warp LP')).toBe(1)
    expect(groundedFraction(['!!!'], 'E Other Band Warp LP')).toBe(0)
  })
})

describe('diffReleases', () => {
  it('compares by id on label and format', () => {
    const a = [makeRelease(1), makeRelease(2), makeRelease(3)]
    const b = [makeRelease(2, { label: 'New Label' }), makeRelease(3), makeRelease(4)]
    const d = diffReleases(a, b)
    expect(d.added.map((r) => r.id)).toEqual(['artist-4-title-4'])
    expect(d.removed.map((r) => r.id)).toEqual(['artist-1-title-1'])
    expect(d.changed).toEqual([
      {
        id: 'artist-2-title-2',
        before: { label: 'Label', format: 'LP' },
        after: { label: 'New Label', format: 'LP' },
      },
    ])
  })
})
```

`tests/extract/pdf-text.test.ts` (pins the grounding check against real data — measured 100% on 2026-09-30):

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { groundedFraction } from '../../scripts/extract/gate.js'
import { pdfTextLayer } from '../../scripts/extract/pdf-text.js'
import { parsePdf } from '../../scripts/parse-pdf.js'
import { REPO_ROOT } from '../helpers/releases.js'

describe('pdfTextLayer', () => {
  it.each(['2025-april', '2026-april', '2025-november'])(
    'contains ≥98%% of parser artists and titles for %s',
    async (name) => {
      const pdf = await readFile(join(REPO_ROOT, 'tests', 'fixtures', `${name}.pdf`))
      const text = await pdfTextLayer(pdf)
      const rows = await parsePdf(pdf)
      expect(groundedFraction(rows.map((r) => r.artist), text)).toBeGreaterThanOrEqual(0.98)
      expect(groundedFraction(rows.map((r) => r.title), text)).toBeGreaterThanOrEqual(0.98)
    },
  )
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/extract/gate.test.ts tests/extract/pdf-text.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `pdf-text.ts`**

```ts
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'

/**
 * The PDF's text layer as one string (text items joined by spaces). The gate
 * checks LLM output against it so a model can't publish rows the PDF doesn't
 * contain.
 */
export async function pdfTextLayer(pdf: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise
  const parts: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    for (const item of content.items.filter((it): it is TextItem => 'str' in it)) {
      parts.push(item.str)
    }
  }
  return parts.join(' ')
}
```

- [ ] **Step 4: Implement `gate.ts`**

```ts
import type { RawRelease } from '../types.js'

import type { ExtractorName } from './types.js'

/** Thresholds from the design spec; change them there first. */
export const GATE = {
  minRows: 25,
  minRatio: 0.6,
  maxRatio: 1.6,
  maxRemovedFraction: 0.15,
  maxCountChange: 0.25,
  minGrounded: 0.98,
} as const

const VALID_CATEGORIES = new Set(['exclusive', 'small-run', 'rsd-first'])
const DIFF_LIST_LIMIT = 50

export interface GateContext {
  extractor: ExtractorName
  /** pdfjs text layer, for the LLM grounding check. */
  pdfText: string
  /** The season's current releases when this is a revision, else null. */
  previousSameSeason: RawRelease[] | null
  /** Row count of the last season of the same kind (April vs November). */
  lastComparableCount: number | null
}

export interface GateResult {
  pass: boolean
  failures: string[]
  /** Markdown section for the step summary / issue body. */
  report: string
}

export interface ReleaseDiff {
  added: RawRelease[]
  removed: RawRelease[]
  changed: {
    id: string
    before: { label: string; format: string }
    after: { label: string; format: string }
  }[]
}

export function normalizeForGrounding(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Fraction of `values` that appear as whole words in the PDF text. */
export function groundedFraction(values: string[], pdfText: string): number {
  if (values.length === 0) return 1
  const haystack = ` ${normalizeForGrounding(pdfText)} `
  let found = 0
  for (const value of values) {
    const needle = normalizeForGrounding(value)
    // Names made only of punctuation ("!!!") normalize to nothing; check
    // those against the raw text instead.
    const ok = needle
      ? haystack.includes(` ${needle} `)
      : value.trim() !== '' && pdfText.includes(value.trim())
    if (ok) found += 1
  }
  return found / values.length
}

export function diffReleases(prev: RawRelease[], next: RawRelease[]): ReleaseDiff {
  const prevById = new Map(prev.map((r) => [r.id, r]))
  const nextIds = new Set(next.map((r) => r.id))
  const added = next.filter((r) => !prevById.has(r.id))
  const removed = prev.filter((r) => !nextIds.has(r.id))
  const changed: ReleaseDiff['changed'] = []
  for (const r of next) {
    const before = prevById.get(r.id)
    if (before && (before.label !== r.label || before.format !== r.format)) {
      changed.push({
        id: r.id,
        before: { label: before.label, format: before.format },
        after: { label: r.label, format: r.format },
      })
    }
  }
  return { added, removed, changed }
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
const describe = (r: RawRelease): string => `${r.artist || '?'} – ${r.title || '?'}`

function list<T>(items: T[], render: (item: T) => string): string {
  const shown = items.slice(0, DIFF_LIST_LIMIT).map((i) => `- ${render(i)}`)
  if (items.length > DIFF_LIST_LIMIT) shown.push(`- …and ${items.length - DIFF_LIST_LIMIT} more`)
  return shown.join('\n')
}

export function checkCandidate(candidate: RawRelease[], ctx: GateContext): GateResult {
  const failures: string[] = []
  const notes: string[] = []
  const n = candidate.length

  if (n < GATE.minRows) failures.push(`only ${n} rows (minimum ${GATE.minRows})`)

  const incomplete = candidate.filter((r) => !r.artist || !r.title || !r.label || !r.format)
  const firstIncomplete = incomplete[0]
  if (firstIncomplete) {
    failures.push(
      `${incomplete.length} rows missing artist, title, label or format (first: ${describe(firstIncomplete)})`,
    )
  }

  const badCategory = candidate.filter((r) => !VALID_CATEGORIES.has(r.category))
  if (badCategory.length > 0) failures.push(`${badCategory.length} rows with an unknown category`)

  const uniqueIds = new Set(candidate.map((r) => r.id)).size
  if (uniqueIds !== n) failures.push(`${n - uniqueIds} duplicate ids`)

  let diff: ReleaseDiff | null = null
  const prev = ctx.previousSameSeason
  if (prev && prev.length > 0) {
    diff = diffReleases(prev, candidate)
    const removedFraction = diff.removed.length / prev.length
    const countChange = Math.abs(n - prev.length) / prev.length
    notes.push(
      `Revision of ${prev.length} releases: +${diff.added.length} added, −${diff.removed.length} removed, ${diff.changed.length} changed`,
    )
    if (removedFraction > GATE.maxRemovedFraction) {
      failures.push(
        `revision removes ${diff.removed.length} of ${prev.length} releases (${pct(removedFraction)}; limit ${pct(GATE.maxRemovedFraction)})`,
      )
    }
    if (countChange > GATE.maxCountChange) {
      failures.push(
        `revision changes the count from ${prev.length} to ${n} (${pct(countChange)}; limit ${pct(GATE.maxCountChange)})`,
      )
    }
  } else if (ctx.lastComparableCount) {
    const ratio = n / ctx.lastComparableCount
    notes.push(`Last comparable season: ${ctx.lastComparableCount} releases (this list is ${ratio.toFixed(2)}×)`)
    if (ratio < GATE.minRatio || ratio > GATE.maxRatio) {
      failures.push(
        `${n} rows is ${ratio.toFixed(2)}× the last comparable season (${ctx.lastComparableCount}); expected ${GATE.minRatio}–${GATE.maxRatio}×`,
      )
    }
  }

  if (ctx.extractor !== 'parser') {
    if (!ctx.pdfText.trim()) {
      failures.push('PDF has no text layer to check LLM output against')
    } else {
      const artists = groundedFraction(candidate.map((r) => r.artist), ctx.pdfText)
      const titles = groundedFraction(candidate.map((r) => r.title), ctx.pdfText)
      notes.push(`Found in PDF text: artists ${pct(artists)}, titles ${pct(titles)}`)
      if (artists < GATE.minGrounded) {
        failures.push(`only ${pct(artists)} of artists appear in the PDF text (need ${pct(GATE.minGrounded)})`)
      }
      if (titles < GATE.minGrounded) {
        failures.push(`only ${pct(titles)} of titles appear in the PDF text (need ${pct(GATE.minGrounded)})`)
      }
    }
  }

  const pass = failures.length === 0
  const lines = [`#### ${ctx.extractor}: ${pass ? 'PASS' : 'FAIL'} (${n} rows)`, '']
  for (const note of notes) lines.push(`- ${note}`)
  for (const failure of failures) lines.push(`- ❌ ${failure}`)
  if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) {
    lines.push('', '<details><summary>Revision diff</summary>', '')
    if (diff.added.length) lines.push('**Added**', '', list(diff.added, describe), '')
    if (diff.removed.length) lines.push('**Removed**', '', list(diff.removed, describe), '')
    if (diff.changed.length) {
      lines.push(
        '**Changed**',
        '',
        list(
          diff.changed,
          (c) => `${c.id}: ${c.before.label} / ${c.before.format} → ${c.after.label} / ${c.after.format}`,
        ),
        '',
      )
    }
    lines.push('</details>')
  }
  return { pass, failures, report: lines.join('\n') }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/extract`
Expected: PASS.

- [ ] **Step 6: Checks and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add scripts/extract/gate.ts scripts/extract/pdf-text.ts tests/extract/gate.test.ts tests/extract/pdf-text.test.ts
git commit -m "feat(extract): quality gate with grounding and revision checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Shared LLM prompt and the Gemini extractor

**Files:**
- Create: `scripts/extract/prompt.ts`
- Create: `scripts/extract/gemini.ts`
- Test: `tests/extract/gemini.test.ts`

**Interfaces:**
- Consumes: `ExtractedRow`, `ExtractedRowsSchema`, `Extractor` (Task 1).
- Produces:
  - `EXTRACTION_PROMPT: string`, `ROWS_JSON_SCHEMA` (JSON Schema, used by Claude), `GEMINI_ROWS_SCHEMA` (Gemini OpenAPI subset)
  - `parseRowsJson(text: string, source: string): ExtractedRow[]`
  - `GEMINI_MODEL = 'gemini-3.8-flash'`
  - `createGeminiExtractor(opts: { apiKey: string; model?: string; fetchImpl?: typeof fetch }): Extractor`

- [ ] **Step 1: Write the failing tests**

`tests/extract/gemini.test.ts`:

```ts
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

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

const extractor = createGeminiExtractor({ apiKey: 'test-key' })
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/extract/gemini.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `prompt.ts`**

```ts
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
```

- [ ] **Step 4: Implement `gemini.ts`**

```ts
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
  const fetchImpl = opts.fetchImpl ?? fetch
  return {
    name: 'gemini',
    async extract(pdf: Buffer): Promise<ExtractedRow[]> {
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
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/extract/gemini.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Checks and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add scripts/extract/prompt.ts scripts/extract/gemini.ts tests/extract/gemini.test.ts
git commit -m "feat(extract): Gemini Flash extractor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Claude extractor

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (add `@anthropic-ai/sdk`)
- Create: `scripts/extract/claude.ts`
- Test: `tests/extract/claude.test.ts`

**Interfaces:**
- Consumes: `EXTRACTION_PROMPT`, `ROWS_JSON_SCHEMA`, `parseRowsJson` (Task 3); `Extractor` (Task 1).
- Produces: `CLAUDE_MODEL = 'claude-opus-5-5'`, `type ClaudeClient = Pick<Anthropic, 'beta'>`, `createClaudeExtractor(opts: { client?: ClaudeClient; apiKey?: string }): Extractor`

- [ ] **Step 1: Add the SDK**

```bash
pnpm add @anthropic-ai/sdk@^0.131.0
```

(0.131.0 is the latest on 2026-09-30; its beta types include `fallbacks: 'default'` and the `server-side-fallback-2026-07-01` beta.)

- [ ] **Step 2: Write the failing tests**

`tests/extract/claude.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run tests/extract/claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `claude.ts`**

```ts
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
```

If `pnpm typecheck` rejects a field name, read the installed types (`node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts`: `BetaFallbacksParam`, `BetaOutputConfig`, `BetaJSONOutputFormat`, `BetaBase64PDFSource`) and match them; do not cast the params to `any`.

- [ ] **Step 5: Run tests and checks**

Run: `pnpm vitest run tests/extract/claude.test.ts && pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/extract/claude.ts tests/extract/claude.test.ts
git commit -m "feat(extract): optional Claude extractor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Extraction cascade

**Files:**
- Create: `scripts/extract/index.ts`
- Test: `tests/extract/cascade.test.ts`

**Interfaces:**
- Consumes: `Extractor`, `ExtractorName` (Task 1); `finalizeRows` (Task 1); `checkCandidate` (Task 2); `parserExtractor` (Task 1); `createGeminiExtractor` (Task 3); `createClaudeExtractor` (Task 4).
- Produces:
  - `interface ExtractorAttempt { name: ExtractorName; outcome: 'passed' | 'failed-gate' | 'error'; rowCount: number | null; failures: string[]; report: string }`
  - `interface CascadeInput { pdf: Buffer; pdfText: string; extractors: Extractor[]; previousSameSeason: RawRelease[] | null; lastComparableCount: number | null; title: string }`
  - `interface CascadeResult { passed: boolean; extractor: ExtractorName | null; releases: RawRelease[] | null; attempts: ExtractorAttempt[]; parserFoundRows: boolean; llmRan: boolean; report: string }`
  - `runCascade(input: CascadeInput): Promise<CascadeResult>`
  - `defaultExtractors(env?: NodeJS.ProcessEnv): Extractor[]`

- [ ] **Step 1: Write the failing tests**

`tests/extract/cascade.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/extract/cascade.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `index.ts`**

```ts
import type { RawRelease } from '../types.js'

import { createClaudeExtractor } from './claude.js'
import { finalizeRows } from './finalize.js'
import { checkCandidate } from './gate.js'
import { createGeminiExtractor } from './gemini.js'
import { parserExtractor } from './parser.js'
import type { Extractor, ExtractorName } from './types.js'

export interface ExtractorAttempt {
  name: ExtractorName
  outcome: 'passed' | 'failed-gate' | 'error'
  rowCount: number | null
  failures: string[]
  report: string
}

export interface CascadeInput {
  pdf: Buffer
  pdfText: string
  extractors: Extractor[]
  previousSameSeason: RawRelease[] | null
  lastComparableCount: number | null
  /** Heading for the report, e.g. "2026-november from `<key>`". */
  title: string
}

export interface CascadeResult {
  passed: boolean
  extractor: ExtractorName | null
  releases: RawRelease[] | null
  attempts: ExtractorAttempt[]
  /** The parser ran without error and produced at least one row. */
  parserFoundRows: boolean
  /** At least one LLM extractor returned a result (even an empty one). */
  llmRan: boolean
  report: string
}

/** parser always; gemini/claude only when their key is set. */
export function defaultExtractors(env: NodeJS.ProcessEnv = process.env): Extractor[] {
  const extractors: Extractor[] = [parserExtractor]
  const geminiKey = env['GEMINI_API_KEY']
  if (geminiKey) extractors.push(createGeminiExtractor({ apiKey: geminiKey }))
  const anthropicKey = env['ANTHROPIC_API_KEY']
  if (anthropicKey) extractors.push(createClaudeExtractor({ apiKey: anthropicKey }))
  return extractors
}

const cell = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 200)

function render(input: CascadeInput, attempts: ExtractorAttempt[], winner: ExtractorName | null): string {
  const lines = [
    `### ${input.title}`,
    '',
    '| Extractor | Outcome | Rows | Notes |',
    '|---|---|---|---|',
    ...attempts.map(
      (a) => `| ${a.name} | ${a.outcome} | ${a.rowCount ?? '–'} | ${cell(a.failures.join('; '))} |`,
    ),
    '',
    winner ? `**Result:** passed the gate with \`${winner}\`.` : '**Result:** no extractor passed the gate.',
  ]
  for (const a of attempts) if (a.report) lines.push('', a.report)
  return lines.join('\n')
}

/**
 * Run extractors in order and return the first candidate that passes the
 * gate. A thrown error (rate limit, refusal, unset key, malformed output)
 * fails that extractor only; the next one runs.
 */
export async function runCascade(input: CascadeInput): Promise<CascadeResult> {
  const attempts: ExtractorAttempt[] = []
  let winner: { name: ExtractorName; releases: RawRelease[] } | null = null

  for (const extractor of input.extractors) {
    let releases: RawRelease[]
    try {
      releases = finalizeRows(await extractor.extract(input.pdf))
    } catch (err) {
      const message = err instanceof Error ? err.message : JSON.stringify(err)
      attempts.push({ name: extractor.name, outcome: 'error', rowCount: null, failures: [message], report: '' })
      continue
    }
    const gate = checkCandidate(releases, {
      extractor: extractor.name,
      pdfText: input.pdfText,
      previousSameSeason: input.previousSameSeason,
      lastComparableCount: input.lastComparableCount,
    })
    attempts.push({
      name: extractor.name,
      outcome: gate.pass ? 'passed' : 'failed-gate',
      rowCount: releases.length,
      failures: gate.failures,
      report: gate.report,
    })
    if (gate.pass) {
      winner = { name: extractor.name, releases }
      break
    }
  }

  return {
    passed: winner !== null,
    extractor: winner?.name ?? null,
    releases: winner?.releases ?? null,
    attempts,
    parserFoundRows: attempts.some((a) => a.name === 'parser' && a.outcome !== 'error' && (a.rowCount ?? 0) > 0),
    llmRan: attempts.some((a) => a.name !== 'parser' && a.outcome !== 'error'),
    report: render(input, attempts, winner?.name ?? null),
  }
}
```

- [ ] **Step 4: Run tests and checks**

Run: `pnpm vitest run tests/extract && pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/extract/index.ts tests/extract/cascade.test.ts
git commit -m "feat(extract): parser → gemini → claude cascade

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: GitHub issue client

**Files:**
- Create: `scripts/watch/issues.ts`
- Test: `tests/watch/issues.test.ts`

**Interfaces:**
- Produces:
  - `interface IssueClient { ensure(title: string, body: string): Promise<void>; close(title: string, comment: string): Promise<void>; closeByPrefix(prefix: string, comment: string): Promise<void> }`
  - `createGitHubIssueClient(opts: { token: string; repo: string; fetchImpl?: typeof fetch }): IssueClient`
  - `noopIssueClient: IssueClient`
  - `BUCKET_ISSUE_TITLE`, `failureIssueTitle(seasonId: string, etag: string): string`, `seasonIssuePrefix(seasonId: string): string`, `etagShort(etag: string): string`

- [ ] **Step 1: Write the failing tests**

`tests/watch/issues.test.ts`:

```ts
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  createGitHubIssueClient,
  etagShort,
  failureIssueTitle,
  seasonIssuePrefix,
} from '../../scripts/watch/issues.js'

const API = 'https://api.github.com/repos/mrballistic/wax-wishlist-data'
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const client = createGitHubIssueClient({ token: 't', repo: 'mrballistic/wax-wishlist-data' })
const issue = (number: number, title: string, extra: Record<string, unknown> = {}) => ({ number, title, ...extra })

describe('issue titles', () => {
  it('formats the failure title with a short ETag', () => {
    expect(etagShort('"9f1c2ab4ee0011"')).toBe('9f1c2ab4')
    expect(failureIssueTitle('2026-november', '"9f1c2ab4ee0011"')).toBe(
      'watch-rsd: could not publish 2026-november (9f1c2ab4)',
    )
    expect(failureIssueTitle('2026-november', '"x"').startsWith(seasonIssuePrefix('2026-november'))).toBe(true)
  })
})

describe('GitHub issue client', () => {
  it('creates an issue when no open issue has the title', async () => {
    let created: unknown = null
    server.use(
      http.get(`${API}/issues`, () => HttpResponse.json([issue(1, 'something else')])),
      http.post(`${API}/issues`, async ({ request }) => {
        created = await request.json()
        return HttpResponse.json(issue(2, 'x'), { status: 201 })
      }),
    )
    await client.ensure('watch-rsd: bucket unreachable', 'body')
    expect(created).toEqual({ title: 'watch-rsd: bucket unreachable', body: 'body' })
  })

  it('does nothing when an open issue already has the title', async () => {
    server.use(http.get(`${API}/issues`, () => HttpResponse.json([issue(1, 'watch-rsd: bucket unreachable')])))
    await client.ensure('watch-rsd: bucket unreachable', 'body') // a POST would be unhandled → error
  })

  it('ignores pull requests when matching titles', async () => {
    let posted = false
    server.use(
      http.get(`${API}/issues`, () =>
        HttpResponse.json([issue(1, 'watch-rsd: bucket unreachable', { pull_request: {} })]),
      ),
      http.post(`${API}/issues`, () => {
        posted = true
        return HttpResponse.json(issue(2, 'x'), { status: 201 })
      }),
    )
    await client.ensure('watch-rsd: bucket unreachable', 'body')
    expect(posted).toBe(true)
  })

  it('pages through open issues', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 10, `other ${i}`))
    server.use(
      http.get(`${API}/issues`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page')
        return HttpResponse.json(page === '2' ? [issue(500, 'watch-rsd: bucket unreachable')] : page1)
      }),
    )
    await client.ensure('watch-rsd: bucket unreachable', 'body') // found on page 2 → no POST
  })

  it('comments on and closes every issue matching a prefix', async () => {
    const actions: string[] = []
    server.use(
      http.get(`${API}/issues`, () =>
        HttpResponse.json([
          issue(7, 'watch-rsd: could not publish 2026-november (aaaa1111)'),
          issue(8, 'watch-rsd: could not publish 2026-april (bbbb2222)'),
        ]),
      ),
      http.post(`${API}/issues/:n/comments`, ({ params }) => {
        actions.push(`comment ${String(params['n'])}`)
        return HttpResponse.json({}, { status: 201 })
      }),
      http.patch(`${API}/issues/:n`, async ({ params, request }) => {
        actions.push(`close ${String(params['n'])} ${JSON.stringify(await request.json())}`)
        return HttpResponse.json({})
      }),
    )
    await client.closeByPrefix(seasonIssuePrefix('2026-november'), 'Published in abc123.')
    expect(actions).toEqual(['comment 7', 'close 7 {"state":"closed","state_reason":"completed"}'])
  })

  it('truncates very long bodies', async () => {
    let body = ''
    server.use(
      http.get(`${API}/issues`, () => HttpResponse.json([])),
      http.post(`${API}/issues`, async ({ request }) => {
        body = ((await request.json()) as { body: string }).body
        return HttpResponse.json(issue(2, 'x'), { status: 201 })
      }),
    )
    await client.ensure('t', 'x'.repeat(70_000))
    expect(body.length).toBeLessThanOrEqual(60_100)
    expect(body).toContain('truncated')
  })

  it('throws on a GitHub API error', async () => {
    server.use(http.get(`${API}/issues`, () => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 })))
    await expect(client.ensure('t', 'b')).rejects.toThrow(/401/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/watch/issues.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `issues.ts`**

```ts
const API = 'https://api.github.com'
const MAX_BODY = 60_000

export const BUCKET_ISSUE_TITLE = 'watch-rsd: bucket unreachable'

export function etagShort(etag: string): string {
  return etag.replace(/"/g, '').slice(0, 8)
}

export function seasonIssuePrefix(seasonId: string): string {
  return `watch-rsd: could not publish ${seasonId} (`
}

export function failureIssueTitle(seasonId: string, etag: string): string {
  return `${seasonIssuePrefix(seasonId)}${etagShort(etag)})`
}

export interface IssueClient {
  /** Open an issue unless an open one already has this exact title. */
  ensure(title: string, body: string): Promise<void>
  /** Comment on and close open issues with this exact title. */
  close(title: string, comment: string): Promise<void>
  /** Comment on and close open issues whose title starts with `prefix`. */
  closeByPrefix(prefix: string, comment: string): Promise<void>
}

/** For dry runs: no issue side effects. */
export const noopIssueClient: IssueClient = {
  async ensure() {},
  async close() {},
  async closeByPrefix() {},
}

interface OpenIssue {
  number: number
  title: string
  pull_request?: unknown
}

export interface GitHubIssueOptions {
  token: string
  /** owner/name, e.g. GITHUB_REPOSITORY. */
  repo: string
  fetchImpl?: typeof fetch
}

export function createGitHubIssueClient(opts: GitHubIssueOptions): IssueClient {
  const fetchImpl = opts.fetchImpl ?? fetch

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetchImpl(`${API}/repos/${opts.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'wax-wishlist-data/watch-rsd',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
    return res.json()
  }

  async function openIssues(): Promise<OpenIssue[]> {
    const all: OpenIssue[] = []
    for (let page = 1; page <= 20; page++) {
      const batch = (await call('GET', `/issues?state=open&per_page=100&page=${page}`)) as OpenIssue[]
      all.push(...batch.filter((i) => !i.pull_request))
      if (batch.length < 100) break
    }
    return all
  }

  async function closeWhere(match: (title: string) => boolean, comment: string): Promise<void> {
    for (const issue of (await openIssues()).filter((i) => match(i.title))) {
      await call('POST', `/issues/${issue.number}/comments`, { body: comment })
      await call('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' })
    }
  }

  return {
    async ensure(title, body) {
      if ((await openIssues()).some((i) => i.title === title)) return
      const trimmed = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n…(truncated)` : body
      await call('POST', '/issues', { title, body: trimmed })
    },
    close: (title, comment) => closeWhere((t) => t === title, comment),
    closeByPrefix: (prefix, comment) => closeWhere((t) => t.startsWith(prefix), comment),
  }
}
```

- [ ] **Step 4: Run tests and checks**

Run: `pnpm vitest run tests/watch/issues.test.ts && pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/watch/issues.ts tests/watch/issues.test.ts
git commit -m "feat(watch): deduplicated GitHub issue client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Season context and publish step

**Files:**
- Create: `scripts/watch/season-context.ts`
- Create: `scripts/watch/publish.ts`
- Test: `tests/watch/season-context.test.ts`, `tests/watch/publish.test.ts`

**Interfaces:**
- Consumes: `registerSeason(seasonId, date, labelOverride?, repoRoot?, now?)` (`scripts/register-season.ts`), `enrichDiscogs(raw): Promise<Release[]>` (`scripts/enrich-discogs.ts`), `runArtCascade(releases, options)` + `formatCoverageSummary(summary)` (`scripts/fetch-art.ts`), `writeReleases(path, releases)` (`scripts/generate-json.ts`).
- Produces:
  - `seasonKind(seasonId: string): string`
  - `loadReleasesAsRaw(repoRoot: string, seasonId: string): Promise<RawRelease[] | null>`
  - `loadGateContext(repoRoot: string, seasonId: string): Promise<{ previousSameSeason: RawRelease[] | null; lastComparableCount: number | null }>`
  - `interface PublishInput { repoRoot: string; seasonId: string; date: string; label?: string | undefined; releases: RawRelease[] }`
  - `interface PublishDeps { enrich: (releases: RawRelease[]) => Promise<Release[]>; fetchArt: (releases: RawRelease[], seasonId: string, repoRoot: string) => Promise<void>; register: (seasonId: string, date: string, label: string | undefined, repoRoot: string) => Promise<unknown> }`
  - `publishSeason(input: PublishInput, deps?: PublishDeps): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`tests/watch/season-context.test.ts`:

```ts
import { cp, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { loadGateContext, seasonKind } from '../../scripts/watch/season-context.js'
import { REPO_ROOT } from '../helpers/releases.js'

let repo: string
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'wwd-ctx-'))
  await cp(join(REPO_ROOT, 'seasons.json'), join(repo, 'seasons.json'))
  // releases.json only: the art directories are large and irrelevant here.
  for (const season of ['2025-april', '2025-november', '2026-april']) {
    await mkdir(join(repo, 'releases', season), { recursive: true })
    await cp(join(REPO_ROOT, 'releases', season, 'releases.json'), join(repo, 'releases', season, 'releases.json'))
  }
})

describe('seasonKind', () => {
  it('is the part after the year', () => {
    expect(seasonKind('2026-november')).toBe('november')
    expect(seasonKind('2027-april')).toBe('april')
  })
})

describe('loadGateContext', () => {
  it('treats an existing season as a revision', async () => {
    const ctx = await loadGateContext(repo, '2025-november')
    expect(ctx.previousSameSeason).toHaveLength(173)
  })

  it('compares a new season with the latest one of the same kind', async () => {
    expect(await loadGateContext(repo, '2026-november')).toEqual({
      previousSameSeason: null,
      lastComparableCount: 173,
    })
    expect((await loadGateContext(repo, '2027-april')).lastComparableCount).toBe(353)
  })

  it('returns nulls when there is nothing comparable', async () => {
    expect(await loadGateContext(repo, '2027-summer')).toEqual({
      previousSameSeason: null,
      lastComparableCount: null,
    })
  })
})
```

`tests/watch/publish.test.ts`:

```ts
import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerSeason } from '../../scripts/register-season.js'
import type { RawRelease, Release } from '../../scripts/types.js'
import { publishSeason } from '../../scripts/watch/publish.js'
import { makeRelease, REPO_ROOT } from '../helpers/releases.js'

let repo: string
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'wwd-publish-'))
  await cp(join(REPO_ROOT, 'seasons.json'), join(repo, 'seasons.json'))
  await cp(join(REPO_ROOT, 'current.json'), join(repo, 'current.json'))
})

const enrich = async (raw: RawRelease[]): Promise<Release[]> =>
  raw.map((r) => ({ ...r, discogsMasterId: null, artFilename: `${r.id}.jpg` }))

describe('publishSeason', () => {
  it('writes releases, fetches art, and registers the season', async () => {
    const fetchArt = vi.fn(async () => {})
    const releases = [makeRelease(2), makeRelease(1)]
    await publishSeason(
      { repoRoot: repo, seasonId: '2026-november', date: '2026-11-27', releases },
      { enrich, fetchArt, register: (id, date, label, root) => registerSeason(id, date, label, root) },
    )

    const written = JSON.parse(await readFile(join(repo, 'releases/2026-november/releases.json'), 'utf8'))
    expect(written.map((r: Release) => r.id)).toEqual(['artist-1-title-1', 'artist-2-title-2'])
    expect(written[0].artFilename).toBe('artist-1-title-1.jpg')
    expect(fetchArt).toHaveBeenCalledWith(releases, '2026-november', repo)

    const seasons = JSON.parse(await readFile(join(repo, 'seasons.json'), 'utf8'))
    expect(seasons[0]).toMatchObject({ id: '2026-november', date: '2026-11-27', label: 'Black Friday Drop 2026' })
    const current = JSON.parse(await readFile(join(repo, 'current.json'), 'utf8'))
    expect(current.id).toBe('2026-november')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/watch/season-context.test.ts tests/watch/publish.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `season-context.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { type RawRelease, ReleaseListSchema, SeasonsListSchema } from '../types.js'

/** `2026-november` → `november`. "Same kind" means same suffix. */
export function seasonKind(seasonId: string): string {
  return seasonId.split('-').slice(1).join('-')
}

/** A published season's releases as RawRelease, or null if it has none. */
export async function loadReleasesAsRaw(repoRoot: string, seasonId: string): Promise<RawRelease[] | null> {
  let raw: string
  try {
    raw = await readFile(resolve(repoRoot, 'releases', seasonId, 'releases.json'), 'utf8')
  } catch {
    return null
  }
  return ReleaseListSchema.parse(JSON.parse(raw)).map(({ id, artist, title, label, format, category, description }) => ({
    id,
    artist,
    title,
    label,
    format,
    category,
    description,
  }))
}

/**
 * Gate comparisons for a season: its current list (making this a revision)
 * and the size of the latest other season of the same kind.
 */
export async function loadGateContext(
  repoRoot: string,
  seasonId: string,
): Promise<{ previousSameSeason: RawRelease[] | null; lastComparableCount: number | null }> {
  const previousSameSeason = await loadReleasesAsRaw(repoRoot, seasonId)
  const seasons = SeasonsListSchema.parse(JSON.parse(await readFile(resolve(repoRoot, 'seasons.json'), 'utf8')))
  const kind = seasonKind(seasonId)
  const comparable = seasons
    .filter((s) => s.id !== seasonId && seasonKind(s.id) === kind)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  for (const season of comparable) {
    const releases = await loadReleasesAsRaw(repoRoot, season.id)
    if (releases) return { previousSameSeason, lastComparableCount: releases.length }
  }
  return { previousSameSeason, lastComparableCount: null }
}
```

- [ ] **Step 4: Implement `publish.ts`**

```ts
import { resolve } from 'node:path'

import { enrichDiscogs } from '../enrich-discogs.js'
import { formatCoverageSummary, runArtCascade } from '../fetch-art.js'
import { writeReleases } from '../generate-json.js'
import { registerSeason } from '../register-season.js'
import type { RawRelease, Release } from '../types.js'

export interface PublishInput {
  repoRoot: string
  seasonId: string
  date: string
  /** Defaults to the label register-season derives ("Black Friday Drop 2026"). */
  label?: string | undefined
  releases: RawRelease[]
}

export interface PublishDeps {
  enrich: (releases: RawRelease[]) => Promise<Release[]>
  fetchArt: (releases: RawRelease[], seasonId: string, repoRoot: string) => Promise<void>
  register: (seasonId: string, date: string, label: string | undefined, repoRoot: string) => Promise<unknown>
}

async function fetchArt(releases: RawRelease[], seasonId: string, repoRoot: string): Promise<void> {
  const summary = await runArtCascade(releases, {
    artDir: resolve(repoRoot, 'releases', seasonId, 'art'),
    manualArtDir: resolve(repoRoot, 'manual-art'),
    discogsConsumerKey: process.env['DISCOGS_CONSUMER_KEY'],
    discogsConsumerSecret: process.env['DISCOGS_CONSUMER_SECRET'],
    metabrainzAccessToken: process.env['METABRAINZ_ACCESS_TOKEN'],
  })
  console.log(formatCoverageSummary(summary))
}

export const defaultPublishDeps: PublishDeps = {
  enrich: enrichDiscogs,
  fetchArt,
  register: (seasonId, date, label, repoRoot) => registerSeason(seasonId, date, label, repoRoot),
}

/**
 * Publish a gate-passed list: Discogs ids, releases.json, the art cascade
 * (empty slots only), then announce the season in seasons.json/current.json.
 * The caller validates and commits.
 */
export async function publishSeason(input: PublishInput, deps: PublishDeps = defaultPublishDeps): Promise<void> {
  const enriched = await deps.enrich(input.releases)
  await writeReleases(resolve(input.repoRoot, 'releases', input.seasonId, 'releases.json'), enriched)
  await deps.fetchArt(input.releases, input.seasonId, input.repoRoot)
  await deps.register(input.seasonId, input.date, input.label, input.repoRoot)
}
```

- [ ] **Step 5: Run tests and checks**

Run: `pnpm vitest run tests/watch && pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/watch/season-context.ts scripts/watch/publish.ts tests/watch/season-context.test.ts tests/watch/publish.test.ts
git commit -m "feat(watch): gate context and publish step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Switch manual `ingest` onto extract → gate → publish

This is rollout step 1 from the spec: the manual path is held to the same checks before the watcher exists.

**Files:**
- Create: `scripts/watch/summary.ts`
- Create: `scripts/close-season-issues.ts`
- Rewrite: `scripts/ingest.ts`
- Rewrite: `.github/workflows/ingest.yml`

**Interfaces:**
- Consumes: `runCascade`, `defaultExtractors` (Task 5); `pdfTextLayer` (Task 2); `loadGateContext` (Task 7); `publishSeason` (Task 7); `createGitHubIssueClient`, `seasonIssuePrefix` (Task 6).
- Produces: `writeStepSummary(markdown: string): Promise<void>`; CLI `ingest.ts <season-id> <pdfUrl-or-path> <yyyy-mm-dd> [--label=...] [--dry-run]`; CLI `close-season-issues.ts <season-id> <sha>`.

- [ ] **Step 1: Create `summary.ts`**

```ts
import { appendFile } from 'node:fs/promises'

/** Append markdown to the Actions step summary, or print it locally. */
export async function writeStepSummary(markdown: string): Promise<void> {
  const path = process.env['GITHUB_STEP_SUMMARY']
  if (path) await appendFile(path, `${markdown}\n\n`, 'utf8')
  else console.log(markdown)
}
```

- [ ] **Step 2: Rewrite `scripts/ingest.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { defaultExtractors, runCascade } from './extract/index.js'
import { pdfTextLayer } from './extract/pdf-text.js'
import { publishSeason } from './watch/publish.js'
import { loadGateContext } from './watch/season-context.js'
import { writeStepSummary } from './watch/summary.js'

const REPO_ROOT = resolve(process.cwd())
const USAGE =
  'Usage: pnpm tsx scripts/ingest.ts <season-id> <pdfUrl-or-path> <yyyy-mm-dd> [--label="..."] [--dry-run]'

async function fetchPdfBuffer(source: string): Promise<Buffer> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source)
    if (!res.ok) {
      throw new Error(`Failed to fetch PDF (${res.status}) from ${source}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }
  return readFile(resolve(REPO_ROOT, source))
}

interface Args {
  seasonId: string
  pdfSource: string
  date: string
  label: string | undefined
  dryRun: boolean
}

function parseArgs(argv: string[]): Args | null {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const labelArg = argv.find((a) => a.startsWith('--label='))
  const [seasonId, pdfSource, date] = positional
  if (!seasonId || !pdfSource || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return {
    seasonId,
    pdfSource,
    date,
    label: labelArg ? labelArg.slice('--label='.length) || undefined : undefined,
    dryRun: argv.includes('--dry-run'),
  }
}

/**
 * Manual ingest. Same path as the watcher: extractor cascade → quality gate
 * → publish. A list the gate rejects is not written; the job fails with the
 * gate report so a human can look.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error(USAGE)
    process.exit(1)
    return
  }
  const { seasonId, pdfSource, date, label, dryRun } = args

  console.log(`Ingesting season=${seasonId} from ${pdfSource}${dryRun ? ' (dry run)' : ''}`)
  const pdf = await fetchPdfBuffer(pdfSource)
  const pdfText = await pdfTextLayer(pdf).catch(() => '')
  const context = await loadGateContext(REPO_ROOT, seasonId)
  const result = await runCascade({
    pdf,
    pdfText,
    extractors: defaultExtractors(),
    ...context,
    title: `${seasonId} from ${pdfSource}`,
  })
  await writeStepSummary(result.report)

  if (!result.passed || !result.releases) {
    console.error('No extractor produced a list that passes the quality gate. Nothing was written.')
    process.exit(1)
    return
  }
  if (dryRun) {
    console.log(`Dry run: would publish ${result.releases.length} releases (${result.extractor}).`)
    return
  }

  await publishSeason({ repoRoot: REPO_ROOT, seasonId, date, label, releases: result.releases })
  console.log(`Ingest complete: ${result.releases.length} releases via ${result.extractor}.`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 3: Create `scripts/close-season-issues.ts`**

```ts
import { createGitHubIssueClient, seasonIssuePrefix } from './watch/issues.js'

/** After a manual ingest is pushed, close the watcher's open issues for that season. */
async function main(): Promise<void> {
  const [, , seasonId, sha] = process.argv
  const token = process.env['GITHUB_TOKEN']
  const repo = process.env['GITHUB_REPOSITORY']
  if (!seasonId || !sha || !token || !repo) {
    console.error('Usage: GITHUB_TOKEN=… GITHUB_REPOSITORY=… pnpm tsx scripts/close-season-issues.ts <season-id> <sha>')
    process.exit(1)
    return
  }
  const issues = createGitHubIssueClient({ token, repo })
  await issues.closeByPrefix(seasonIssuePrefix(seasonId), `Published by manual \`ingest\` in ${sha}.`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 4: Rewrite `.github/workflows/ingest.yml`**

Inputs move into `env` instead of being interpolated into shell (the old file interpolated `${{ inputs.* }}` directly into `run:`).

```yaml
name: ingest

on:
  workflow_dispatch:
    inputs:
      season-id:
        description: 'Season id (e.g. 2026-april)'
        required: true
        type: string
      pdfUrl:
        description: 'HTTPS URL to the RSD release list PDF'
        required: true
        type: string
      date:
        description: 'Season date (yyyy-MM-dd). Required to auto-register.'
        required: true
        type: string
      label:
        description: 'Human label (optional). Defaults to e.g. "April Drop 2027".'
        required: false
        type: string

jobs:
  ingest:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      # Closes watch-rsd issues for this season after publishing.
      issues: write
    env:
      SEASON_ID: ${{ inputs.season-id }}
      PDF_URL: ${{ inputs.pdfUrl }}
      SEASON_DATE: ${{ inputs.date }}
      SEASON_LABEL: ${{ inputs.label }}
    steps:
      - uses: actions/checkout@v7

      - name: Enable corepack
        run: corepack enable

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: '24'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # Extractor cascade → quality gate → Discogs ids, releases.json, art,
      # register-season. Fails (writing nothing) if the gate rejects the list.
      - name: Ingest season PDF
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          DISCOGS_CONSUMER_KEY: ${{ secrets.DISCOGS_CONSUMER_KEY }}
          DISCOGS_CONSUMER_SECRET: ${{ secrets.DISCOGS_CONSUMER_SECRET }}
          METABRAINZ_ACCESS_TOKEN: ${{ secrets.METABRAINZ_ACCESS_TOKEN }}
        run: |
          if [ -n "$SEASON_LABEL" ]; then
            pnpm tsx scripts/ingest.ts "$SEASON_ID" "$PDF_URL" "$SEASON_DATE" --label="$SEASON_LABEL"
          else
            pnpm tsx scripts/ingest.ts "$SEASON_ID" "$PDF_URL" "$SEASON_DATE"
          fi

      - name: Validate JSON
        run: pnpm tsx scripts/validate.ts

      - name: Commit updates
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add current.json seasons.json releases/
          if git diff --staged --quiet; then
            echo "No changes to commit."
            exit 0
          fi
          git commit -m "chore: ingest $SEASON_ID"
          # Retry a few times to survive concurrent pushes (e.g. someone merging
          # to main while this long-running job was staging art downloads).
          for attempt in 1 2 3 4 5; do
            if git push origin main; then
              exit 0
            fi
            echo "Push rejected (attempt ${attempt}); rebasing onto latest main..."
            git pull --rebase origin main
          done
          echo "Exhausted push retries." >&2
          exit 1

      - name: Close watch-rsd issues for this season
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: pnpm tsx scripts/close-season-issues.ts "$SEASON_ID" "$(git rev-parse HEAD)"
```

- [ ] **Step 5: Verify the manual path end to end (dry run, no network)**

Run: `pnpm tsx scripts/ingest.ts 2025-november tests/fixtures/2025-november.pdf 2025-11-28 --dry-run`
Expected: a report with `| parser | passed | 173 |`, `Revision of 173 releases: +0 added, −0 removed, 0 changed`, then `Dry run: would publish 173 releases (parser).` Exit 0, and `git status` shows no changes under `releases/`.

Run: `actionlint .github/workflows/ingest.yml` (install with `brew install actionlint` if missing)
Expected: no output.

- [ ] **Step 6: Checks and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add scripts/ingest.ts scripts/close-season-issues.ts scripts/watch/summary.ts .github/workflows/ingest.yml
git commit -m "feat(ingest): run manual ingest through the extract cascade and gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: State files: calendar, classification, sources

**Files:**
- Create: `calendar.json`
- Create: `scripts/watch/calendar.ts`, `scripts/watch/classify.ts`, `scripts/watch/sources.ts`
- Modify: `scripts/validate.ts`
- Test: `tests/watch/calendar.test.ts`, `tests/watch/classify.test.ts`, `tests/watch/sources.test.ts`

**Interfaces:**
- Consumes: `BucketObject` type — defined here in `sources.ts` as a structural type and re-used by Task 10 (Task 10 imports it from `sources.ts`).
- Produces:
  - `calendar.ts`: `CalendarSchema`, `type Calendar = Record<string, string>`, `loadCalendar(path: string): Promise<Calendar>`, `blackFridayDate(year: number): string`, `seasonDate(seasonId: string, calendar: Calendar): string | null`
  - `classify.ts`: `COUNTRY_MARKERS`, `type Classification = { kind: 'season'; seasonId: string } | { kind: 'skipped-country' } | { kind: 'ignored' }`, `classifyKey(key: string): Classification`, `hasListSignal(key: string): boolean`
  - `sources.ts`: `interface BucketObject { key: string; etag: string; lastModified: string; size: number }`, `SourceOutcomeSchema`, `type SourceOutcome`, `SourceEntrySchema`, `type SourceEntry`, `SourcesSchema`, `loadSources(path: string): Promise<SourceEntry[]>`, `saveSources(path: string, entries: SourceEntry[]): Promise<void>`, `pendingObjects(objects: BucketObject[], sources: SourceEntry[]): BucketObject[]`, `upsertSource(sources: SourceEntry[], entry: SourceEntry): SourceEntry[]`

- [ ] **Step 1: Create `calendar.json`**

```json
{
  "2025": "2025-04-12",
  "2026": "2026-04-18"
}
```

- [ ] **Step 2: Write the failing tests**

`tests/watch/calendar.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { blackFridayDate, seasonDate } from '../../scripts/watch/calendar.js'

describe('calendar', () => {
  it('puts Black Friday the day after the fourth Thursday of November', () => {
    expect(blackFridayDate(2025)).toBe('2025-11-28')
    expect(blackFridayDate(2026)).toBe('2026-11-27')
    expect(blackFridayDate(2027)).toBe('2027-11-26')
  })

  it('resolves season dates', () => {
    const cal = { '2026': '2026-04-18' }
    expect(seasonDate('2026-november', cal)).toBe('2026-11-27')
    expect(seasonDate('2026-april', cal)).toBe('2026-04-18')
    expect(seasonDate('2027-april', cal)).toBeNull()
    expect(seasonDate('2027-summer', cal)).toBeNull()
  })
})
```

`tests/watch/classify.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { classifyKey, hasListSignal } from '../../scripts/watch/classify.js'

describe('classifyKey', () => {
  it.each([
    ['2025/RSD_2025_Italia/2025_RSD_PUBLIC_PDF_Italia.pdf', { kind: 'skipped-country' }],
    ['2025/RSD 2025 List Links/2025_RSD_PUBLICX354A.pdf', { kind: 'season', seasonId: '2025-april' }],
    ['2025/RSD 2025 List Links/2025_BLACK_FRIDAY_PUBLIC.pdf', { kind: 'season', seasonId: '2025-november' }],
    ['2025/RSD Black Friday 2025 l/2025_BLACK_FRIDAY_PUBLIC.pdf', { kind: 'season', seasonId: '2025-november' }],
    ['2026/RSD 2026_v2/RSD26_PDF_4-3.pdf', { kind: 'season', seasonId: '2026-april' }],
    ['2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf', { kind: 'season', seasonId: '2026-april' }],
    ['2026/Black Friday/RSD Black Friday List.pdf', { kind: 'season', seasonId: '2026-november' }],
    ['2025/Stock/RSD ORDERABLE STOCK AS OF 4-17.xlsx', { kind: 'ignored' }],
    ['2025/Forms/pledge.doc', { kind: 'ignored' }],
    ['2026/Logos/rsd_stacked_2026.zip', { kind: 'ignored' }],
    ['2026/Logos/', { kind: 'ignored' }],
  ])('%s', (key, expected) => {
    expect(classifyKey(key)).toEqual(expected)
  })
})

describe('hasListSignal', () => {
  it('looks only at the file name', () => {
    expect(hasListSignal('2025/RSD 2025 List Links/2025_RSD_PUBLICX354A.pdf')).toBe(true)
    expect(hasListSignal('2025/RSD 2025 List Links/2025_BLACK_FRIDAY_PUBLIC.pdf')).toBe(true)
    expect(hasListSignal('2026/RSD 2026 List Links/RSD26_PDF_4-3.pdf')).toBe(false)
    expect(hasListSignal('2026/x/RSD Black Friday List.pdf')).toBe(true)
  })
})
```

`tests/watch/sources.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  type BucketObject,
  loadSources,
  pendingObjects,
  saveSources,
  type SourceEntry,
  upsertSource,
} from '../../scripts/watch/sources.js'

const obj = (key: string, etag: string): BucketObject => ({
  key,
  etag,
  lastModified: '2026-10-01T00:00:00.000Z',
  size: 1,
})
const entry = (key: string, etag: string, outcome: SourceEntry['outcome']): SourceEntry => ({
  key,
  etag,
  lastModified: '2026-09-01T00:00:00.000Z',
  seasonId: '2026-april',
  outcome,
  extractor: null,
  processedAt: '2026-09-01T00:00:00.000Z',
})

describe('sources', () => {
  it('treats a missing file as empty', async () => {
    expect(await loadSources(join(tmpdir(), 'does-not-exist', 'sources.json'))).toEqual([])
  })

  it('round-trips sorted by key and validates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wwd-sources-'))
    const path = join(dir, 'sources.json')
    await saveSources(path, [entry('b', '"2"', 'published'), entry('a', '"1"', 'superseded')])
    expect((await loadSources(path)).map((e) => e.key)).toEqual(['a', 'b'])
    expect(await readFile(path, 'utf8')).toMatch(/\n$/)
  })

  it('marks new, changed and failed keys pending', () => {
    const sources = [
      entry('same', '"1"', 'published'),
      entry('changed', '"1"', 'published'),
      entry('failed', '"1"', 'failed'),
    ]
    const pending = pendingObjects(
      [obj('same', '"1"'), obj('changed', '"2"'), obj('failed', '"1"'), obj('new', '"1"')],
      sources,
    )
    expect(pending.map((o) => o.key)).toEqual(['changed', 'failed', 'new'])
  })

  it('upserts by key', () => {
    const next = upsertSource([entry('a', '"1"', 'failed')], entry('a', '"2"', 'published'))
    expect(next).toHaveLength(1)
    expect(next[0]?.outcome).toBe('published')
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run tests/watch/calendar.test.ts tests/watch/classify.test.ts tests/watch/sources.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `calendar.ts`**

```ts
import { readFile } from 'node:fs/promises'

import { z } from 'zod'

/** Hand-maintained April RSD dates by year; RSD announces them months ahead. */
export const CalendarSchema = z.record(z.string().regex(/^\d{4}$/), z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
export type Calendar = z.infer<typeof CalendarSchema>

export async function loadCalendar(path: string): Promise<Calendar> {
  return CalendarSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

/** The day after the fourth Thursday of November (UTC date math). */
export function blackFridayDate(year: number): string {
  const novFirstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay()
  const firstThursday = 1 + ((4 - novFirstDow + 7) % 7)
  const day = firstThursday + 21 + 1
  return `${year}-11-${String(day).padStart(2, '0')}`
}

/** Event date for `<year>-april` / `<year>-november`; null when unknown. */
export function seasonDate(seasonId: string, calendar: Calendar): string | null {
  const m = /^(\d{4})-(april|november)$/.exec(seasonId)
  if (!m) return null
  const [, year, kind] = m
  if (!year) return null
  if (kind === 'november') return blackFridayDate(Number(year))
  return calendar[year] ?? null
}
```

- [ ] **Step 5: Implement `classify.ts`**

```ts
/** Country-specific lists live in the same bucket; skip them. Extend as RSD adds more. */
export const COUNTRY_MARKERS = ['Italia'] as const

const LIST_SIGNAL_RE = /PUBLIC|LIST|BLACK[_ ]FRIDAY/i
const BLACK_FRIDAY_RE = /BLACK[_ ]FRIDAY/i

export type Classification =
  | { kind: 'season'; seasonId: string }
  | { kind: 'skipped-country' }
  | { kind: 'ignored' }

function basename(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1)
}

/** True when the file name itself looks like a release list. */
export function hasListSignal(key: string): boolean {
  return LIST_SIGNAL_RE.test(basename(key))
}

/**
 * Map a bucket key to a season. File names aren't a stable signal, so this
 * is deliberately coarse: Black Friday by name, everything else under a year
 * is a candidate April list. The cascade + gate decide whether it really is
 * one. The year comes from the file name, falling back to the prefix.
 */
export function classifyKey(key: string): Classification {
  const name = basename(key)
  if (!name.toLowerCase().endsWith('.pdf')) return { kind: 'ignored' }
  if (COUNTRY_MARKERS.some((m) => key.toLowerCase().includes(m.toLowerCase()))) {
    return { kind: 'skipped-country' }
  }
  const year = /(20\d{2})/.exec(name)?.[1] ?? /^(\d{4})\//.exec(key)?.[1]
  if (!year) return { kind: 'ignored' }
  const kind = BLACK_FRIDAY_RE.test(key) ? 'november' : 'april'
  return { kind: 'season', seasonId: `${year}-${kind}` }
}
```

- [ ] **Step 6: Implement `sources.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

/** One object from the RSD bucket listing. `etag` keeps S3's quotes. */
export interface BucketObject {
  key: string
  etag: string
  lastModified: string
  size: number
}

export const SourceOutcomeSchema = z.enum(['published', 'not-a-list', 'skipped-country', 'superseded', 'failed'])
export type SourceOutcome = z.infer<typeof SourceOutcomeSchema>

export const SourceEntrySchema = z
  .object({
    key: z.string().min(1),
    etag: z.string().min(1),
    lastModified: z.string().datetime(),
    seasonId: z.string().min(1).nullable(),
    outcome: SourceOutcomeSchema,
    extractor: z.enum(['parser', 'gemini', 'claude']).nullable(),
    processedAt: z.string().datetime(),
  })
  .strict()
export type SourceEntry = z.infer<typeof SourceEntrySchema>

export const SourcesSchema = z.array(SourceEntrySchema)

/** Missing file → no history. */
export async function loadSources(path: string): Promise<SourceEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  return SourcesSchema.parse(JSON.parse(raw))
}

export async function saveSources(path: string, entries: SourceEntry[]): Promise<void> {
  const sorted = SourcesSchema.parse([...entries].sort((a, b) => a.key.localeCompare(b.key)))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
}

/** New keys, changed ETags, and keys whose last outcome was `failed` (retried daily). */
export function pendingObjects(objects: BucketObject[], sources: SourceEntry[]): BucketObject[] {
  const byKey = new Map(sources.map((s) => [s.key, s]))
  return objects.filter((o) => {
    const seen = byKey.get(o.key)
    return !seen || seen.etag !== o.etag || seen.outcome === 'failed'
  })
}

export function upsertSource(sources: SourceEntry[], entry: SourceEntry): SourceEntry[] {
  return [...sources.filter((s) => s.key !== entry.key), entry]
}
```

- [ ] **Step 7: Validate both files in `scripts/validate.ts`**

Add imports (keep `import/order`; `zod` goes in the external group after the node builtins):

```ts
import type { ZodTypeAny } from 'zod'

import { CalendarSchema } from './watch/calendar.js'
import { SourcesSchema } from './watch/sources.js'
```

Add after `SEASONS_PATH`:

```ts
const SOURCES_PATH = resolve(REPO_ROOT, 'sources.json')
const CALENDAR_PATH = resolve(REPO_ROOT, 'calendar.json')
```

Add this function after `validateSeasons`:

```ts
/** Watcher state files: validated when present (sources.json is seeded in a later step). */
async function validateOptional(path: string, schema: ZodTypeAny): Promise<Problem[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  try {
    const result = schema.safeParse(JSON.parse(raw))
    return result.success ? [] : [{ path, message: result.error.toString() }]
  } catch (err) {
    return [{ path, message: `${(err as Error).message}` }]
  }
}
```

and extend `problems` in `main()`:

```ts
  const problems = [
    ...(await validateCurrent()),
    ...(await validateSeasons()),
    ...(await validateOptional(SOURCES_PATH, SourcesSchema)),
    ...(await validateOptional(CALENDAR_PATH, CalendarSchema)),
    ...(await validateReleases()),
  ]
```

- [ ] **Step 8: Run tests and checks**

Run: `pnpm vitest run tests/watch && pnpm validate && pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS; `pnpm validate` prints `All JSON files validated against Zod schemas.`

- [ ] **Step 9: Commit**

```bash
git add calendar.json scripts/watch/calendar.ts scripts/watch/classify.ts scripts/watch/sources.ts scripts/validate.ts tests/watch/calendar.test.ts tests/watch/classify.test.ts tests/watch/sources.test.ts
git commit -m "feat(watch): calendar, key classification and sources state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: RSD bucket client

**Files:**
- Create: `tests/fixtures/bucket/list-2026.xml` (recorded)
- Create: `scripts/watch/bucket.ts`
- Test: `tests/watch/bucket.test.ts`

**Interfaces:**
- Consumes: `BucketObject` (Task 9, `scripts/watch/sources.ts`).
- Produces: `BUCKET_URL`, `class BucketError extends Error`, `parseListing(xml: string): { objects: BucketObject[]; isTruncated: boolean; nextToken: string | null }`, `listPdfs(prefix: string, fetchImpl?: typeof fetch): Promise<BucketObject[]>`, `prefixesFor(now: Date): string[]`, `objectUrl(key: string): string`, `fetchPdf(key: string, fetchImpl?: typeof fetch): Promise<Buffer>`

- [ ] **Step 1: Record the real listing**

```bash
mkdir -p tests/fixtures/bucket
curl -sf "https://recordstoreday.s3.us-east-1.amazonaws.com/?list-type=2&prefix=2026/" -o tests/fixtures/bucket/list-2026.xml
grep -o '<Key>[^<]*\.pdf</Key>' tests/fixtures/bucket/list-2026.xml
# expect exactly:
# <Key>2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf</Key>
# <Key>2026/RSD 2026_v2/RSD26_PDF_4-3.pdf</Key>
```

If the PDF keys differ (RSD changed the bucket since 2026-09-30), update the expected keys in Step 2's first test to match the recording.

- [ ] **Step 2: Write the failing tests**

`tests/watch/bucket.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { BucketError, BUCKET_URL, listPdfs, objectUrl, prefixesFor } from '../../scripts/watch/bucket.js'
import { REPO_ROOT } from '../helpers/releases.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const contents = (key: string, etag: string) =>
  `<Contents><Key>${key}</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>&quot;${etag}&quot;</ETag><Size>10</Size></Contents>`
const page = (body: string, next: string | null) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}${body}</ListBucketResult>`
const xml = (body: string) => new HttpResponse(body, { headers: { 'content-type': 'application/xml' } })

describe('listPdfs', () => {
  it('parses the recorded 2026 listing down to its PDFs', async () => {
    const recorded = await readFile(join(REPO_ROOT, 'tests/fixtures/bucket/list-2026.xml'), 'utf8')
    server.use(http.get(BUCKET_URL, () => xml(recorded)))
    const pdfs = await listPdfs('2026/')
    expect(pdfs.map((p) => p.key).sort()).toEqual([
      '2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf',
      '2026/RSD 2026_v2/RSD26_PDF_4-3.pdf',
    ])
    expect(pdfs[0]?.etag).toMatch(/^"[0-9a-f-]+"$/) // multipart uploads add a -N suffix
    expect(pdfs[0]?.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('follows continuation tokens', async () => {
    const seen: (string | null)[] = []
    server.use(
      http.get(BUCKET_URL, ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('list-type')).toBe('2')
        expect(url.searchParams.get('prefix')).toBe('2025/')
        const token = url.searchParams.get('continuation-token')
        seen.push(token)
        return token === 'abc/+='
          ? xml(page(contents('2025/b.pdf', 'bbb'), null))
          : xml(page(contents('2025/a.pdf', 'aaa') + contents('2025/x.xlsx', 'xxx'), 'abc/+='))
      }),
    )
    const pdfs = await listPdfs('2025/')
    expect(pdfs.map((p) => p.key)).toEqual(['2025/a.pdf', '2025/b.pdf'])
    expect(seen).toEqual([null, 'abc/+='])
  })

  it('throws BucketError on 403', async () => {
    server.use(http.get(BUCKET_URL, () => new HttpResponse('<Error>AccessDenied</Error>', { status: 403 })))
    await expect(listPdfs('2026/')).rejects.toBeInstanceOf(BucketError)
  })

  it('throws BucketError on malformed XML', async () => {
    server.use(http.get(BUCKET_URL, () => xml('<html>maintenance</html>')))
    await expect(listPdfs('2026/')).rejects.toThrow(/malformed/)
  })

  it('throws BucketError on a network error', async () => {
    server.use(http.get(BUCKET_URL, () => HttpResponse.error()))
    await expect(listPdfs('2026/')).rejects.toBeInstanceOf(BucketError)
  })
})

describe('prefixesFor', () => {
  it('adds next year from September 1 (UTC)', () => {
    expect(prefixesFor(new Date('2026-08-31T23:59:59Z'))).toEqual(['2026/'])
    expect(prefixesFor(new Date('2026-09-01T00:00:00Z'))).toEqual(['2026/', '2027/'])
  })
})

describe('objectUrl', () => {
  it('objectUrl encodes spaces per segment', () => {
    expect(objectUrl('2025/RSD Black Friday 2025 l/2025_BLACK_FRIDAY_PUBLIC.pdf')).toBe(
      'https://recordstoreday.s3.us-east-1.amazonaws.com/2025/RSD%20Black%20Friday%202025%20l/2025_BLACK_FRIDAY_PUBLIC.pdf',
    )
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run tests/watch/bucket.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `bucket.ts`**

```ts
import type { BucketObject } from './sources.js'

/** RSD's public bucket. Anonymous ListObjectsV2 works as of 2026-09-30. */
export const BUCKET_URL = 'https://recordstoreday.s3.us-east-1.amazonaws.com/'

const TIMEOUT_MS = 60_000
const MAX_PAGES = 50

export class BucketError extends Error {
  override name = 'BucketError'
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)
  return m?.[1] !== undefined ? decodeXml(m[1]) : null
}

/** Parse one ListObjectsV2 page. Small, fixed schema, so no XML dependency. */
export function parseListing(xml: string): {
  objects: BucketObject[]
  isTruncated: boolean
  nextToken: string | null
} {
  if (!xml.includes('<ListBucketResult')) throw new BucketError('malformed listing: no ListBucketResult')
  const objects: BucketObject[] = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1] ?? ''
    const key = tag(block, 'Key')
    const etag = tag(block, 'ETag')
    const lastModified = tag(block, 'LastModified')
    if (!key || !etag || !lastModified) throw new BucketError('malformed listing: incomplete Contents entry')
    objects.push({ key, etag, lastModified, size: Number(tag(block, 'Size') ?? 0) })
  }
  return { objects, isTruncated: tag(xml, 'IsTruncated') === 'true', nextToken: tag(xml, 'NextContinuationToken') }
}

/** Every `.pdf` key under `prefix`, following pagination. */
export async function listPdfs(prefix: string, fetchImpl: typeof fetch = fetch): Promise<BucketObject[]> {
  const pdfs: BucketObject[] = []
  let token: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(BUCKET_URL)
    url.searchParams.set('list-type', '2')
    url.searchParams.set('prefix', prefix)
    if (token) url.searchParams.set('continuation-token', token)

    let res: Response
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      throw new BucketError(`network error listing ${prefix}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new BucketError(`HTTP ${res.status} listing ${prefix}`)

    const page = parseListing(await res.text())
    pdfs.push(...page.objects.filter((o) => o.key.toLowerCase().endsWith('.pdf')))
    if (!page.isTruncated) return pdfs
    if (!page.nextToken) throw new BucketError('malformed listing: truncated without a continuation token')
    token = page.nextToken
  }
  throw new BucketError(`listing ${prefix} exceeded ${MAX_PAGES} pages`)
}

/** Current year, plus next year from September 1 (the 2026/ prefix appeared 2025-09-15). */
export function prefixesFor(now: Date): string[] {
  const year = now.getUTCFullYear()
  return now.getUTCMonth() >= 8 ? [`${year}/`, `${year + 1}/`] : [`${year}/`]
}

export function objectUrl(key: string): string {
  return BUCKET_URL + key.split('/').map(encodeURIComponent).join('/')
}

export async function fetchPdf(key: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchImpl(objectUrl(key), { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${key}`)
  return Buffer.from(await res.arrayBuffer())
}
```

- [ ] **Step 5: Run tests and checks**

Run: `pnpm vitest run tests/watch/bucket.test.ts && pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/watch/bucket.ts tests/watch/bucket.test.ts tests/fixtures/bucket
git commit -m "feat(watch): RSD bucket listing client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Git operations and the watcher orchestrator

**Files:**
- Create: `scripts/watch/git.ts`
- Create: `scripts/watch/run.ts`
- Test: `tests/watch/git.test.ts`, `tests/watch/run.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 5–10: `runCascade`; `Extractor`, `ExtractorName`; `pdfTextLayer`; `BucketObject`, `loadSources`, `saveSources`, `pendingObjects`, `upsertSource`, `SourceOutcome`; `classifyKey`, `hasListSignal`; `loadCalendar`, `seasonDate`; `prefixesFor`; `IssueClient`, `BUCKET_ISSUE_TITLE`, `failureIssueTitle`, `seasonIssuePrefix`; `PublishInput`; `loadGateContext`.
- Produces:
  - `git.ts`: `type Runner = (cmd: string, args: string[]) => { status: number; stdout: string }`, `interface GitOps { commitAndPush(message: string, paths: string[]): Promise<string | null> }`, `createGitOps(repoRoot: string, run?: Runner): GitOps`
  - `run.ts`: `interface WatchDeps`, `interface WatchOptions { repoRoot: string; sourcesPath: string; dryRun: boolean; only?: ExtractorName | undefined; prefixes?: string[] | undefined }`, `interface WatchOutcome { key: string; seasonId: string | null; outcome: SourceOutcome; extractor: ExtractorName | null }`, `runWatch(opts: WatchOptions, deps: WatchDeps): Promise<WatchOutcome[]>`

- [ ] **Step 1: Write the failing git tests**

`tests/watch/git.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createGitOps, type Runner } from '../../scripts/watch/git.js'

/** Scripted runner: returns the first matching status for a command prefix. */
function scripted(rules: [string, number[]][]): { run: Runner; calls: string[] } {
  const calls: string[] = []
  const queues = new Map(rules.map(([prefix, statuses]) => [prefix, [...statuses]]))
  const run: Runner = (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    for (const [prefix, queue] of queues) {
      if (line.startsWith(prefix)) {
        const status = queue.length > 1 ? (queue.shift() ?? 0) : (queue[0] ?? 0)
        return { status, stdout: prefix === 'git rev-parse' ? 'abc1234\n' : '' }
      }
    }
    return { status: 0, stdout: '' }
  }
  return { run, calls }
}

describe('commitAndPush', () => {
  it('returns null without committing when nothing is staged', async () => {
    const { run, calls } = scripted([['git diff --staged --quiet', [0]]])
    expect(await createGitOps('/repo', run).commitAndPush('msg', ['sources.json'])).toBeNull()
    expect(calls.some((c) => c.startsWith('git commit'))).toBe(false)
  })

  it('validates, commits, rebases on a rejected push, and returns the sha', async () => {
    const { run, calls } = scripted([
      ['git diff --staged --quiet', [1]],
      ['git push', [1, 0]],
    ])
    expect(await createGitOps('/repo', run).commitAndPush('chore: x', ['a', 'b'])).toBe('abc1234')
    expect(calls).toEqual([
      'pnpm -s tsx scripts/validate.ts',
      'git add -- a b',
      'git diff --staged --quiet',
      'git commit -m chore: x',
      'git push origin HEAD:main',
      'git pull --rebase origin main',
      'git push origin HEAD:main',
      'git rev-parse HEAD',
    ])
  })

  it('stops before staging when validation fails', async () => {
    const { run, calls } = scripted([['pnpm -s tsx scripts/validate.ts', [1]]])
    await expect(createGitOps('/repo', run).commitAndPush('m', ['a'])).rejects.toThrow(/validate/)
    expect(calls).toEqual(['pnpm -s tsx scripts/validate.ts'])
  })

  it('gives up after five rejected pushes', async () => {
    const { run } = scripted([
      ['git diff --staged --quiet', [1]],
      ['git push', [1]],
    ])
    await expect(createGitOps('/repo', run).commitAndPush('m', ['a'])).rejects.toThrow(/push retries/)
  })
})
```

- [ ] **Step 2: Implement `git.ts`**

```ts
import { spawnSync } from 'node:child_process'

export type Runner = (cmd: string, args: string[]) => { status: number; stdout: string }

export interface GitOps {
  /** Validate, stage `paths`, commit, push with rebase retries. Returns the sha, or null if nothing changed. */
  commitAndPush(message: string, paths: string[]): Promise<string | null>
}

const PUSH_ATTEMPTS = 5

function defaultRunner(repoRoot: string): Runner {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    return { status: r.status ?? 1, stdout: r.stdout ?? '' }
  }
}

export function createGitOps(repoRoot: string, run: Runner = defaultRunner(repoRoot)): GitOps {
  const must = (cmd: string, args: string[], what: string): string => {
    const r = run(cmd, args)
    if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status})`)
    return r.stdout
  }
  return {
    async commitAndPush(message, paths) {
      must('pnpm', ['-s', 'tsx', 'scripts/validate.ts'], 'validate')
      must('git', ['add', '--', ...paths], 'git add')
      if (run('git', ['diff', '--staged', '--quiet']).status === 0) return null
      must('git', ['commit', '-m', message], 'git commit')
      // Same retry loop as the ingest/refresh-art workflows: survive
      // concurrent pushes (art-admin commits, auto-status).
      for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
        if (run('git', ['push', 'origin', 'HEAD:main']).status === 0) {
          return must('git', ['rev-parse', 'HEAD'], 'git rev-parse').trim()
        }
        if (attempt < PUSH_ATTEMPTS) must('git', ['pull', '--rebase', 'origin', 'main'], 'git pull --rebase')
      }
      throw new Error('Exhausted push retries')
    },
  }
}
```

Note the expected call list in the second test: a rejected push is followed by one `pull --rebase`; the final failed attempt does not rebase.

- [ ] **Step 3: Run git tests**

Run: `pnpm vitest run tests/watch/git.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing watcher tests**

`tests/watch/run.test.ts`:

```ts
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExtractedRow, Extractor, ExtractorName } from '../../scripts/extract/types.js'
import { BucketError } from '../../scripts/watch/bucket.js'
import type { IssueClient } from '../../scripts/watch/issues.js'
import { runWatch, type WatchDeps } from '../../scripts/watch/run.js'
import type { BucketObject, SourceEntry } from '../../scripts/watch/sources.js'
import { loadRaw, REPO_ROOT, toRows } from '../helpers/releases.js'

const NOW = new Date('2026-10-29T13:30:00Z') // lists 2026/ and 2027/
const APRIL_KEY = '2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf'
const BF_KEY = '2026/RSD Black Friday 2026/2026_BLACK_FRIDAY_PUBLIC.pdf'

const obj = (key: string, etag: string, lastModified: string): BucketObject => ({ key, etag, lastModified, size: 1 })
const APRIL = obj(APRIL_KEY, '"a0a0a0a0"', '2026-04-16T00:00:00.000Z')
const BF = obj(BF_KEY, '"bf26bf26"', '2026-10-28T15:00:00.000Z')

let novemberRows: ExtractedRow[]
let aprilRows: ExtractedRow[]
beforeAll(async () => {
  novemberRows = toRows(await loadRaw('2025-november'))
  aprilRows = toRows(await loadRaw('2026-april'))
})

let repo: string
let sourcesPath: string
const seeded: SourceEntry[] = [
  {
    key: APRIL_KEY,
    etag: APRIL.etag,
    lastModified: APRIL.lastModified,
    seasonId: '2026-april',
    outcome: 'published',
    extractor: 'parser',
    processedAt: '2026-10-01T00:00:00.000Z',
  },
]

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'wwd-watch-'))
  for (const f of ['seasons.json', 'current.json', 'calendar.json']) await cp(join(REPO_ROOT, f), join(repo, f))
  for (const season of ['2025-november', '2026-april']) {
    await mkdir(join(repo, 'releases', season), { recursive: true })
    await cp(join(REPO_ROOT, 'releases', season, 'releases.json'), join(repo, 'releases', season, 'releases.json'))
  }
  sourcesPath = join(repo, 'sources.json')
  await writeFile(sourcesPath, `${JSON.stringify(seeded, null, 2)}\n`)
})

const extractor = (name: ExtractorName, impl: () => Promise<ExtractedRow[]>): Extractor => ({
  name,
  extract: vi.fn(impl),
})

function deps(listing: BucketObject[], extractors: Extractor[], overrides: Partial<WatchDeps> = {}) {
  const issues: IssueClient = {
    ensure: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeByPrefix: vi.fn(async () => {}),
  }
  const d: WatchDeps = {
    now: () => NOW,
    listBucket: vi.fn(async (prefix: string) => listing.filter((o) => o.key.startsWith(prefix))),
    fetchPdf: vi.fn(async () => Buffer.from('%PDF fake')),
    pdfText: async () => '',
    extractors,
    publish: vi.fn(async () => {}),
    issues,
    git: { commitAndPush: vi.fn(async () => 'abc1234') },
    summary: vi.fn(async () => {}),
    log: () => {},
    ...overrides,
  }
  return d
}
const opts = (dryRun = false) => ({ repoRoot: repo, sourcesPath, dryRun })
const sourcesOnDisk = async (): Promise<SourceEntry[]> => JSON.parse(await readFile(sourcesPath, 'utf8'))

describe('runWatch', () => {
  it('publishes a new Black Friday list', async () => {
    const d = deps([APRIL, BF], [extractor('parser', async () => novemberRows)])
    const out = await runWatch(opts(), d)

    expect(out).toEqual([{ key: BF_KEY, seasonId: '2026-november', outcome: 'published', extractor: 'parser' }])
    expect(d.publish).toHaveBeenCalledWith(
      expect.objectContaining({ seasonId: '2026-november', date: '2026-11-27', repoRoot: repo }),
    )
    expect(d.git.commitAndPush).toHaveBeenCalledWith(
      `chore: ingest 2026-november from ${BF_KEY} (parser)`,
      ['current.json', 'seasons.json', 'sources.json', 'releases/2026-november'],
    )
    expect(d.issues.closeByPrefix).toHaveBeenCalledWith(
      'watch-rsd: could not publish 2026-november (',
      expect.stringContaining('abc1234'),
    )
    expect(d.issues.close).toHaveBeenCalledWith('watch-rsd: bucket unreachable', expect.any(String))
    expect((await sourcesOnDisk()).find((s) => s.key === BF_KEY)).toMatchObject({
      outcome: 'published',
      etag: BF.etag,
      extractor: 'parser',
    })
  })

  it('publishes a revision (changed ETag) within bounds', async () => {
    const revised = { ...APRIL, etag: '"a1a1a1a1"', lastModified: '2026-04-17T00:00:00.000Z' }
    const d = deps([revised], [extractor('parser', async () => aprilRows)])
    const out = await runWatch(opts(), d)
    expect(out[0]).toMatchObject({ seasonId: '2026-april', outcome: 'published' })
    expect(d.summary).toHaveBeenCalledWith(expect.stringContaining('Revision of 353 releases'))
  })

  it('fails a revision that removes too much and opens one issue', async () => {
    const revised = { ...APRIL, etag: '"a1a1a1a1"', lastModified: '2026-04-17T00:00:00.000Z' }
    const d = deps([revised], [extractor('parser', async () => aprilRows.slice(0, 250))])
    const out = await runWatch(opts(), d)
    expect(out[0]).toMatchObject({ outcome: 'failed' })
    expect(d.publish).not.toHaveBeenCalled()
    expect(d.issues.ensure).toHaveBeenCalledWith(
      'watch-rsd: could not publish 2026-april (a1a1a1a1)',
      expect.stringContaining('revision removes'),
    )
    expect((await sourcesOnDisk()).find((s) => s.key === APRIL_KEY)?.outcome).toBe('failed')
  })

  it('processes only the newest of two new keys for one season', async () => {
    const older = obj('2026/BF draft/2026_BLACK_FRIDAY_PUBLIC.pdf', '"0ld0ld00"', '2026-10-20T00:00:00.000Z')
    const parser = extractor('parser', async () => novemberRows)
    const d = deps([APRIL, older, BF], [parser])
    const out = await runWatch(opts(), d)
    expect(out).toEqual(
      expect.arrayContaining([
        { key: older.key, seasonId: '2026-november', outcome: 'superseded', extractor: null },
        { key: BF_KEY, seasonId: '2026-november', outcome: 'published', extractor: 'parser' },
      ]),
    )
    expect(parser.extract).toHaveBeenCalledTimes(1)
  })

  it('pending key older than the published copy is superseded', async () => {
    const stale = obj('2026/old/2026_RSD_PUBLIC_PDF.pdf', '"57a1e000"', '2026-03-01T00:00:00.000Z')
    const parser = extractor('parser', async () => aprilRows)
    const d = deps([APRIL, stale], [parser])
    const out = await runWatch(opts(), d)
    expect(out).toEqual([{ key: stale.key, seasonId: '2026-april', outcome: 'superseded', extractor: null }])
    expect(parser.extract).not.toHaveBeenCalled()
    expect(d.publish).not.toHaveBeenCalled()
  })

  it('records a non-list PDF as not-a-list without an issue', async () => {
    const pledge = obj('2026/Forms/RSD26_Pledge_Form.pdf', '"91ed9e00"', '2026-10-01T00:00:00.000Z')
    const d = deps(
      [APRIL, pledge],
      [
        extractor('parser', async () => {
          throw new Error('Could not detect a 5-column grid')
        }),
        extractor('gemini', async () => []),
      ],
    )
    const out = await runWatch(opts(), d)
    expect(out).toEqual([{ key: pledge.key, seasonId: null, outcome: 'not-a-list', extractor: null }])
    expect(d.issues.ensure).not.toHaveBeenCalled()
  })

  it('fails (with an issue) instead of not-a-list when no LLM ran', async () => {
    const pledge = obj('2026/Forms/RSD26_Pledge_Form.pdf', '"91ed9e00"', '2026-10-01T00:00:00.000Z')
    const d = deps(
      [APRIL, pledge],
      [
        extractor('parser', async () => {
          throw new Error('Could not detect a 5-column grid')
        }),
      ],
    )
    const out = await runWatch(opts(), d)
    expect(out[0]?.outcome).toBe('failed')
    expect(d.issues.ensure).toHaveBeenCalledTimes(1)
  })

  it('skips country lists without downloading them', async () => {
    const italia = obj('2026/RSD_2026_Italia/2026_RSD_PUBLIC_PDF_Italia.pdf', '"17a11a00"', '2026-02-01T00:00:00.000Z')
    const d = deps([APRIL, italia], [extractor('parser', async () => aprilRows)])
    const out = await runWatch(opts(), d)
    expect(out).toEqual([{ key: italia.key, seasonId: null, outcome: 'skipped-country', extractor: null }])
    expect(d.fetchPdf).not.toHaveBeenCalled()
    expect(d.git.commitAndPush).toHaveBeenCalledWith('chore: watch-rsd state', ['sources.json'])
  })

  it('opens the bucket issue and rethrows when listing fails', async () => {
    const d = deps([], [], {
      listBucket: vi.fn(async () => {
        throw new BucketError('HTTP 403 listing 2026/')
      }),
    })
    await expect(runWatch(opts(), d)).rejects.toThrow(/403/)
    expect(d.issues.ensure).toHaveBeenCalledWith('watch-rsd: bucket unreachable', expect.stringContaining('403'))
  })

  it('repeat failure with same ETag opens no new state commit', async () => {
    const failed: SourceEntry = {
      key: BF_KEY,
      etag: BF.etag,
      lastModified: BF.lastModified,
      seasonId: '2026-november',
      outcome: 'failed',
      extractor: null,
      processedAt: '2026-10-28T13:30:00.000Z',
    }
    await writeFile(sourcesPath, `${JSON.stringify([...seeded, failed], null, 2)}\n`)
    const d = deps([APRIL, BF], [extractor('parser', async () => novemberRows.slice(0, 10))])
    const out = await runWatch(opts(), d)
    expect(out[0]?.outcome).toBe('failed')
    expect(d.issues.ensure).toHaveBeenCalledTimes(1) // the client dedupes by title
    expect(d.git.commitAndPush).not.toHaveBeenCalled()
  })

  it('fails an April season with no calendar date before downloading', async () => {
    const april27 = obj('2027/RSD 2027/2027_RSD_PUBLIC_PDF.pdf', '"27272727"', '2026-10-15T00:00:00.000Z')
    const d = deps([APRIL, april27], [extractor('parser', async () => aprilRows)])
    const out = await runWatch(opts(), d)
    expect(out[0]).toMatchObject({ seasonId: '2027-april', outcome: 'failed' })
    expect(d.fetchPdf).not.toHaveBeenCalled()
    expect(d.issues.ensure).toHaveBeenCalledWith(
      'watch-rsd: could not publish 2027-april (27272727)',
      expect.stringContaining('calendar.json'),
    )
  })

  it('dry run reports but writes, publishes, commits and files nothing', async () => {
    const before = await readFile(sourcesPath, 'utf8')
    const d = deps([APRIL, BF], [extractor('parser', async () => novemberRows)])
    const out = await runWatch(opts(true), d)
    expect(out[0]).toMatchObject({ outcome: 'published', seasonId: '2026-november' })
    expect(d.publish).not.toHaveBeenCalled()
    expect(d.git.commitAndPush).not.toHaveBeenCalled()
    expect(d.issues.ensure).not.toHaveBeenCalled()
    expect(d.issues.close).not.toHaveBeenCalled()
    expect(await readFile(sourcesPath, 'utf8')).toBe(before)
  })

  it('runs only the requested extractor with --only', async () => {
    const parser = extractor('parser', async () => novemberRows)
    const gemini = extractor('gemini', async () => [])
    await runWatch({ ...opts(true), only: 'gemini' }, deps([APRIL, BF], [parser, gemini]))
    expect(parser.extract).not.toHaveBeenCalled()
    expect(gemini.extract).toHaveBeenCalledTimes(1)
  })

  it('lists explicit prefixes when given', async () => {
    const d = deps([APRIL], [])
    await runWatch({ ...opts(true), prefixes: ['2025/'] }, d)
    expect(d.listBucket).toHaveBeenCalledWith('2025/')
    expect(d.listBucket).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm vitest run tests/watch/run.test.ts`
Expected: FAIL — `scripts/watch/run.js` not found.

- [ ] **Step 6: Implement `run.ts`**

```ts
import { resolve } from 'node:path'

import { runCascade } from '../extract/index.js'
import type { Extractor, ExtractorName } from '../extract/types.js'

import { prefixesFor } from './bucket.js'
import { loadCalendar, seasonDate } from './calendar.js'
import { classifyKey, hasListSignal } from './classify.js'
import type { GitOps } from './git.js'
import { BUCKET_ISSUE_TITLE, failureIssueTitle, type IssueClient, seasonIssuePrefix } from './issues.js'
import type { PublishInput } from './publish.js'
import { loadGateContext } from './season-context.js'
import {
  type BucketObject,
  loadSources,
  pendingObjects,
  saveSources,
  type SourceOutcome,
  upsertSource,
} from './sources.js'

export interface WatchDeps {
  now: () => Date
  listBucket: (prefix: string) => Promise<BucketObject[]>
  fetchPdf: (key: string) => Promise<Buffer>
  pdfText: (pdf: Buffer) => Promise<string>
  extractors: Extractor[]
  publish: (input: PublishInput) => Promise<void>
  issues: IssueClient
  git: GitOps
  summary: (markdown: string) => Promise<void>
  log: (line: string) => void
}

export interface WatchOptions {
  repoRoot: string
  sourcesPath: string
  /** Report only: no publish, no commit, no issues, no sources.json write. */
  dryRun: boolean
  /** Run a single extractor (rehearsals). */
  only?: ExtractorName | undefined
  /** Override the listed prefixes (rehearsals against past years). */
  prefixes?: string[] | undefined
}

export interface WatchOutcome {
  key: string
  seasonId: string | null
  outcome: SourceOutcome
  extractor: ExtractorName | null
}

const message = (err: unknown): string => (err instanceof Error ? err.message : JSON.stringify(err))

/**
 * One watcher run: list the bucket, find new/revised/failed PDFs, pick one
 * per season, run the cascade, and publish or file an issue. All side
 * effects go through `deps`.
 */
export async function runWatch(opts: WatchOptions, deps: WatchDeps): Promise<WatchOutcome[]> {
  const live = !opts.dryRun
  const startedAt = deps.now().toISOString()

  const objects: BucketObject[] = []
  try {
    for (const prefix of opts.prefixes ?? prefixesFor(deps.now())) {
      objects.push(...(await deps.listBucket(prefix)))
    }
  } catch (err) {
    if (live) {
      await deps.issues.ensure(
        BUCKET_ISSUE_TITLE,
        [
          `Listing the RSD bucket failed at ${startedAt}:`,
          '',
          `    ${message(err)}`,
          '',
          'Manual `ingest` with a PDF URL still works. This issue closes itself after the next successful listing.',
        ].join('\n'),
      )
    }
    throw err
  }
  if (live) await deps.issues.close(BUCKET_ISSUE_TITLE, `Bucket listing succeeded again at ${startedAt}.`)

  let sources = await loadSources(opts.sourcesPath)
  const calendar = await loadCalendar(resolve(opts.repoRoot, 'calendar.json'))
  const outcomes: WatchOutcome[] = []
  let stateChanged = false

  const record = (
    obj: BucketObject,
    seasonId: string | null,
    outcome: SourceOutcome,
    extractor: ExtractorName | null,
  ): void => {
    outcomes.push({ key: obj.key, seasonId, outcome, extractor })
    const prev = sources.find((s) => s.key === obj.key)
    // Unchanged (e.g. the same failure again): no state churn, no commit.
    if (prev && prev.etag === obj.etag && prev.outcome === outcome && prev.seasonId === seasonId) return
    sources = upsertSource(sources, {
      key: obj.key,
      etag: obj.etag,
      lastModified: obj.lastModified,
      seasonId,
      outcome,
      extractor,
      processedAt: deps.now().toISOString(),
    })
    stateChanged = true
  }

  const processKey = async (obj: BucketObject, seasonId: string): Promise<void> => {
    const fail = async (body: string): Promise<void> => {
      record(obj, seasonId, 'failed', null)
      if (live) await deps.issues.ensure(failureIssueTitle(seasonId, obj.etag), `Source: \`${obj.key}\`\n\n${body}`)
    }

    const date = seasonDate(seasonId, calendar)
    if (!date) {
      await fail(`No date for ${seasonId}: add the year's April date to calendar.json. The watcher retries daily.`)
      return
    }

    let pdf: Buffer
    try {
      pdf = await deps.fetchPdf(obj.key)
    } catch (err) {
      await fail(`Downloading the PDF failed: ${message(err)}`)
      return
    }
    const pdfText = await deps.pdfText(pdf).catch(() => '')
    const context = await loadGateContext(opts.repoRoot, seasonId)
    const extractors = opts.only ? deps.extractors.filter((e) => e.name === opts.only) : deps.extractors
    const result = await runCascade({
      pdf,
      pdfText,
      extractors,
      ...context,
      title: `${seasonId} from \`${obj.key}\``,
    })
    await deps.summary(result.report)

    if (result.passed && result.releases && result.extractor) {
      record(obj, seasonId, 'published', result.extractor)
      if (!live) {
        deps.log(`[dry-run] would publish ${seasonId}: ${result.releases.length} releases via ${result.extractor}`)
        return
      }
      try {
        await deps.publish({ repoRoot: opts.repoRoot, seasonId, date, releases: result.releases })
        await saveSources(opts.sourcesPath, sources)
        const sha = await deps.git.commitAndPush(
          `chore: ingest ${seasonId} from ${obj.key} (${result.extractor})`,
          ['current.json', 'seasons.json', 'sources.json', `releases/${seasonId}`],
        )
        stateChanged = false // sources.json went out with this commit
        await deps.issues.closeByPrefix(
          seasonIssuePrefix(seasonId),
          `Published ${sha ? `in ${sha}` : '(no file changes)'} from \`${obj.key}\` via ${result.extractor}.`,
        )
      } catch (err) {
        await deps.issues.ensure(
          failureIssueTitle(seasonId, obj.etag),
          `Source: \`${obj.key}\`\n\nThe list passed the gate but publishing failed: ${message(err)}\n\n${result.report}`,
        )
        throw err
      }
      return
    }

    // Pledge forms, logo packs and the like: no list in the name, the parser
    // found nothing, and an LLM actually looked and found no valid list.
    if (!hasListSignal(obj.key) && !result.parserFoundRows && result.llmRan) {
      record(obj, null, 'not-a-list', null)
      return
    }
    await fail(result.report)
  }

  const bySeason = new Map<string, BucketObject[]>()
  for (const obj of pendingObjects(objects, sources)) {
    const c = classifyKey(obj.key)
    if (c.kind === 'ignored') continue
    if (c.kind === 'skipped-country') {
      record(obj, null, 'skipped-country', null)
      continue
    }
    bySeason.set(c.seasonId, [...(bySeason.get(c.seasonId) ?? []), obj])
  }

  for (const [seasonId, candidates] of bySeason) {
    // Published copies compete too: an older key that shows up late must
    // never overwrite a newer list.
    const publishedKeys = new Set(
      sources.filter((s) => s.seasonId === seasonId && s.outcome === 'published').map((s) => s.key),
    )
    const published = objects.filter((o) => publishedKeys.has(o.key) && !candidates.includes(o))
    const newest = [...candidates, ...published].sort((a, b) => b.lastModified.localeCompare(a.lastModified))[0]
    for (const obj of candidates) if (obj !== newest) record(obj, seasonId, 'superseded', null)
    if (newest && candidates.includes(newest)) await processKey(newest, seasonId)
  }

  if (live && stateChanged) {
    await saveSources(opts.sourcesPath, sources)
    await deps.git.commitAndPush('chore: watch-rsd state', ['sources.json'])
  }
  return outcomes
}
```

- [ ] **Step 7: Run tests and checks**

Run: `pnpm vitest run tests/watch && pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS (all `runWatch` scenarios).

- [ ] **Step 8: Commit**

```bash
git add scripts/watch/git.ts scripts/watch/run.ts tests/watch/git.test.ts tests/watch/run.test.ts
git commit -m "feat(watch): watcher orchestrator with injected side effects

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Watcher CLI, workflow, and seeded `sources.json`

**Files:**
- Create: `scripts/watch-rsd.ts`
- Create: `scripts/seed-sources.ts`
- Create: `sources.json` (generated)
- Create: `.github/workflows/watch-rsd.yml`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `runWatch` (Task 11), `listPdfs`, `fetchPdf` (Task 10), `pdfTextLayer` (Task 2), `defaultExtractors` (Task 5), `publishSeason` (Task 7), `createGitHubIssueClient`, `noopIssueClient` (Task 6), `createGitOps` (Task 11), `writeStepSummary` (Task 8), `classifyKey` (Task 9), `saveSources`, `SourceEntry` (Task 9).
- Produces: CLI `watch-rsd.ts [--dry-run] [--sources=<path>] [--only=parser|gemini|claude] [--prefix=<p>]...`; `pnpm watch-rsd`; workflow `watch-rsd`.

- [ ] **Step 1: Create `scripts/watch-rsd.ts`**

```ts
import { resolve } from 'node:path'

import { defaultExtractors } from './extract/index.js'
import { pdfTextLayer } from './extract/pdf-text.js'
import type { ExtractorName } from './extract/types.js'
import { fetchPdf, listPdfs } from './watch/bucket.js'
import { createGitOps } from './watch/git.js'
import { createGitHubIssueClient, noopIssueClient } from './watch/issues.js'
import { publishSeason } from './watch/publish.js'
import { runWatch } from './watch/run.js'
import { writeStepSummary } from './watch/summary.js'

const EXTRACTORS: ExtractorName[] = ['parser', 'gemini', 'claude']
const USAGE =
  'Usage: pnpm tsx scripts/watch-rsd.ts [--dry-run] [--sources=<path>] [--only=parser|gemini|claude] [--prefix=2025/]'

function flag(argv: string[], name: string): string[] {
  return argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const only = flag(argv, 'only')[0]
  if (only !== undefined && !EXTRACTORS.includes(only as ExtractorName)) {
    console.error(USAGE)
    process.exit(1)
    return
  }
  const prefixes = flag(argv, 'prefix')
  const repoRoot = resolve(process.cwd())
  const token = process.env['GITHUB_TOKEN']
  const repo = process.env['GITHUB_REPOSITORY']
  if (!dryRun && (!token || !repo)) {
    throw new Error('Publishing needs GITHUB_TOKEN and GITHUB_REPOSITORY; pass --dry-run to run locally.')
  }

  const outcomes = await runWatch(
    {
      repoRoot,
      sourcesPath: resolve(repoRoot, flag(argv, 'sources')[0] ?? 'sources.json'),
      dryRun,
      only: only as ExtractorName | undefined,
      prefixes: prefixes.length > 0 ? prefixes : undefined,
    },
    {
      now: () => new Date(),
      listBucket: (prefix) => listPdfs(prefix),
      fetchPdf: (key) => fetchPdf(key),
      pdfText: pdfTextLayer,
      extractors: defaultExtractors(),
      publish: (input) => publishSeason(input),
      issues: token && repo && !dryRun ? createGitHubIssueClient({ token, repo }) : noopIssueClient,
      git: createGitOps(repoRoot),
      summary: writeStepSummary,
      log: (line) => console.log(line),
    },
  )

  if (outcomes.length === 0) {
    console.log('No new or revised PDFs.')
    return
  }
  for (const o of outcomes) {
    console.log(`${o.outcome.padEnd(15)} ${o.seasonId ?? '-'} ${o.extractor ?? ''} ${o.key}`)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Create `scripts/seed-sources.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { SeasonsListSchema } from './types.js'
import { listPdfs } from './watch/bucket.js'
import { classifyKey } from './watch/classify.js'
import { type BucketObject, saveSources, type SourceEntry } from './watch/sources.js'

/**
 * One-off: record what's already in the bucket so the watcher's first run
 * doesn't re-ingest history. The newest PDF per already-published season is
 * `published`; older copies are `superseded`; country lists are skipped.
 * Refuses to guess about any PDF whose season isn't published yet.
 */
async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd())
  const prefixes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['2025/', '2026/']
  const seasons = SeasonsListSchema.parse(JSON.parse(await readFile(resolve(repoRoot, 'seasons.json'), 'utf8')))
  const published = new Set(seasons.map((s) => s.id))
  const now = new Date().toISOString()

  const objects: BucketObject[] = []
  for (const prefix of prefixes) objects.push(...(await listPdfs(prefix)))

  const entries: SourceEntry[] = []
  const bySeason = new Map<string, BucketObject[]>()
  const unknown: string[] = []
  for (const obj of objects) {
    const c = classifyKey(obj.key)
    const base = { key: obj.key, etag: obj.etag, lastModified: obj.lastModified, processedAt: now }
    if (c.kind === 'skipped-country') entries.push({ ...base, seasonId: null, outcome: 'skipped-country', extractor: null })
    else if (c.kind === 'season' && published.has(c.seasonId)) bySeason.set(c.seasonId, [...(bySeason.get(c.seasonId) ?? []), obj])
    else unknown.push(`${obj.key} (${c.kind === 'season' ? c.seasonId : c.kind})`)
  }
  if (unknown.length > 0) {
    console.error(`Not seeding; decide these by hand first:\n  ${unknown.join('\n  ')}`)
    process.exit(1)
    return
  }
  for (const [seasonId, objs] of bySeason) {
    const sorted = [...objs].sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    sorted.forEach((obj, i) =>
      entries.push({
        key: obj.key,
        etag: obj.etag,
        lastModified: obj.lastModified,
        processedAt: now,
        seasonId,
        outcome: i === 0 ? 'published' : 'superseded',
        extractor: i === 0 ? 'parser' : null,
      }),
    )
  }
  await saveSources(resolve(repoRoot, 'sources.json'), entries)
  for (const e of entries) console.log(`${e.outcome.padEnd(15)} ${e.seasonId ?? '-'} ${e.key}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 3: Seed `sources.json` and check it**

Run: `pnpm tsx scripts/seed-sources.ts`
Expected (order may differ):

```
skipped-country - 2025/RSD_2025_Italia/2025_RSD_PUBLIC_PDF_Italia.pdf
published       2025-april 2025/RSD 2025 List Links/2025_RSD_PUBLICX354A.pdf
published       2025-november 2025/RSD Black Friday 2025 l/2025_BLACK_FRIDAY_PUBLIC.pdf
superseded      2025-november 2025/RSD 2025 List Links/2025_BLACK_FRIDAY_PUBLIC.pdf
published       2026-april 2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf
superseded      2026-april 2026/RSD 2026_v2/RSD26_PDF_4-3.pdf
```

If the script refuses because of a PDF that wasn't in the bucket on 2026-09-30, stop and report it to Todd; don't add it by hand.

Then: `pnpm validate` → `All JSON files validated against Zod schemas.`

And confirm the watcher sees nothing new: `pnpm tsx scripts/watch-rsd.ts --dry-run` → `No new or revised PDFs.`

- [ ] **Step 4: Add package scripts**

In `package.json` `"scripts"`, add:

```json
    "watch-rsd": "tsx scripts/watch-rsd.ts",
```

- [ ] **Step 5: Create `.github/workflows/watch-rsd.yml`**

```yaml
name: watch-rsd

# Daily: list RSD's public bucket, ingest new or revised release-list PDFs
# through the extractor cascade and quality gate, publish what passes, and
# open an issue for anything that doesn't. Publishing is off until the
# WATCH_RSD_PUBLISH repository variable is "true"; until then scheduled runs
# are dry runs (report only, in the step summary).

on:
  schedule:
    # 13:30 UTC daily, after auto-status (12:00).
    - cron: '30 13 * * *'
  workflow_dispatch:
    inputs:
      publish:
        description: 'Publish (otherwise a dry run: report only)'
        required: false
        type: boolean
        default: false
      only:
        description: 'Run a single extractor (dry-run rehearsals)'
        required: false
        type: choice
        options: ['', parser, gemini, claude]
        default: ''

concurrency:
  group: watch-rsd
  cancel-in-progress: false

jobs:
  watch:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      # For the keepalive step below.
      actions: write
    steps:
      - uses: actions/checkout@v7

      - name: Enable corepack
        run: corepack enable

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: '24'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Watch the RSD bucket
        env:
          PUBLISH: ${{ (github.event_name == 'schedule' && vars.WATCH_RSD_PUBLISH == 'true') || (github.event_name == 'workflow_dispatch' && inputs.publish) }}
          ONLY: ${{ inputs.only }}
          GITHUB_TOKEN: ${{ github.token }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          DISCOGS_CONSUMER_KEY: ${{ secrets.DISCOGS_CONSUMER_KEY }}
          DISCOGS_CONSUMER_SECRET: ${{ secrets.DISCOGS_CONSUMER_SECRET }}
          METABRAINZ_ACCESS_TOKEN: ${{ secrets.METABRAINZ_ACCESS_TOKEN }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          args=()
          if [ "$PUBLISH" != "true" ]; then args+=(--dry-run); fi
          if [ -n "$ONLY" ]; then args+=("--only=$ONLY"); fi
          pnpm tsx scripts/watch-rsd.ts "${args[@]}"

      # GitHub disables scheduled workflows after 60 days without a commit,
      # and this job only commits when RSD publishes something. Re-enabling
      # the workflow through the API resets the inactivity timer without a
      # dummy commit (same fix as auto-status).
      - name: Keep this schedule alive
        if: always()
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh api -X PUT "repos/${{ github.repository }}/actions/workflows/watch-rsd.yml/enable"
```

- [ ] **Step 6: Lint the workflow and run all checks**

Run: `actionlint .github/workflows/watch-rsd.yml && pnpm lint && pnpm typecheck && pnpm test && pnpm validate`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add scripts/watch-rsd.ts scripts/seed-sources.ts sources.json .github/workflows/watch-rsd.yml package.json
git commit -m "feat(watch): daily watch-rsd workflow (dry run until enabled)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Live LLM check, docs, and the Black Friday 2025 rehearsal

**Files:**
- Create: `scripts/check-llm-extractors.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createGeminiExtractor` (Task 3), `createClaudeExtractor` (Task 4), `finalizeRows` (Task 1), `checkCandidate` (Task 2), `pdfTextLayer` (Task 2), `loadGateContext` (Task 7).
- Produces: CLI `check-llm-extractors.ts <gemini|claude> <pdf-path> [season-id]`.

- [ ] **Step 1: Create `scripts/check-llm-extractors.ts`**

```ts
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
```

- [ ] **Step 2: Live-check Gemini against the Black Friday 2025 fixture**

Run: `pnpm tsx --env-file=.env scripts/check-llm-extractors.ts gemini tests/fixtures/2025-november.pdf 2025-november`
Expected: `gemini: ~173 rows`, gate `PASS`, grounding ≥ 98% on both fields, small revision diff. Record the row count, grounding numbers and diff counts for the hand-off. If it FAILs, do not loosen the gate: report the failure reasons and the diff to Todd. (Skip the Claude check unless `ANTHROPIC_API_KEY` is set in `.env`.)

- [ ] **Step 3: Rehearse the watcher locally against Black Friday 2025 (spec "Rehearsal")**

```bash
node -e "const s=require('./sources.json');require('fs').writeFileSync('/tmp/sources-rehearsal.json', JSON.stringify(s.filter(e=>e.seasonId!=='2025-november'),null,2)+'\n')"
pnpm tsx --env-file=.env scripts/watch-rsd.ts --dry-run --prefix=2025/ --sources=/tmp/sources-rehearsal.json
```

Expected:
- `superseded 2025-november … 2025/RSD 2025 List Links/2025_BLACK_FRIDAY_PUBLIC.pdf`
- `published 2025-november parser 2025/RSD Black Friday 2025 l/2025_BLACK_FRIDAY_PUBLIC.pdf`
- report: `Revision of 173 releases: +0 added, −0 removed, 0 changed`
- `git status` clean (dry run writes nothing).

Then force the LLM path:

```bash
pnpm tsx --env-file=.env scripts/watch-rsd.ts --dry-run --prefix=2025/ --sources=/tmp/sources-rehearsal.json --only=gemini
```

Expected: `published 2025-november gemini …` and a revision diff within the gate. Record the diff counts.

- [ ] **Step 4: Document it in `README.md`**

Add a section after the existing ingest documentation (match the README's heading levels and tone):

```markdown
## Automatic ingest (`watch-rsd`)

A daily workflow (`.github/workflows/watch-rsd.yml`, 13:30 UTC) lists RSD's
public S3 bucket and ingests new or revised release-list PDFs with no human
step. Design: `docs/superpowers/specs/2026-09-30-automatic-season-ingest-design.md`.

- **Extraction:** the positional parser first, then Gemini Flash
  (`GEMINI_API_KEY`), then Claude (`ANTHROPIC_API_KEY`, optional). The first
  result that passes the quality gate wins.
- **Quality gate:** at least 25 complete rows, a size within 0.6–1.6× of the
  last same-kind season, bounded revisions (≤ 15% removed, ≤ 25% count
  change), and LLM rows that actually appear in the PDF's text.
- **Failures** publish nothing and open a `watch-rsd:` issue, which closes
  itself once the season is published (by the watcher or manual `ingest`).
- **State:** `sources.json` records every bucket PDF seen and what happened
  to it; `calendar.json` holds April dates (add each year's once RSD
  announces it; Black Friday is computed).
- **Publishing switch:** scheduled runs are dry runs (report in the step
  summary) unless the repository variable `WATCH_RSD_PUBLISH` is `true`.
  Manual runs take a `publish` checkbox and an `only` extractor choice.

Local dry run (reads `.env` for `GEMINI_API_KEY`):

    pnpm tsx --env-file=.env scripts/watch-rsd.ts --dry-run
    pnpm tsx --env-file=.env scripts/watch-rsd.ts --dry-run --prefix=2025/ --sources=/tmp/sources.json --only=gemini

Manual `ingest` now takes the date as a third argument and runs the same
cascade and gate:

    pnpm tsx scripts/ingest.ts 2026-november <pdf-url-or-path> 2026-11-27 [--label="..."] [--dry-run]
```

Also update any existing README lines that show the old two-argument `ingest.ts` usage.

- [ ] **Step 5: Checks and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm validate
git add scripts/check-llm-extractors.ts README.md
git commit -m "docs(watch): live LLM check script and watcher runbook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand-off (outward-facing steps need Todd's go-ahead)**

Report to Todd, with the numbers from Steps 2–3, and **ask before doing any of these**:
1. Push the branch / open the PR to `main` (needs the `mrballistic` `GH_TOKEN`).
2. Add the `GEMINI_API_KEY` repository secret from `.env` (`gh secret set GEMINI_API_KEY --repo mrballistic/wax-wishlist-data`).
3. After merge: dispatch `watch-rsd` once with `publish` unchecked and confirm the step summary says `No new or revised PDFs.`
4. Flip publishing on by setting the repository variable `WATCH_RSD_PUBLISH=true` (spec rollout step 3), ideally before the late-October Black Friday 2026 drop.

---

## Self-review notes

- **Spec coverage:** bucket listing + pagination (T10); diff/pending incl. failed retry (T9, T11); classify (T9); pick-one-per-season (T11); cascade parser → gemini → claude (T3–T5); not-a-list rule (T11); calendar (T9); publish + validate + commit message + push retry (T7, T11); keepalive (T12); `sources.json` + seeding (T9, T12); `calendar.json` (T9); shared post-processing and stable ids (T1); gate rules and report (T2, T5); issues incl. bucket issue and close-on-publish from both paths (T6, T8, T11); `ingest.yml` on the same path (T8); secrets (T8, T12); tests per spec section (T1–T11); `check-llm-extractors.ts` (T13); dry-run rehearsal (T13); rollout dry-run default (T12).
- **Deviations from the spec, deliberate:** watcher scenario tests inject a fake listing instead of msw (the bucket client itself is msw-tested in T10); `--prefix` and `--only` flags exist for rehearsals; the publish switch is a repository variable so flipping it needs no code change; the gate lives at `scripts/extract/gate.ts`; the "unrecognized list PDF" issue is not implemented (unreachable, see Global Constraints).
```
