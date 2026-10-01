import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import type { Unlocker } from '../art/brightdata.js'
import { normalize } from '../art/match.js'

/**
 * Everything recordstoreday.com knows about a season's releases, read from the
 * event listing (see tests/fixtures/rsd-site/README.md for the markup). The site
 * is behind CloudFront, so pages go through Bright Data. Shared by the art tier,
 * row repair and enrichment: memoized per season per process.
 */

export const SITE = 'https://recordstoreday.com'
export const RSD_EVENTS_FILE = 'rsd-events.json'
/** How many ids above the highest known event id to try for an unmapped season. */
export const EVENT_PROBE_LIMIT = 6
/** A listing with fewer entries than this share of the expected count is incomplete. */
export const INCOMPLETE_RATIO = 0.8

/** Season id -> PromotionalEvent id, committed at the repo root. */
export const RsdEventsSchema = z.record(
  z.string().regex(/^\d{4}-(april|november)$/),
  z.number().int().positive(),
)
export type RsdEvents = z.infer<typeof RsdEventsSchema>

export interface SiteEntry {
  /** The `/SpecialRelease/<id>` number. */
  releaseId: string
  artist: string
  title: string
  photoId: number
  /** The quickview Format line, e.g. "2 x LP"; empty when absent. */
  format: string
  /** The quickview Label line; empty when absent. */
  label: string
  /** The "MORE INFO" prose, paragraphs joined by "\n\n"; empty when absent. */
  description: string
  /** Lines after the "Tracklist" heading, trimmed, blanks removed. */
  tracklist: string[]
  /** From the table page; null when it wasn't joined or isn't a number. */
  quantity: number | null
  /** From the table page's `/UPC/<digits>` comment; null when absent. */
  upc: string | null
  /** The release's own page. */
  pageUrl: string
}

export interface SiteIndex {
  seasonId: string
  eventId: number
  entries: SiteEntry[]
}

export interface SiteIndexOptions {
  seasonId: string
  unlocker: Unlocker | null
  /** Completeness floor: entries must be ≥ INCOMPLETE_RATIO × expectedCount (0 = no floor). */
  expectedCount: number
  /** Defaults to `rsd-events.json` in the working directory. */
  events?: RsdEvents
  log?: (line: string) => void
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

/** The table page: the only place with quantity and UPC (may come back JS-rendered and partial). */
export const tableUrl = (eventId: number): string => `${SITE}/PromotionalEvent/${eventId}`

export function photoUrl(photoId: number, size: 360 | 800 = 800): string {
  return `https://img.broadtime.com/Photo/${photoId}:${size}`
}

const QUICKVIEW = /quickview_image image">/
const DESCRIPTION = 'quickview_description'

/** A real event listing (it has release quickviews), not the HTTP 200 soft "not found" page. */
export function isEventPage(html: string): boolean {
  return QUICKVIEW.test(html) && !/the page you requested was not found/i.test(html)
}

/** Each release's quickview popup: the head fields, and the rest from its free-text description on. */
function quickviewBlocks(html: string): { head: string; tail: string }[] {
  return html
    .split(QUICKVIEW)
    .slice(1)
    .map((chunk) => {
      const at = chunk.indexOf(DESCRIPTION)
      return at < 0
        ? { head: chunk, tail: '' }
        : { head: chunk.slice(0, at), tail: chunk.slice(at + DESCRIPTION.length) }
    })
}

/** One release's quickview popup, cut before its free-text description. */
const quickviews = (html: string): string[] => quickviewBlocks(html).map((b) => b.head)

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
 * The inside of the description `<div>` whose class attribute `tail` starts in
 * (the text right after "quickview_description"), by counting nested divs.
 */
function descriptionDiv(tail: string): string {
  const open = tail.indexOf('>')
  if (open < 0) return ''
  const tag = /<(\/?)div\b[^>]*>/gi
  tag.lastIndex = open + 1
  let depth = 1
  for (let m = tag.exec(tail); m; m = tag.exec(tail)) {
    depth += m[1] ? -1 : 1
    if (depth === 0) return tail.slice(open + 1, m.index)
  }
  return tail.slice(open + 1)
}

const BR = '\ue000'
const BLOCK = '\ue001'
/** A tracklist heading on its own line ("Tracklist", "TRACK LISTING:", "Tracks:"), optionally followed by a first track after a colon. */
const TRACKLIST_HEADING = /^(?:track[\s-]*list(?:ing)?|tracks)(?:\s*:\s*(.*)|\s*)$/i

/**
 * The quickview "MORE INFO" text as printed lines, each tagged with whether a
 * paragraph break (a block element or two or more `<br>`s) precedes it.
 */
function descriptionLines(div: string): { text: string; newParagraph: boolean }[] {
  const marked = div
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<h3\b[^>]*>\s*MORE INFO\s*<\/h3\s*>/gi, BLOCK)
    .replace(/<br\b[^>]*>/gi, BR)
    .replace(/<\/?(?:p|div|li|ul|ol|h\d|table|tr)\b[^>]*>/gi, BLOCK)
  const lines: { text: string; newParagraph: boolean }[] = []
  let brs = 0
  let block = false
  for (const piece of marked.split(/([\ue000\ue001])/)) {
    if (piece === BR) brs += 1
    else if (piece === BLOCK) block = true
    else {
      const text = cleanText(piece)
      if (!text) continue
      lines.push({ text, newParagraph: block || brs >= 2 })
      brs = 0
      block = false
    }
  }
  return lines
}

