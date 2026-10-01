// Dev tool: fetch one recordstoreday.com page through Bright Data Web Unlocker and
// save the raw HTML, for recording parser fixtures under tests/fixtures/rsd-site/.
// Usage: pnpm tsx --env-file=.env scripts/art/record-rsd-pages.ts <url> <out-file>
// Each run costs exactly one Unlocker request. The key is never printed.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { unlockerFromEnv } from './brightdata.js'

async function main(): Promise<void> {
  const [url, outFile] = process.argv.slice(2)
  if (!url || !outFile) {
    console.error('usage: record-rsd-pages.ts <url> <out-file>')
    process.exit(2)
  }
  const unlocker = unlockerFromEnv()
  if (!unlocker) {
    console.error('BRIGHT_DATA_KEY and BRIGHT_DATA_ZONE must both be set (use --env-file=.env)')
    process.exit(2)
  }
  const html = await unlocker.fetchPage(url)
  const out = resolve(process.cwd(), outFile)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, html)
  console.log(`saved ${html.length} chars from ${url} to ${outFile} (${unlocker.requestsMade()} request)`)
}

main().catch((err: unknown) => {
  // Error messages from brightdata.ts carry the URL and status, never the key.
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
