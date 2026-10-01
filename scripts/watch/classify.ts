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
