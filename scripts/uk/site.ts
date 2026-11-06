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
 * Fill UK exclusives from recordstoreday.co.uk: description and page link
 * where empty, and the cover into `art/<id>.jpg` when that slot has no file
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
    if (!next.description && page.description) next.description = page.description
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