/** Description (paragraphs joined by a blank line) and tracklist from one quickview's description block. */
function parseDescription(tail: string): { description: string; tracklist: string[] } {
  const lines = descriptionLines(descriptionDiv(tail))
  const heading = lines.findIndex((l) => TRACKLIST_HEADING.test(l.text))
  const prose = heading < 0 ? lines : lines.slice(0, heading)
  const paragraphs: string[] = []
  for (const [i, line] of prose.entries()) {
    if (i === 0 || line.newParagraph) paragraphs.push(line.text)
    else paragraphs[paragraphs.length - 1] += ` ${line.text}`
  }
  const tracklist: string[] = []
  const headLine = heading < 0 ? undefined : lines[heading]
  if (headLine) {
    const first = TRACKLIST_HEADING.exec(headLine.text)?.[1]?.trim()
    if (first) tracklist.push(first)
    tracklist.push(...lines.slice(heading + 1).map((l) => l.text))
  }
  return { description: paragraphs.join('\n\n'), tracklist }
}

/**
 * Every release on an event listing, read from each release's quickview block
 * (not table columns, which shift on the JS-rendered page). Works on the
 * `?view=all` grid, the server-rendered table and the rendered DOM alike.
 */
export function parseListing(html: string): Omit<SiteEntry, 'quantity' | 'upc'>[] {
  const entries: Omit<SiteEntry, 'quantity' | 'upc'>[] = []
  const seen = new Set<string>()
  for (const { head: block, tail } of quickviewBlocks(html)) {
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
    const label = cleanText(/<strong>Label<\/strong>:([^<]*)/.exec(block)?.[1] ?? '')
    if (!title || !artist) continue
    seen.add(releaseId)
    entries.push({
      releaseId,
      artist,
      title,
      photoId: Number(head[2]),
      format,
      label,
      ...parseDescription(tail),
      pageUrl: `${SITE}/SpecialRelease/${releaseId}`,
    })
  }
  return entries
}

/**
 * Quantity and UPC per release id from the server-rendered table page: one
 * `<tr>` per release inside `<tbody>`, quantity in the 7th plain cell after the
 * quickview, UPC in a commented-out cell. A JS-rendered page has re-laid
 * columns and no comments; whatever it yields is returned.
 */
export function parseTablePage(
  html: string,
): Map<string, { quantity: number | null; upc: string | null }> {
  const rows = new Map<string, { quantity: number | null; upc: string | null }>()
  for (const [, body = ''] of html.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)) {
    for (const row of body.split(/<tr\b/i).slice(1)) {
      const releaseId = /\/SpecialRelease\/(\d+)/.exec(row)?.[1]
      if (!releaseId || rows.has(releaseId)) continue
      const comments = (row.match(/<!--[\s\S]*?-->/g) ?? []).join(' ')
      const upc = /\/UPC\/(\d{8,14})\b/.exec(comments)?.[1] ?? null
      const live = row.replace(/<!--[\s\S]*?-->/g, ' ')
      // The quickview cell ends at the first </td> after its description.
      const qv = live.lastIndexOf(DESCRIPTION)
      const afterQuickview = qv < 0 ? live : live.slice(live.indexOf('</td>', qv) + '</td>'.length)
      const cells = [...afterQuickview.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
        (m) => m[1] ?? '',
      )
      const digits = cleanText(cells[6] ?? '').replace(/,/g, '')
      const quantity = /^\d+$/.test(digits) && Number(digits) > 0 ? Number(digits) : null
      rows.set(releaseId, { quantity, upc })
    }
  }
  return rows
}

