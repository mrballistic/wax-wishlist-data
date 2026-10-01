import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import type { RawRelease } from '../types.js'

import type { Unlocker } from './brightdata.js'
import type { IndexedArtSource } from './indexed-source.js'
import {
  type ArtCandidate,
  matchReleases,
  type MatchResult,
  type ScoredCandidate,
} from './match.js'

/**
 * Tier: product images from recordstoreday.com's event listing (see
 * tests/fixtures/rsd-site/README.md for the markup). The site is behind
 * CloudFront, so pages go through Bright Data; images are fetched directly.
 */

const SITE = 'https://recordstoreday.com'
export const RSD_EVENTS_FILE = 'rsd-events.json'
/** How many ids above the highest known event id to try for an unmapped season. */
export const EVENT_PROBE_LIMIT = 6

/** Season id -> PromotionalEvent id, committed at the repo root. */
export const RsdEventsSchema = z.record(
  z.string().regex(/^\d{4}-(april|november)$/),
  z.number().int().positive(),
)
export type RsdEvents = z.infer<typeof RsdEventsSchema>

export interface SiteEntry {
  artist: string
  title: string
  photoId: number
  /** The listing's format cell, e.g. "2 x LP"; empty when absent. */
  format: string
  /** The release's own page. */
  pageUrl: string
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
}

const CP1252 = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, i) => i))
const CP1252_BYTE = new Map([...CP1252].map((ch, i) => [ch, i]))
/** A UTF-8 lead byte (Â..ô) followed by a continuation byte, both read as Windows-1252. */
const MOJIBAKE =
  /[\u00c2-\u00f4][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/

/**
 * Some rows are stored double-encoded on the site itself ("MotÃ¶rhead"). Undo it
 * only when the whole string round-trips to valid UTF-8; otherwise leave it.
 */
function repairMojibake(s: string): string {
  if (!MOJIBAKE.test(s)) return s
  const bytes: number[] = []
  for (const ch of s) {
    const b = CP1252_BYTE.get(ch)
    if (b === undefined) return s
    bytes.push(b)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
  } catch {
    return s
  }
}

/** Cell text: tags stripped, entities decoded, mojibake repaired, NBSP as space, whitespace collapsed, trimmed. */
export function cleanText(html: string): string {
  const decoded = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
      if (ref[0] === '#') {
        const code =
          ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole
      }
      return NAMED[ref.toLowerCase()] ?? whole
    })
  return (
    repairMojibake(decoded)
      // C1 controls are Windows-1252 punctuation stored as Latin-1 (U+0085 is "…").
      .replace(/[\u0080-\u009f]/g, (ch) => CP1252[ch.charCodeAt(0)] ?? ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

export const eventUrl = (eventId: number): string => `${SITE}/PromotionalEvent/${eventId}`

export function photoUrl(photoId: number, size: 360 | 800 = 800): string {
  return `https://img.broadtime.com/Photo/${photoId}:${size}`
}

/** The listing's `<a id="anchor" name="…">`, e.g. "RECORD STORE DAY 2026". */
export function eventName(html: string): string | null {
  const m = /<a\s+id="anchor"\s+name="([^"]*)"/i.exec(html)
  return m?.[1] !== undefined ? cleanText(m[1]) : null
}

/** A real event listing, not the HTTP 200 soft "not found" page. */
export function isEventPage(html: string): boolean {
  return /<tbody[\s>]/i.test(html) && !/the page you requested was not found/i.test(html)
}

/** The anchor name a season's event carries, or null for a season type the site doesn't have. */
export function expectedEventName(seasonId: string): string | null {
  const m = /^(\d{4})-(april|november)$/.exec(seasonId)
  if (!m) return null
  return m[2] === 'april' ? `RECORD STORE DAY ${m[1]}` : `BLACK FRIDAY ${m[1]}`
}

const sameName = (a: string | null, b: string): boolean =>
  a !== null && a.trim().toLowerCase() === b.toLowerCase()

/** Every release row of an event listing. One server-rendered page; rows after `</tbody>` are not releases. */
export function parseListing(html: string): SiteEntry[] {
  const start = html.search(/<tbody[\s>]/i)
  if (start < 0) return []
  const end = html.indexOf('</tbody>', start)
  const body = html.slice(start, end < 0 ? undefined : end)
  const entries: SiteEntry[] = []
  for (const chunk of body.split(/quickview_image image">/).slice(1)) {
    const head =
      /^\s*<a href="\/SpecialRelease\/(\d+)">\s*<img[^>]*src="https?:\/\/img\.broadtime\.com\/Photo\/(\d+)/.exec(
        chunk,
      )
    if (!head?.[1] || !head[2]) continue
    const releaseId = head[1]
    const cells = new RegExp(
      `<td[^>]*>\\s*<a href="/SpecialRelease/${releaseId}">([\\s\\S]*?)</a>\\s*</td>` +
        '\\s*<td[^>]*>([\\s\\S]*?)</td>'.repeat(4),
    ).exec(chunk)
    // cells: title, artist, sort key (hidden, not the artist), label, format.
    const title = cleanText(cells?.[1] ?? /<em>([\s\S]*?)<\/em>/.exec(chunk)?.[1] ?? '')
    const artist = cleanText(cells?.[2] ?? /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(chunk)?.[1] ?? '')
    const format = cleanText(
      cells?.[5] ?? /<strong>Format<\/strong>:([^<]*)/.exec(chunk)?.[1] ?? '',
    )
    if (!title || !artist) continue
    entries.push({
      artist,
      title,
      photoId: Number(head[2]),
      format,
      pageUrl: `${SITE}/SpecialRelease/${releaseId}`,
    })
  }
  return entries
}

