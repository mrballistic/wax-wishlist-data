import type { ExtractorName } from '../extract/types.js'

import { BUCKET_URL, objectUrl } from './bucket.js'
import { loadSources, saveSources, upsertSource } from './sources.js'

const TIMEOUT_MS = 60_000

/** The bucket key for an RSD bucket URL (each path segment decoded); null for anything else. */
export function bucketKeyFromUrl(url: string): string | null {
  if (!url.startsWith(BUCKET_URL)) return null
  const path = url.slice(BUCKET_URL.length).replace(/[?#].*$/, '')
  if (!path) return null
  try {
    return path.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null // malformed percent-encoding
  }
}

export interface ManualPublishInput {
  /** The PDF URL or local path the manual ingest read. */
  pdfSource: string
  seasonId: string
  extractor: ExtractorName
  sourcesPath: string
  now?: () => Date
  log?: (line: string) => void
  fetchImpl?: typeof fetch
}

/**
 * After a manual ingest publishes from the RSD bucket, record the key in
 * sources.json the way the watcher would, so the next watcher run neither
 * re-fails it (fresh issue) nor republishes over the human's fix. Publishing
 * already succeeded, so a HEAD failure only warns.
 */
export async function recordManualPublish(
  input: ManualPublishInput,
): Promise<'recorded' | 'not-bucket' | 'head-failed'> {
  const log = input.log ?? ((line: string) => console.log(line))
  const key = bucketKeyFromUrl(input.pdfSource)
  if (!key) {
    log(`${input.pdfSource} is not an RSD bucket URL; the watcher won't know about this source.`)
    return 'not-bucket'
  }
  // Resolved per call, not at import: msw patches global fetch after module load.
  const fetchImpl = input.fetchImpl ?? fetch
  const warn = (why: string): 'head-failed' => {
    log(`Warning: could not record ${key} in sources.json (${why}); the next watcher run may process it again.`)
    return 'head-failed'
  }

  let res: Response
  try {
    res = await fetchImpl(objectUrl(key), { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    return warn(`HEAD failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) return warn(`HEAD returned HTTP ${res.status}`)
  const etag = res.headers.get('etag')
  const lastModifiedHeader = res.headers.get('last-modified')
  const lastModified = lastModifiedHeader ? new Date(lastModifiedHeader) : null
  if (!etag || !lastModified || Number.isNaN(lastModified.getTime())) {
    return warn('HEAD response lacked ETag or Last-Modified')
  }

  const now = input.now ?? (() => new Date())
  const sources = await loadSources(input.sourcesPath)
  await saveSources(
    input.sourcesPath,
    upsertSource(sources, {
      key,
      etag,
      lastModified: lastModified.toISOString(),
      seasonId: input.seasonId,
      outcome: 'published',
      extractor: input.extractor,
      processedAt: now().toISOString(),
    }),
  )
  log(`Recorded ${key} in sources.json.`)
  return 'recorded'
}
