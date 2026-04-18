import type { ArtLookupResult, ArtSource, RawRelease } from '../types.js'

/**
 * MusicBrainz requires a meaningful User-Agent with a contact string for all
 * non-trivial bots (FR-F-012). This constant is intentionally not env-var'd
 * so it survives CI runs without secret management.
 */
export const MUSICBRAINZ_USER_AGENT = 'WaxWishlistBot/1.0 (mrballistic@gmail.com)'

const MB_SEARCH_URL = 'https://musicbrainz.org/ws/2/release/'
const CAA_FRONT_URL = (mbid: string): string => `https://coverartarchive.org/release/${mbid}/front`

/** Score threshold from FR-F-008. Matches below this are treated as no-match. */
const MIN_SCORE = 90

/** MusicBrainz rate limit: 1 req/sec (FR-F-010). */
const RATE_LIMIT_MS = 1000

/** Retry policy (FR-F-011): up to 3 retries for 5xx, exponential backoff. */
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 1000

interface MBReleaseHit {
  id: string
  score: number
  title?: string
}

interface MBSearchResponse {
  releases?: MBReleaseHit[]
}

export interface MusicBrainzSourceOptions {
  /**
   * MetaBrainz Supporter / commercial access token. Optional.
   * When present, sent as `Authorization: Token <token>` on every MB request.
   * The 1 req/sec sleep (FR-F-010) is kept regardless so behavior is
   * identical whether the token is present or missing.
   *
   * NOTE (non-commercial Supporter tier): until the app's annual gross revenue
   * crosses MetaBrainz's commercial threshold ($500/year as of 2026), this
   * token is valid for non-commercial use. Upgrade required before the
   * threshold is crossed.
   */
  accessToken?: string | undefined
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch
  /** Inject sleep for tests (bypasses real timers). */
  sleepImpl?: (ms: number) => Promise<void>
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Tier 2 source: MusicBrainz search → Cover Art Archive front cover.
 *
 * 1. Search MB for "release:\"<title>\" AND artist:\"<artist>\"".
 * 2. Filter hits to `score >= 90`; pick the first.
 * 3. Request `coverartarchive.org/release/<mbid>/front`. CAA returns a 307
 *    redirect to the image bytes on archive.org — the cascade orchestrator
 *    resolves that URL to bytes; we only return the CAA endpoint.
 *
 * Retry policy: HTTP 503 or 5xx retry up to 3x with exponential backoff
 * (1s, 2s, 4s). HTTP 4xx other than 503 is a no-match, not an error.
 *
 * Rate limit: 1 req/sec enforced via {@link sleepImpl} before every MB request.
 */
export function createMusicBrainzSource(
  options: MusicBrainzSourceOptions = {},
): ArtSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleepImpl ?? defaultSleep
  const { accessToken } = options

  async function requestMbWithRetry(url: URL): Promise<Response | null> {
    const headers: Record<string, string> = {
      'User-Agent': MUSICBRAINZ_USER_AGENT,
      Accept: 'application/json',
    }
    if (accessToken) {
      headers['Authorization'] = `Token ${accessToken}`
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      await sleep(RATE_LIMIT_MS)
      let res: Response
      try {
        res = await fetchImpl(url, { headers })
      } catch {
        if (attempt === MAX_RETRIES) return null
        await sleep(BASE_BACKOFF_MS * 2 ** attempt)
        continue
      }

      if (res.ok) return res
      if (res.status === 503 || res.status >= 500) {
        if (attempt === MAX_RETRIES) return null
        await sleep(BASE_BACKOFF_MS * 2 ** attempt)
        continue
      }
      // 4xx other than 503 → no-match, not an error
      return res
    }
    return null
  }

  function buildMbQuery(release: RawRelease): URL {
    const url = new URL(MB_SEARCH_URL)
    // Escape double quotes in artist/title to keep the Lucene query well-formed.
    const title = release.title.replace(/"/g, '\\"')
    const artist = release.artist.replace(/"/g, '\\"')
    url.searchParams.set('query', `release:"${title}" AND artist:"${artist}"`)
    url.searchParams.set('fmt', 'json')
    url.searchParams.set('limit', '5')
    return url
  }

  async function searchReleaseMbid(release: RawRelease): Promise<string | null> {
    const url = buildMbQuery(release)
    const res = await requestMbWithRetry(url)
    if (!res || !res.ok) return null

    const body = (await res.json()) as MBSearchResponse
    const hits = body.releases ?? []
    const sorted = [...hits].sort((a, b) => b.score - a.score)
    const top = sorted[0]
    if (!top || top.score < MIN_SCORE) return null
    return top.id
  }

  async function checkCaaHasFront(mbid: string): Promise<string | null> {
    const caaUrl = CAA_FRONT_URL(mbid)
    let res: Response
    try {
      // `redirect: 'manual'` so we can treat the 307 as a positive signal
      // without spending bandwidth on the image bytes during lookup. The
      // orchestrator re-fetches the URL when it's time to write the file.
      res = await fetchImpl(caaUrl, { redirect: 'manual' })
    } catch {
      return null
    }
    // Both 200 (some proxies auto-follow) and 3xx (CAA's native redirect)
    // indicate the front cover exists.
    if (res.status === 200 || (res.status >= 300 && res.status < 400)) {
      return caaUrl
    }
    return null
  }

  return {
    name: 'musicbrainz',
    async lookup(release: RawRelease): Promise<ArtLookupResult | null> {
      const mbid = await searchReleaseMbid(release)
      if (!mbid) return null

      const caaUrl = await checkCaaHasFront(mbid)
      if (!caaUrl) return null

      return {
        releaseId: release.id,
        tier: 'musicbrainz',
        sourceUrl: caaUrl,
        artFilename: `${release.id}.jpg`,
      }
    },
  }
}