/** One `SpecialRelease/<id>` page. Not used on the normal path (the listing has everything). */
export function parseReleasePage(html: string, pageUrl: string): SiteEntry | null {
  const photo = /<a href="https?:\/\/img\.broadtime\.com\/Photo\/(\d+):800">/.exec(html)
  if (!photo?.[1]) return null
  const rest = html.slice(photo.index)
  const artist = cleanText(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(rest)?.[1] ?? '')
  const title = cleanText(/<em>([\s\S]*?)<\/em>/.exec(rest)?.[1] ?? '')
  const format = cleanText(/<strong>Format<\/strong>:([^<]*)/.exec(rest)?.[1] ?? '')
  if (!artist || !title) return null
  return { artist, title, photoId: Number(photo[1]), format, pageUrl }
}

/** The committed season -> event map; a missing file is an empty map. */
export async function loadRsdEvents(
  path = resolve(process.cwd(), RSD_EVENTS_FILE),
): Promise<RsdEvents> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  return RsdEventsSchema.parse(JSON.parse(raw))
}

export interface RsdSiteOptions {
  seasonId: string
  unlocker: Unlocker | null
  /** Defaults to `rsd-events.json` in the working directory. */
  events?: RsdEvents
  log?: (line: string) => void
}

const describeError = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err)

export function createRsdSiteSource(opts: RsdSiteOptions): IndexedArtSource {
  const log = opts.log ?? ((line: string) => console.log(line))
  let result: MatchResult = { accepted: new Map(), suggestions: new Map() }
  let warnedUnconfigured = false

  /** The season's listing HTML, or null (already logged) when there is none to use. */
  async function fetchListing(
    unlocker: Unlocker,
    expected: string,
  ): Promise<{ id: number; html: string } | null> {
    const events = opts.events ?? (await loadRsdEvents())
    const mapped = events[opts.seasonId]
    if (mapped !== undefined) {
      const html = await unlocker.fetchPage(eventUrl(mapped))
      const name = eventName(html)
      if (!isEventPage(html) || !sameName(name, expected)) {
        log(
          `rsd-site: PromotionalEvent/${mapped} is "${name ?? 'not an event'}", expected "${expected}" for ${opts.seasonId}; skipping`,
        )
        return null
      }
      return { id: mapped, html }
    }
    const known = Object.values(events)
    if (known.length === 0) {
      log(
        `rsd-site: ${opts.seasonId} not in ${RSD_EVENTS_FILE} and no known event id to probe from; skipping`,
      )
      return null
    }
    const max = Math.max(...known)
    for (let id = max + 1; id <= max + EVENT_PROBE_LIMIT; id += 1) {
      const html = await unlocker.fetchPage(eventUrl(id))
      if (isEventPage(html) && sameName(eventName(html), expected)) {
        log(`rsd-site: ${opts.seasonId} is PromotionalEvent/${id} — add it to ${RSD_EVENTS_FILE}`)
        return { id, html }
      }
    }
    log(
      `rsd-site: no event found for ${opts.seasonId} in PromotionalEvent/${max + 1}..${max + EVENT_PROBE_LIMIT}`,
    )
    return null
  }

  return {
    name: 'rsd-site',
    async prepare(missing: RawRelease[], season: RawRelease[]): Promise<void> {
      const { unlocker } = opts
      if (!unlocker) {
        if (!warnedUnconfigured) log('rsd-site: Bright Data not configured; skipping')
        warnedUnconfigured = true
        return
      }
      if (missing.length === 0) return
      const expected = expectedEventName(opts.seasonId)
      if (!expected) {
        log(`rsd-site: ${opts.seasonId} is not an April or November season; skipping`)
        return
      }
      try {
        const listing = await fetchListing(unlocker, expected)
        if (!listing) return
        const entries = parseListing(listing.html)
        const candidates: ArtCandidate[] = entries.map((e) => ({
          source: 'rsd-site',
          key: `photo:${e.photoId}`,
          imageUrl: photoUrl(e.photoId, 800),
          thumbUrl: photoUrl(e.photoId, 360),
          label: `${e.artist} – ${e.title}`,
          artist: e.artist,
          title: e.title,
          photoId: e.photoId,
          format: e.format,
        }))
        result = matchReleases(missing, candidates, season)
        log(
          `rsd-site: PromotionalEvent/${listing.id} lists ${entries.length} releases, ${result.accepted.size} matched ` +
            `(${unlocker.requestsMade()} Unlocker requests)`,
        )
      } catch (err) {
        log(`rsd-site: skipped (${describeError(err)})`)
      }
    },
    accepted: (id: string): ScoredCandidate | null => result.accepted.get(id) ?? null,
    suggestions: (id: string): ScoredCandidate[] => result.suggestions.get(id) ?? [],
  }
}
