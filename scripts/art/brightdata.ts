export const UNLOCKER_ENDPOINT = 'https://api.brightdata.com/request'
export const UNLOCKER_MAX_REQUESTS = 400
const TIMEOUT_MS = 60_000

export class UnlockerBudgetError extends Error {
  override name = 'UnlockerBudgetError'
}

export interface Unlocker {
  /** The page's HTML via Bright Data Web Unlocker. Throws on any failure. */
  fetchPage(url: string): Promise<string>
  requestsMade(): number
}

export interface UnlockerOptions {
  apiKey: string
  zone: string
  fetchImpl?: typeof fetch
  maxRequests?: number
}

export function createUnlocker(opts: UnlockerOptions): Unlocker {
  const max = opts.maxRequests ?? UNLOCKER_MAX_REQUESTS
  let made = 0
  return {
    async fetchPage(url: string): Promise<string> {
      if (made >= max) throw new UnlockerBudgetError(`Bright Data budget of ${max} requests reached`)
      made += 1
      // Resolved per call: msw patches global fetch after module load.
      const fetchImpl = opts.fetchImpl ?? fetch
      const res = await fetchImpl(UNLOCKER_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ zone: opts.zone, url, format: 'raw' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        const detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 160)
        throw new Error(`Bright Data returned HTTP ${res.status} for ${url}: ${detail}`)
      }
      const body = await res.text()
      if (!body.trim()) throw new Error(`Bright Data returned an empty page for ${url}`)
      return body
    },
    requestsMade: () => made,
  }
}

export function unlockerFromEnv(env: NodeJS.ProcessEnv = process.env): Unlocker | null {
  const apiKey = env['BRIGHT_DATA_KEY']
  const zone = env['BRIGHT_DATA_ZONE']
  return apiKey && zone ? createUnlocker({ apiKey, zone }) : null
}
