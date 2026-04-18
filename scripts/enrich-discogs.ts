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
  token: string,
): Promise<{ discogsMasterId: number | null }> {
  const url = new URL(DISCOGS_SEARCH_URL)
  url.searchParams.set('artist', release.artist)
  url.searchParams.set('release_title', release.title)
  url.searchParams.set('type', 'master')
  url.searchParams.set('per_page', '1')

  const res = await fetch(url, {
    headers: {
      Authorization: `Discogs token=${token}`,
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
 * if `DISCOGS_TOKEN` is not set, returns a best-effort mapping with
 * `discogsMasterId: null` and `artFilename: null`. Callers then either
 * ship the null or fill it in manually.
 */
export async function enrichDiscogs(releases: RawRelease[]): Promise<Release[]> {
  const token = process.env['DISCOGS_TOKEN']
  const enriched: Release[] = []

  for (const raw of releases) {
    if (!token) {
      enriched.push({ ...raw, discogsMasterId: null, artFilename: null })
      continue
    }
    try {
      const { discogsMasterId } = await lookup(raw, token)
      enriched.push({ ...raw, discogsMasterId, artFilename: `${raw.id}.jpg` })
    } catch {
      enriched.push({ ...raw, discogsMasterId: null, artFilename: null })
    }
    await sleep(RATE_LIMIT_MS)
  }

  return enriched
}
