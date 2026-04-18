import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Download an art file from `url` into `destPath`. No-op if the file
 * already exists on disk (idempotent for re-runs of the ingest workflow).
 * Uses the native `fetch` available in Node 24.
 */
export async function downloadArt(url: string, destPath: string): Promise<'downloaded' | 'exists'> {
  if (await exists(destPath)) {
    return 'exists'
  }

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch art (${res.status}) from ${url}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(destPath), { recursive: true })
  await writeFile(destPath, buf)
  return 'downloaded'
}
