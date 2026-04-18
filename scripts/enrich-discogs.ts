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

interface DiscogsSearchResponse {
  results?: DiscogsSearchHit[]
}

async function lookup(
  release: RawRelease,
  consumerKey: string,
  consumerSecret: string,
): Promise<{ discogsMasterId: number | null }> {
  const url = new URL(DISCOGS_SEARCH_URL)
  url.searchParams.set('artist', release.artist)
  url.searchParams.set('release_title', release.title)
  url.searchParams.set('type', 'master')
  url.searchParams.set('per_page', '1')

  const res = await fetch(url, {
    headers: {
      Authorization: `Discogs key=${consumerKey}, secret=${consumerSecret}`,
      'User-Agent': 'wax-wishlist-data/0.1 (+https://github.com/mrballistic/wax-wishlist-data)',
    },
  })

  if (!res.ok) {
    return { discogsMasterId: null }
  }

  const body = (await res.json()) as DiscogsSearchResponse
  const first = body.results?.[0]
  const masterId = first?.master_id ?? first?.id ?? null
  return { discogsMasterId: masterId ?? null }
}

/**
 * Enrich raw releases with Discogs master IDs. Completely optional:
 * if either `DISCOGS_CONSUMER_KEY` or `DISCOGS_CONSUMER_SECRET` is unset, the
 * enricher returns a best-effort mapping with `discogsMasterId: null` and
 * `artFilename: null`. Callers then either ship the null or fill it in
 * via the art cascade's MusicBrainz / manual tiers.
 */
export async function enrichDiscogs(releases: RawRelease[]): Promise<Release[]> {
  const consumerKey = process.env['DISCOGS_CONSUMER_KEY']
  const consumerSecret = process.env['DISCOGS_CONSUMER_SECRET']
  const enriched: Release[] = []

  for (const raw of releases) {
    if (!consumerKey || !consumerSecret) {
      enriched.push({ ...raw, discogsMasterId: null, artFilename: null })
      continue
    }
    try {
      const { discogsMasterId } = await lookup(raw, consumerKey, consumerSecret)
      enriched.push({ ...raw, discogsMasterId, artFilename: `${raw.id}.jpg` })
    } catch {
      enriched.push({ ...raw, discogsMasterId: null, artFilename: null })
    }
    await sleep(RATE_LIMIT_MS)
  }

  return enriched
}
