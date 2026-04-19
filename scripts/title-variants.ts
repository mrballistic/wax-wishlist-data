/**
 * Generate query-friendly variants of an album title for external lookups.
 *
 * The Discogs search API matches strictly on `release_title`, so titles
 * decorated with edition markers (e.g. "Analogue 20th Anniversary Deluxe
 * Edition", "OK Computer (OKNOTOK 1997 2017)") frequently miss the master
 * record. Retrying the lookup with the decoration stripped recovers many
 * of those misses at the cost of one extra HTTP round trip per miss.
 *
 * {@link stripEditionSuffix} returns a shorter title if any edition-like
 * tail can be removed, or `null` when the title has no recognized
 * suffix to trim.
 */

// Keywords that, when appearing inside a trailing parenthetical, mark it
// as an edition suffix ripe for removal.
const EDITION_KEYWORDS =
  /(?:deluxe|expanded|anniversary|remastered?|edition|version|reissue|special|collector'?s|limited|bonus|super[-\s]?deluxe)/i

// Word tokens that, appearing at the tail of a bare (non-parenthesized)
// title, compose an edition suffix. We peel them off right-to-left until
// we hit a non-matching word.
const EDITION_WORD =
  /^(?:deluxe|expanded|anniversary|remastered?|edition|version|reissue|special|collectors|limited|bonus)$/i

// An ordinal ("20th", "10th", "1st") — part of an anniversary phrase.
const ORDINAL_WORD = /^\d+(?:st|nd|rd|th)?$/

/**
 * Return a variant of `title` with a trailing edition marker removed, or
 * `null` if no recognizable marker is present.
 *
 * Handles:
 *   - trailing parenthetical with edition keyword:
 *     "OK Computer (OKNOTOK 1997 2017)" → "OK Computer"
 *     "Album (Deluxe Edition)" → "Album"
 *     "Album (20th Anniversary Expanded Edition)" → "Album"
 *   - trailing non-parenthesized edition phrase:
 *     "Analogue 20th Anniversary Deluxe Edition" → "Analogue"
 *     "Album Deluxe" → "Album"
 *     "Album Remastered 2020" → "Album" (year goes with the phrase)
 */
export function stripEditionSuffix(title: string): string | null {
  const trimmed = title.trim()
  if (!trimmed) return null

  // Case 1: trailing parenthetical containing an edition keyword.
  const parenMatch = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(trimmed)
  if (parenMatch) {
    const [, head, inside] = parenMatch
    if (EDITION_KEYWORDS.test(inside)) {
      const base = head.trim()
      if (base && base !== trimmed) return base
    }
  }

  // Case 2: peel trailing edition-ish words (anniversary ordinals, years,
  // and edition keywords) off the tail until we hit a non-matching word.
  const words = trimmed.split(/\s+/)
  let i = words.length
  while (i > 0) {
    const tail = words[i - 1].replace(/[,.;:]+$/, '')
    const isEditionKeyword = EDITION_WORD.test(tail)
    const isOrdinal = ORDINAL_WORD.test(tail)
    const isYear = /^\d{4}$/.test(tail) // e.g. "Remastered 2020"
    if (isEditionKeyword || isOrdinal || isYear) {
      i -= 1
    } else {
      break
    }
  }
  // Only accept the stripped form if at least one word survives AND at
  // least one word was peeled off. "Deluxe" alone shouldn't return "".
  if (i < words.length && i > 0) {
    return words.slice(0, i).join(' ')
  }

  return null
}
