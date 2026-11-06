/**
 * Where recordstoreday.co.uk links each event's list PDF. The PDF lives at an
 * unguessable storage URL, but the event page links it in plain HTML.
 */
export const UK_EVENT_PAGES: Record<string, { page: string; folder: string }> = {
  november: { page: 'https://www.recordstoreday.co.uk/black-friday', folder: 'black-friday' },
  april: { page: 'https://www.recordstoreday.co.uk/record-store-day', folder: 'record-store-day' },
}

const TIMEOUT_MS = 30_000

export interface UkPdfLink {
  url: string
  etag: string | null
  /** ISO timestamp from Last-Modified, or null when the server sent none. */
  lastModified: string | null
}

/** Every distinct catalogue PDF for `folder` linked from a page. Exported for tests. */
export function pdfLinks(html: string, folder: string): string[] {
  const re = new RegExp(
    `https://media\\.recordstoreday\\.co\\.uk/storage/v1/object/public/platform-documents/catalogue-pdfs/${folder}/[A-Za-z0-9-]+\\.pdf`,
    'g',
  )
  return [...new Set(html.match(re) ?? [])]
}

async function head(url: string, fetchImpl: typeof fetch): Promise<UkPdfLink> {
  const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} checking ${url}`)
  const lm = Date.parse(res.headers.get('last-modified') ?? '')
  return {
    url,
    etag: res.headers.get('etag'),
    lastModified: Number.isNaN(lm) ? null : new Date(lm).toISOString(),
  }
}

/**
 * The list PDF the season's UK event page links, newest first if it links
 * several; null when it links none (not published yet). Throws on network or
 * HTTP errors, and for a season kind with no known UK page.
 */
export async function discoverUkPdf(
  seasonId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UkPdfLink | null> {
  const kind = seasonId.split('-').slice(1).join('-')
  const event = UK_EVENT_PAGES[kind]
  if (!event) throw new Error(`no recordstoreday.co.uk event page known for ${seasonId}`)
  const res = await fetchImpl(event.page, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${event.page}`)
  const links = pdfLinks(await res.text(), event.folder)
  if (links.length === 0) return null
  const checked = await Promise.all(links.map((u) => head(u, fetchImpl)))
  return (
    checked.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''))[0] ?? null
  )
}
