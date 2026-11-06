import { access, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { normalizeArtImage } from '../art/normalize.js'
import type { Release } from '../types.js'

import { MIN_ARTIST, MIN_TITLE, scorePair, slugSimilarity } from './merge.js'

/**
 * recordstoreday.co.uk: every release has a page at /release/<slug> with a
 * schema.org MusicAlbum JSON-LD block (artist, title, label, date, cover
 * image, description). The site's slugs are its own ("coral-butterfly-house-
 * acoustic-version"), so pages are found through sitemap.xml. robots.txt
 * allows all of this.
 */
export const UK_SITE = 'https://www.recordstoreday.co.uk'
const TIMEOUT_MS = 30_000
/** Pause between page requests, to stay a polite visitor. */
const PAGE_DELAY_MS = 250
/** Slug shortlist: at most this many pages fetched per release, each at least this similar. */
const MAX_PAGES_PER_RELEASE = 3
const MIN_SLUG_SIMILARITY = 0.5

export interface UkPage {
  url: string
  artist: string
  title: string
  label: string | null
  /** yyyy-MM-dd */
  date: string | null
  image: string | null
  description: string | null
}

export interface UkSite {
  /** Every /release/ slug in the sitemap. */
  slugs(): Promise<string[]>
  /** One release page's JSON-LD, or null when the page or block is missing. */
  page(slug: string): Promise<UkPage | null>
  image(url: string): Promise<Buffer>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The first MusicAlbum JSON-LD block in a page. Exported for tests. */
export function parseReleasePage(html: string, url: string): UkPage | null {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data: unknown
    try {
      data = JSON.parse(m[1] ?? '')
    } catch {
      continue
    }
    const d = data as Record<string, unknown>
    if (d['@type'] !== 'MusicAlbum') continue
    const by = d['byArtist'] as { name?: unknown } | undefined
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : null
    const artist = str(by?.name)
    const title = str(d['name'])
    if (!artist || !title) return null
    return {
      url: str(d['url']) ?? url,
      artist,
      title,
      label: str(d['recordLabel']),
      date: str(d['datePublished']),
      image: str(d['image']),
      description: str(d['description']),
    }
  }
  return null
}

export function createUkSite(fetchImpl: typeof fetch = fetch): UkSite {
  let slugs: Promise<string[]> | null = null
  let lastPage = 0
  const get = async (url: string): Promise<Response> => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    return res
  }
  return {
    slugs() {
      slugs ??= (async () => {
        const res = await get(`${UK_SITE}/sitemap.xml`)
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching the UK sitemap`)
        const xml = await res.text()
        return [...xml.matchAll(/<loc>[^<]*\/release\/([a-z0-9-]+)<\/loc>/g)].map(
          (m) => m[1] as string,
        )
      })()
      return slugs
    },
    async page(slug) {
      const wait = lastPage + PAGE_DELAY_MS - Date.now()
      if (wait > 0) await sleep(wait)
      lastPage = Date.now()
      const url = `${UK_SITE}/release/${slug}`
      const res = await get(url)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
      return parseReleasePage(await res.text(), url)
    },
    async image(url) {
      const res = await get(url)
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
      return Buffer.from(await res.arrayBuffer())
    },
  }
}

const MONTH: Record<string, string> = { april: '04', november: '11' }

/** The page is for this season's event: same year, and the season's month when known. */
function inSeason(date: string | null, seasonId: string): boolean {
  if (!date) return true
  const [year, kind = ''] = seasonId.split('-')
  const month = MONTH[kind]
  return date.startsWith(`${year}-`) && (!month || date.slice(5, 7) === month)
}

/** A page counts as this release when artist and title clear the merge matcher's bar and the date fits. */
function isSameRelease(release: Release, page: UkPage, seasonId: string): boolean {
  const s = scorePair(
    { artist: page.artist, title: page.title, label: page.label ?? '', format: release.format },
    release,
  )
  return s.artist >= MIN_ARTIST && s.title >= MIN_TITLE && inSeason(page.date, seasonId)
}

/** "Track list", "Tracklisting:", "Tracks - Goza, …": a heading, optionally with the first entry after a colon or dash. */
const TRACKLIST_HEADING = /^(?:track[\s-]*list(?:ing)?|tracks)(?:\s*[:\-–—]\s*(.*)|\s*:?\s*)$/i
/** Where an unheaded tracklist starts: "1. …", "A1 …", "Side A", "Disc 1", "LP1". */
const TRACKLIST_START =
  /^(?:1[.)]\s|a1\b|side\s+(?:a|1|one)\b|disc\s+(?:1|one)\b|lp\s*1\b|cd\s*1\b)/i
/** A line that looks like a track or a side/disc heading. */
const TRACKISH = /^(?:\d{1,2}[.)]\s|[a-h]\d{1,2}\b|side\s|disc\s|lp\s*\d|cd\s*\d)/i
/** A line that ends a sentence, so the next line starts a new paragraph. */
const SENTENCE_END = /[.!?:”"')\]]$/

/**
 * Split a recordstoreday.co.uk description into prose and tracklist, in the
 * data contract's shape: paragraphs joined by a blank line, the tracklist one
 * entry per line as printed. The tracklist starts at a "Track list" heading,
 * or failing that at a trailing run of numbered lines ("1. …", "Side A") of
 * which most look like tracks. Lines that wrap mid-sentence are re-joined.
 * Exported for tests.
 */
export function splitUkDescription(text: string): { description: string; tracklist: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')

  let cut = lines.findIndex((l) => TRACKLIST_HEADING.test(l))
  const tracklist: string[] = []
  if (cut >= 0) {
    const first = TRACKLIST_HEADING.exec(lines[cut] as string)?.[1]?.trim()
    if (first) tracklist.push(first)
    tracklist.push(...lines.slice(cut + 1))
  } else {
    cut = lines.findIndex((l, i) => {
      if (!TRACKLIST_START.test(l)) return false
      const tail = lines.slice(i)
      return tail.length >= 3 && tail.filter((t) => TRACKISH.test(t)).length / tail.length >= 0.6
    })
    if (cut >= 0) tracklist.push(...lines.slice(cut))
  }

  const prose = cut >= 0 ? lines.slice(0, cut) : lines
  const paragraphs: string[] = []
  for (const [i, line] of prose.entries()) {
    const prev = prose[i - 1]
    if (prev === undefined || SENTENCE_END.test(prev)) paragraphs.push(line)
    else paragraphs[paragraphs.length - 1] += ` ${line}`
  }
  return { description: paragraphs.join('\n\n'), tracklist }
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

export interface UkSiteResult {
  releases: Release[]
  /** Release ids filled from the site (any field or art). */
  filled: string[]
  art: string[]
  notFound: string[]
}

/**
 * Fill UK exclusives from recordstoreday.co.uk: description, tracklist (split
 * out of the description) and page link where empty, and the cover into `art/<id>.jpg` when that slot has no file
 * (art already there, e.g. from wax-wishlist-art-admin, is never replaced).
 * Releases already complete are skipped without a request. Never throws: a
 * site failure is logged and the releases come back unchanged.
 */
export async function enrichFromUkSite(
  releases: Release[],
  opts: {
    repoRoot: string
    seasonId: string
    site?: UkSite
    log?: (line: string) => void
    dryRun?: boolean
  },
): Promise<UkSiteResult> {
  const site = opts.site ?? createUkSite()
  const log = opts.log ?? ((line: string) => console.log(line))
  const artDir = resolve(opts.repoRoot, 'releases', opts.seasonId, 'art')
  const result: UkSiteResult = { releases, filled: [], art: [], notFound: [] }

  const todo: { release: Release; needsArt: boolean }[] = []
  for (const r of releases) {
    if (r.regions?.length !== 1 || r.regions[0] !== 'uk') continue
    const needsArt = !(await exists(resolve(artDir, `${r.id}.jpg`)))
    if (needsArt || !r.description || !r.rsdUrl) todo.push({ release: r, needsArt })
  }
  if (todo.length === 0) return result

  let slugs: string[]
  try {
    slugs = await site.slugs()
  } catch (err) {
    log(`uk-site: skipped (${err instanceof Error ? err.message : String(err)})`)
    return result
  }

  const updates = new Map<string, Release>()
  for (const { release, needsArt } of todo) {
    const text = `${release.artist} ${release.title}`
    const shortlist = slugs
      .map((slug) => ({ slug, sim: slugSimilarity(slug, text) }))
      .filter((c) => c.sim >= MIN_SLUG_SIMILARITY)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, MAX_PAGES_PER_RELEASE)

    let page: UkPage | null = null
    for (const { slug } of shortlist) {
      try {
        const p = await site.page(slug)
        if (p && isSameRelease(release, p, opts.seasonId)) {
          page = p
          break
        }
      } catch (err) {
        log(`uk-site: ${slug}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!page) {
      result.notFound.push(release.id)
      continue
    }

    const next: Release = { ...release }
    const split = page.description ? splitUkDescription(page.description) : null
    if (!next.description && split?.description) next.description = split.description
    if (
      (next.tracklist === undefined || next.tracklist.length === 0) &&
      split &&
      split.tracklist.length > 0
    ) {
      next.tracklist = split.tracklist
    }
    if (!next.rsdUrl && URL.canParse(page.url)) next.rsdUrl = page.url
    let gotArt = false
    if (needsArt && page.image && !opts.dryRun) {
      try {
        const jpeg = await normalizeArtImage(await site.image(page.image))
        await mkdir(artDir, { recursive: true })
        await writeFile(resolve(artDir, `${release.id}.jpg`), jpeg)
        gotArt = true
        result.art.push(release.id)
      } catch (err) {
        log(
          `uk-site: art for ${release.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (gotArt || JSON.stringify(next) !== JSON.stringify(release)) {
      updates.set(release.id, next)
      result.filled.push(release.id)
    }
  }

  log(
    `uk-site: ${todo.length} UK exclusives needed data, ${result.filled.length} filled ` +
      `(${result.art.length} covers), ${result.notFound.length} not found`,
  )
  result.releases = releases.map((r) => updates.get(r.id) ?? r)
  return result
}
