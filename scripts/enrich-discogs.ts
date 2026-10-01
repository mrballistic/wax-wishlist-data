import { stripEditionSuffix } from './title-variants.js'
import type { RawRelease, Release } from './types.js'

const DISCOGS_SEARCH_URL = 'https://api.discogs.com/database/search'
const RATE_LIMIT_MS = 1100 // ~1 req/sec is well under Discogs's public ceiling

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface DiscogsSearchHit {
  master_id?: number
  id?: number
}

/** A release before Discogs: optionally already enriched (a carried-forward id, a site UPC). */
export type DiscogsInput = RawRelease & Partial<Omit<Release, keyof RawRelease>>

interface DiscogsSearchResponse {
  results?: DiscogsSearchHit[]
}

const HEADERS = (consumerKey: string, consumerSecret: string): Record<string, string> => ({
  Authorization: `Discogs key=${consumerKey}, secret=${consumerSecret}`,
  'User-Agent': 'wax-wishlist-data/0.1 (+https://github.com/mrballistic/wax-wishlist-data)',
})

async function search(
  url: URL,
  consumerKey: string,
  consumerSecret: string,
): Promise<DiscogsSearchHit | null> {
  const res = await fetch(url, { headers: HEADERS(consumerKey, consumerSecret) })
  if (!res.ok) return null
  const body = (await res.json()) as DiscogsSearchResponse
  return body.results?.[0] ?? null
}

async function searchMasterId(
  artist: string,
  title: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<number | null> {
  const url = new URL(DISCOGS_SEARCH_URL)
  url.searchParams.set('artist', artist)
  url.searchParams.set('release_title', title)
  url.searchParams.set('type', 'master')
  url.searchParams.set('per_page', '1')
  const first = await search(url, consumerKey, consumerSecret)
  return first?.master_id ?? first?.id ?? null
}

/** The master of the first release with this barcode; a release with no master gives null. */
async function searchByBarcode(
  upc: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<number | null> {
  const url = new URL(DISCOGS_SEARCH_URL)
  url.searchParams.set('barcode', upc)
  url.searchParams.set('type', 'release')
  url.searchParams.set('per_page', '1')
  const first = await search(url, consumerKey, consumerSecret)
  return first?.master_id ? first.master_id : null
}

async function lookup(
  release: DiscogsInput,
  consumerKey: string,
  consumerSecret: string,
): Promise<{ discogsMasterId: number | null }> {
  // An exact barcode hit beats a fuzzy artist/title search.
  if (release.upc) {
    const byBarcode = await searchByBarcode(release.upc, consumerKey, consumerSecret)
    if (byBarcode != null) return { discogsMasterId: byBarcode }
    await sleep(RATE_LIMIT_MS)
  }

  let masterId = await searchMasterId(release.artist, release.title, consumerKey, consumerSecret)

  // Retry once with edition suffix stripped — recovers many Deluxe /
  // Anniversary / Remastered variants that miss on the decorated title.
  // Pay the second rate-limit tick to stay under Discogs's ceiling.
  if (masterId == null) {
    const stripped = stripEditionSuffix(release.title)
    if (stripped) {
      await sleep(RATE_LIMIT_MS)
      masterId = await searchMasterId(release.artist, stripped, consumerKey, consumerSecret)
    }
  }

  return { discogsMasterId: masterId }
}

/**
 * Enrich raw releases with Discogs master IDs. Completely optional:
 * if either `DISCOGS_CONSUMER_KEY` or `DISCOGS_CONSUMER_SECRET` is unset, the
 * enricher returns a best-effort mapping with `discogsMasterId: null`.
 *
 * An existing non-null `discogsMasterId` is kept without a request. When a
 * `upc` is known it is tried first (`type=release` barcode search, the hit's
 * `master_id`), then the artist/title search. Other fields pass through.
 *
 * `artFilename` is always `<id>.jpg` — it names the release's art *slot*,
 * not a promise that the file exists. The art cascade and
 * wax-wishlist-art-admin both fill that slot later; the admin tool lists
 * releases whose slot is empty and commits to exactly that filename, so a
 * null here would make the release unfixable from the admin UI.
 */
export async function enrichDiscogs(releases: DiscogsInput[]): Promise<Release[]> {
  const consumerKey = process.env['DISCOGS_CONSUMER_KEY']
  const consumerSecret = process.env['DISCOGS_CONSUMER_SECRET']
  const enriched: Release[] = []
  const total = releases.length
  const pad = String(total).length

  let hits = 0
  let misses = 0
  let errors = 0

  for (let i = 0; i < total; i++) {
    const raw = releases[i]
    if (!raw) continue
    const n = String(i + 1).padStart(pad, ' ')
    const label = `${raw.artist} – ${raw.title}`

    if (raw.discogsMasterId != null) {
      enriched.push({ ...raw, discogsMasterId: raw.discogsMasterId, artFilename: `${raw.id}.jpg` })
      console.log(`[${n}/${total}] ${label} → master=${raw.discogsMasterId} (kept)`)
      continue
    }
    if (!consumerKey || !consumerSecret) {
      enriched.push({ ...raw, discogsMasterId: null, artFilename: `${raw.id}.jpg` })
      console.log(`[${n}/${total}] ${label} → skipped (no Discogs auth)`)
      continue
    }
    try {
      const { discogsMasterId } = await lookup(raw, consumerKey, consumerSecret)
      enriched.push({ ...raw, discogsMasterId, artFilename: `${raw.id}.jpg` })
      if (discogsMasterId != null) {
        hits += 1
        console.log(`[${n}/${total}] ${label} → master=${discogsMasterId}`)
      } else {
        misses += 1
        console.log(`[${n}/${total}] ${label} → no match`)
      }
    } catch (err) {
      errors += 1
      enriched.push({ ...raw, discogsMasterId: null, artFilename: `${raw.id}.jpg` })
      console.log(`[${n}/${total}] ${label} → error: ${(err as Error).message}`)
    }
    await sleep(RATE_LIMIT_MS)
  }

  if (consumerKey && consumerSecret) {
    console.log(
      `Discogs enrichment: ${hits} hits, ${misses} no-match, ${errors} errors / ${total} total`,
    )
  }

  return enriched
}
