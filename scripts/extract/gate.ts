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
  /**
   * Rows with an empty artist/title/label/format are dropped, not published,
   * up to this share of the list; more than that fails the gate.
   */
  maxIncompleteFraction: 0.02,
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
  /** The rows that would be published (the candidate minus incomplete rows). */
  kept: RawRelease[]
  /** Incomplete rows removed from the candidate. */
  dropped: RawRelease[]
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
const describeRow = (r: RawRelease): string =>
  [r.category, r.artist || '?', r.title || '?', r.label || '(blank)', r.format || '(blank)'].join(
    ' | ',
  )
const describe = (r: RawRelease): string => `${r.artist || '?'} – ${r.title || '?'}`

function list<T>(items: T[], render: (item: T) => string): string {
  const shown = items.slice(0, DIFF_LIST_LIMIT).map((i) => `- ${render(i)}`)
  if (items.length > DIFF_LIST_LIMIT) shown.push(`- …and ${items.length - DIFF_LIST_LIMIT} more`)
  return shown.join('\n')
}

/** Report lines for incomplete rows; shared with the watcher's issue body. */
export function droppedLines(dropped: RawRelease[]): string[] {
  return [
    `- ⚠️ Dropped ${dropped.length} incomplete rows (not published):`,
    ...dropped.map((r) => `  - ${describeRow(r)}`),
  ]
}

export function checkCandidate(candidate: RawRelease[], ctx: GateContext): GateResult {
  const failures: string[] = []
  const notes: string[] = []

  const isIncomplete = (r: RawRelease): boolean => !r.artist || !r.title || !r.label || !r.format
  const dropped = candidate.filter(isIncomplete)
  // Every other rule judges what would actually be published.
  const kept = candidate.filter((r) => !isIncomplete(r))
  const n = kept.length

  if (n < GATE.minRows) failures.push(`only ${n} rows (minimum ${GATE.minRows})`)

  const limit = Math.floor(candidate.length * GATE.maxIncompleteFraction)
  const firstDropped = dropped[0]
  if (firstDropped && dropped.length > limit) {
    failures.push(
      `${dropped.length} rows missing artist, title, label or format (limit ${limit} = ${GATE.maxIncompleteFraction * 100}% of ${candidate.length}; first: ${describe(firstDropped)})`,
    )
  }

  const badCategory = kept.filter((r) => !VALID_CATEGORIES.has(r.category))
  if (badCategory.length > 0) failures.push(`${badCategory.length} rows with an unknown category`)

  const uniqueIds = new Set(kept.map((r) => r.id)).size
  if (uniqueIds !== n) failures.push(`${n - uniqueIds} duplicate ids`)

  let diff: ReleaseDiff | null = null
  const prev = ctx.previousSameSeason
  if (prev && prev.length > 0) {
    diff = diffReleases(prev, kept)
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
      const artists = groundedFraction(kept.map((r) => r.artist), ctx.pdfText)
      const titles = groundedFraction(kept.map((r) => r.title), ctx.pdfText)
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
  const count = dropped.length > 0 ? `${n} rows, ${dropped.length} dropped` : `${n} rows`
  const lines = [`#### ${ctx.extractor}: ${pass ? 'PASS' : 'FAIL'} (${count})`, '']
  for (const note of notes) lines.push(`- ${note}`)
  for (const failure of failures) lines.push(`- ❌ ${failure}`)
  if (dropped.length > 0) lines.push(...droppedLines(dropped))
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
  return { pass, failures, kept, dropped, report: lines.join('\n') }
}
