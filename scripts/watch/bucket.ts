import type { BucketObject } from './sources.js'

/** RSD's public bucket. Anonymous ListObjectsV2 works as of 2026-09-30. */
export const BUCKET_URL = 'https://recordstoreday.s3.us-east-1.amazonaws.com/'

const TIMEOUT_MS = 60_000
const MAX_PAGES = 50

export class BucketError extends Error {
  override name = 'BucketError'
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)
  return m?.[1] !== undefined ? decodeXml(m[1]) : null
}

/** Parse one ListObjectsV2 page. Small, fixed schema, so no XML dependency. */
export function parseListing(xml: string): {
  objects: BucketObject[]
  isTruncated: boolean
  nextToken: string | null
} {
  if (!xml.includes('<ListBucketResult')) throw new BucketError('malformed listing: no ListBucketResult')
  const objects: BucketObject[] = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1] ?? ''
    const key = tag(block, 'Key')
    const etag = tag(block, 'ETag')
    const lastModified = tag(block, 'LastModified')
    if (!key || !etag || !lastModified) throw new BucketError('malformed listing: incomplete Contents entry')
    objects.push({ key, etag, lastModified, size: Number(tag(block, 'Size') ?? 0) })
  }
  return { objects, isTruncated: tag(xml, 'IsTruncated') === 'true', nextToken: tag(xml, 'NextContinuationToken') }
}

/** Every `.pdf` key under `prefix`, following pagination. */
export async function listPdfs(prefix: string, fetchImpl: typeof fetch = fetch): Promise<BucketObject[]> {
  const pdfs: BucketObject[] = []
  let token: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(BUCKET_URL)
    url.searchParams.set('list-type', '2')
    url.searchParams.set('prefix', prefix)
    if (token) url.searchParams.set('continuation-token', token)

    let res: Response
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      throw new BucketError(`network error listing ${prefix}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new BucketError(`HTTP ${res.status} listing ${prefix}`)

    const page = parseListing(await res.text())
    pdfs.push(...page.objects.filter((o) => o.key.toLowerCase().endsWith('.pdf')))
    if (!page.isTruncated) return pdfs
    if (!page.nextToken) throw new BucketError('malformed listing: truncated without a continuation token')
    token = page.nextToken
  }
  throw new BucketError(`listing ${prefix} exceeded ${MAX_PAGES} pages`)
}

/** Current year, plus next year from September 1 (the 2026/ prefix appeared 2025-09-15). */
export function prefixesFor(now: Date): string[] {
  const year = now.getUTCFullYear()
  return now.getUTCMonth() >= 8 ? [`${year}/`, `${year + 1}/`] : [`${year}/`]
}

export function objectUrl(key: string): string {
  return BUCKET_URL + key.split('/').map(encodeURIComponent).join('/')
}

export async function fetchPdf(key: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchImpl(objectUrl(key), { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${key}`)
  return Buffer.from(await res.arrayBuffer())
}
