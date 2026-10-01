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
