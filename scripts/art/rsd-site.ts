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
  normalize,
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
/** A listing with fewer entries than this share of the season's releases is incomplete. */
export const INCOMPLETE_RATIO = 0.8

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
/**
 * A UTF-8 lead byte followed by a continuation byte, both read as Windows-1252.
 * Only Â/Ã leads (U+0080..U+00FF, i.e. Latin-1 and its punctuation): wider leads
 * would "repair" correct text such as "CAFÉ—LIVE" (É— is also valid UTF-8 bytes).
 */
const MOJIBAKE =
  /[\u00c2\u00c3][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/

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

/** The unpaginated listing. Without `?view=all` the Unlocker sometimes returns a JS-rendered, 50-row page. */
export const eventUrl = (eventId: number): string => `${SITE}/PromotionalEvent/${eventId}?view=all`

export function photoUrl(photoId: number, size: 360 | 800 = 800): string {
  return `https://img.broadtime.com/Photo/${photoId}:${size}`
}

const QUICKVIEW = /quickview_image image">/

/** A real event listing (it has release quickviews), not the HTTP 200 soft "not found" page. */
export function isEventPage(html: string): boolean {
  return QUICKVIEW.test(html) && !/the page you requested was not found/i.test(html)
}

/** One release's quickview popup, cut before its free-text description. */
function quickviews(html: string): string[] {
  return html
    .split(QUICKVIEW)
    .slice(1)
    .map((chunk) => chunk.split('quickview_description')[0] ?? chunk)
}

/**
 * The season the listing's releases are dated in, by majority vote over the
 * quickview `Date: M/D/YYYY` lines: "<year>-april" or "<year>-november", or
 * null when there are no dates or the usual month is neither.
 */
export function listingSeason(html: string): string | null {
  const votes = new Map<string, number>()
  for (const block of quickviews(html)) {
    const m = /<strong>Date<\/strong>:\s*(\d{1,2})\/\d{1,2}\/(\d{4})/.exec(block)
    if (!m?.[1] || !m[2]) continue
    const key = `${m[2]}-${Number(m[1])}`
    votes.set(key, (votes.get(key) ?? 0) + 1)
  }
  const top = [...votes].sort((x, y) => y[1] - x[1])[0]
  if (!top) return null
  const [year, month] = top[0].split('-')
  return month === '4' ? `${year}-april` : month === '11' ? `${year}-november` : null
}

/**
 * Every release on an event listing, read from each release's quickview block
 * (not table columns, which shift on the JS-rendered page). Works on the
 * `?view=all` grid, the server-rendered table and the rendered DOM alike.
 */
export function parseListing(html: string): SiteEntry[] {
  const entries: SiteEntry[] = []
  const seen = new Set<string>()
  for (const block of quickviews(html)) {
    const head =
      /^\s*<a href="\/SpecialRelease\/(\d+)">\s*<img[^>]*src="https?:\/\/img\.broadtime\.com\/Photo\/(\d+)/.exec(
        block,
      )
    if (!head?.[1] || !head[2] || seen.has(head[1])) continue
    const releaseId = head[1]
    const artist = cleanText(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] ?? '')
    const title = cleanText(
      /<em>([\s\S]*?)<\/em>/.exec(block)?.[1] ??
        new RegExp(`<a href="/SpecialRelease/${releaseId}">([^<]+)</a>`).exec(block)?.[1] ??
        '',
    )
    const format = cleanText(/<strong>Format<\/strong>:([^<]*)/.exec(block)?.[1] ?? '')
    if (!title || !artist) continue
    seen.add(releaseId)
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

/**
 * Drop rows whose photo id also appears on a row for a different release
 * (normalized artist + title): that photo is a site placeholder, not art.
 * Colour variants of one release share artist and title, so they survive.
 */
export function dropSharedPhotos(entries: SiteEntry[], log: (line: string) => void): SiteEntry[] {
  const releasesByPhoto = new Map<number, Set<string>>()
  for (const e of entries) {
    const key = `${normalize(e.artist)}|${normalize(e.title)}`
    releasesByPhoto.set(e.photoId, (releasesByPhoto.get(e.photoId) ?? new Set()).add(key))
  }
  const shared = new Set<number>()
  for (const [photoId, releases] of releasesByPhoto) {
    if (releases.size < 2) continue
    shared.add(photoId)
    log(`rsd-site: photo ${photoId} shared by ${releases.size} different releases; ignored`)
  }
  return shared.size === 0 ? entries : entries.filter((e) => !shared.has(e.photoId))
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

  /** A fetched listing that is a real event dated in this season, or null. */
  async function fetchEvent(unlocker: Unlocker, id: number): Promise<string | null> {
    const html = await unlocker.fetchPage(eventUrl(id))
    return isEventPage(html) && listingSeason(html) === opts.seasonId ? html : null
  }

  /** The season's event id and listing HTML, or null (already logged) when there is none to use. */
  async function findEvent(unlocker: Unlocker): Promise<{ id: number; html: string } | null> {
    const events = opts.events ?? (await loadRsdEvents())
    const mapped = events[opts.seasonId]
    if (mapped !== undefined) {
      const html = await unlocker.fetchPage(eventUrl(mapped))
      const dated = isEventPage(html) ? listingSeason(html) : null
      if (dated !== opts.seasonId) {
        log(
          `rsd-site: PromotionalEvent/${mapped} lists ${dated ?? 'no dated'} releases, expected ${opts.seasonId}; skipping`,
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
      const html = await fetchEvent(unlocker, id)
      if (html !== null) {
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
      if (!/^\d{4}-(april|november)$/.test(opts.seasonId)) {
        log(`rsd-site: ${opts.seasonId} is not an April or November season; skipping`)
        return
      }
      try {
        const listing = await findEvent(unlocker)
        if (!listing) return
        // A short list (e.g. a JS-rendered 50-row page) is retried once, never matched partially.
        const minimum = INCOMPLETE_RATIO * season.length
        let entries = parseListing(listing.html)
        if (entries.length < minimum) {
          const retry = await fetchEvent(unlocker, listing.id)
          entries = retry === null ? [] : parseListing(retry)
          if (entries.length < minimum) {
            log(
              `rsd-site: listing for ${opts.seasonId} looks incomplete (${entries.length} entries); skipping`,
            )
            return
          }
        }
        const candidates: ArtCandidate[] = dropSharedPhotos(entries, log).map((e) => ({
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