/** One `SpecialRelease/<id>` page. Not used on the normal path (the listing has everything). */
export function parseReleasePage(
  html: string,
  pageUrl: string,
): Pick<SiteEntry, 'artist' | 'title' | 'photoId' | 'format' | 'pageUrl'> | null {
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
export function dropSharedPhotos<T extends Pick<SiteEntry, 'artist' | 'title' | 'photoId'>>(
  entries: T[],
  log: (line: string) => void,
): T[] {
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

const describeError = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err)

let warnedUnconfigured = false
const cache = new Map<string, Promise<SiteIndex | null>>()

/** Forget memoized indexes and the "not configured" warning (tests). */
export function resetSiteIndexCache(): void {
  cache.clear()
  warnedUnconfigured = false
}

/** A fetched listing that is a real event dated in this season, or null. */
async function fetchEvent(
  unlocker: Unlocker,
  id: number,
  seasonId: string,
): Promise<string | null> {
  const html = await unlocker.fetchPage(eventUrl(id))
  return isEventPage(html) && listingSeason(html) === seasonId ? html : null
}

/** The season's event id and listing HTML, or null (already logged) when there is none to use. */
async function findEvent(
  unlocker: Unlocker,
  seasonId: string,
  events: RsdEvents,
  log: (line: string) => void,
): Promise<{ id: number; html: string } | null> {
  const mapped = events[seasonId]
  if (mapped !== undefined) {
    const html = await unlocker.fetchPage(eventUrl(mapped))
    const dated = isEventPage(html) ? listingSeason(html) : null
    if (dated !== seasonId) {
      log(
        `rsd-site: PromotionalEvent/${mapped} lists ${dated ?? 'no dated'} releases, expected ${seasonId}; skipping`,
      )
      return null
    }
    return { id: mapped, html }
  }
  const known = Object.values(events)
  if (known.length === 0) {
    log(
      `rsd-site: ${seasonId} not in ${RSD_EVENTS_FILE} and no known event id to probe from; skipping`,
    )
    return null
  }
  const max = Math.max(...known)
  for (let id = max + 1; id <= max + EVENT_PROBE_LIMIT; id += 1) {
    const html = await fetchEvent(unlocker, id, seasonId)
    if (html !== null) {
      log(`rsd-site: ${seasonId} is PromotionalEvent/${id} — add it to ${RSD_EVENTS_FILE}`)
      return { id, html }
    }
  }
  log(
    `rsd-site: no event found for ${seasonId} in PromotionalEvent/${max + 1}..${max + EVENT_PROBE_LIMIT}`,
  )
  return null
}

/**
 * Quantity/UPC rows from the table page: one fetch, retried once on an error
 * or fewer than INCOMPLETE_RATIO × `listed` rows. Never throws; the larger
 * result wins.
 */
async function fetchTable(
  unlocker: Unlocker,
  eventId: number,
  listed: number,
  log: (line: string) => void,
): Promise<Map<string, { quantity: number | null; upc: string | null }>> {
  let best = new Map<string, { quantity: number | null; upc: string | null }>()
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const rows = parseTablePage(await unlocker.fetchPage(tableUrl(eventId)))
      if (rows.size > best.size) best = rows
    } catch (err) {
      log(`rsd-site: table page for PromotionalEvent/${eventId} failed (${describeError(err)})`)
    }
    if (best.size >= INCOMPLETE_RATIO * listed) return best
  }
  log(
    `rsd-site: table page for PromotionalEvent/${eventId} has ${best.size} of ${listed} rows; quantity/UPC partial`,
  )
  return best
}

/**
 * Resolve the season's event, read its `?view=all` listing (one retry when it
 * looks incomplete) and join quantity/UPC from the table page. Never throws:
 * any failure is logged and gives null.
 */
export async function fetchSiteIndex(opts: SiteIndexOptions): Promise<SiteIndex | null> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const { unlocker, seasonId } = opts
  if (!unlocker) {
    if (!warnedUnconfigured) log('rsd-site: Bright Data not configured; skipping')
    warnedUnconfigured = true
    return null
  }
  if (!/^\d{4}-(april|november)$/.test(seasonId)) {
    log(`rsd-site: ${seasonId} is not an April or November season; skipping`)
    return null
  }
  try {
    const events = opts.events ?? (await loadRsdEvents())
    const listing = await findEvent(unlocker, seasonId, events, log)
    if (!listing) return null
    // A short list (e.g. a JS-rendered 50-row page) is retried once, never used partially.
    const minimum = INCOMPLETE_RATIO * opts.expectedCount
    let listed = parseListing(listing.html)
    if (listed.length < minimum) {
      const retry = await fetchEvent(unlocker, listing.id, seasonId)
      listed = retry === null ? [] : parseListing(retry)
      if (listed.length < minimum) {
        log(
          `rsd-site: listing for ${seasonId} looks incomplete (${listed.length} entries); skipping`,
        )
        return null
      }
    }
    const table = await fetchTable(unlocker, listing.id, listed.length, log)
    const entries: SiteEntry[] = listed.map((e) => ({
      ...e,
      quantity: table.get(e.releaseId)?.quantity ?? null,
      upc: table.get(e.releaseId)?.upc ?? null,
    }))
    return { seasonId, eventId: listing.id, entries }
  } catch (err) {
    log(`rsd-site: skipped (${describeError(err)})`)
    return null
  }
}

/** `fetchSiteIndex`, memoized per season id for the life of the process (the first caller's options win). */
export function getSiteIndex(opts: SiteIndexOptions): Promise<SiteIndex | null> {
  const cached = cache.get(opts.seasonId)
  if (cached) return cached
  const pending = fetchSiteIndex(opts)
  cache.set(opts.seasonId, pending)
  return pending
}
