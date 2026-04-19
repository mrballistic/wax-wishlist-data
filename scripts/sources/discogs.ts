import { stripEditionSuffix } from '../title-variants.js'
import type { ArtLookupResult, ArtSource, RawRelease } from '../types.js'

const DISCOGS_SEARCH_URL = 'https://api.discogs.com/database/search'
const USER_AGENT =
  'wax-wishlist-data/0.1 (+https://github.com/mrballistic/wax-wishlist-data)'

interface DiscogsSearchHit {
  master_id?: number
  id?: number
  cover_image?: string
  thumb?: string
}

interface DiscogsSearchResponse {
  results?: DiscogsSearchHit[]
}

export interface DiscogsSourceOptions {
  /** Discogs application consumer key. Paired with {@link consumerSecret}. */
  consumerKey?: string | undefined
  /** Discogs application consumer secret. Paired with {@link consumerKey}. */
  consumerSecret?: string | undefined
  /** Override the fetch implementation (for tests). */
  fetchImpl?: typeof fetch
}

/**
 * Tier 1 source: Discogs Search API.
 *
 * Authenticated with Discogs Auth (key+secret pair) — the simpler of the two
 * Discogs auth modes, and the only one that works for a headless CI runner
 * (no user redirect for the 3-legged OAuth flow). If either credential is
 * missing, the source short-circuits to no-match.
 *
 * Looks up the release by artist + title, takes the first hit, and uses its
 * `cover_image` URL as the art source. The cascade orchestrator is responsible
 * for downloading the image bytes via that URL — this source only returns a
 * URL and the derived `artFilename`.
 */
export function createDiscogsSource(options: DiscogsSourceOptions = {}): ArtSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const { consumerKey, consumerSecret } = options

  async function searchForHit(
    artist: string,
    title: string,
  ): Promise<DiscogsSearchHit | null> {
    const url = new URL(DISCOGS_SEARCH_URL)
    url.searchParams.set('artist', artist)
    url.searchParams.set('release_title', title)
    url.searchParams.set('type', 'master')
    url.searchParams.set('per_page', '1')

    let res: Response
    try {
      res = await fetchImpl(url, {
        headers: {
          Authorization: `Discogs key=${consumerKey}, secret=${consumerSecret}`,
          'User-Agent': USER_AGENT,
        },
      })
    } catch {
      return null
    }

    if (!res.ok) return null

    const body = (await res.json()) as DiscogsSearchResponse
    return body.results?.[0] ?? null
  }

  return {
    name: 'discogs',
    async lookup(release: RawRelease): Promise<ArtLookupResult | null> {
      if (!consumerKey || !consumerSecret) return null

      let hit = await searchForHit(release.artist, release.title)

      // On miss, retry once with an edition suffix stripped off the title
      // ("Album (Deluxe Edition)" → "Album"). Many master records are
      // filed under the bare title; the decorated forms are release-level.
      if (!hit || !(hit.cover_image ?? hit.thumb)) {
        const stripped = stripEditionSuffix(release.title)
        if (stripped) {
          hit = await searchForHit(release.artist, stripped)
        }
      }

      if (!hit) return null

      const coverUrl = hit.cover_image ?? hit.thumb ?? null
      if (!coverUrl) return null

      return {
        releaseId: release.id,
        tier: 'discogs',
        sourceUrl: coverUrl,
        artFilename: `${release.id}.jpg`,
      }
    },
  }
}
