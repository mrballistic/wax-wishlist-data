import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { defaultExtractors, runCascade } from './extract/index.js'
import { pdfTextLayer } from './extract/pdf-text.js'
import { publishSeason } from './watch/publish.js'
import { loadGateContext } from './watch/season-context.js'
import { writeStepSummary } from './watch/summary.js'

const REPO_ROOT = resolve(process.cwd())
const USAGE =
  'Usage: pnpm tsx scripts/ingest.ts <season-id> <pdfUrl-or-path> <yyyy-mm-dd> [--label="..."] [--dry-run]'

async function fetchPdfBuffer(source: string): Promise<Buffer> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source)
    if (!res.ok) {
      throw new Error(`Failed to fetch PDF (${res.status}) from ${source}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }
  return readFile(resolve(REPO_ROOT, source))
}

interface Args {
  seasonId: string
  pdfSource: string
  date: string
  label: string | undefined
  dryRun: boolean
}

function parseArgs(argv: string[]): Args | null {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const labelArg = argv.find((a) => a.startsWith('--label='))
  const [seasonId, pdfSource, date] = positional
  if (!seasonId || !pdfSource || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return {
    seasonId,
    pdfSource,
    date,
    label: labelArg ? labelArg.slice('--label='.length) || undefined : undefined,
    dryRun: argv.includes('--dry-run'),
  }
}

/**
 * Manual ingest. Same path as the watcher: extractor cascade → quality gate
 * → publish. A list the gate rejects is not written; the job fails with the
 * gate report so a human can look.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error(USAGE)
    process.exit(1)
    return
  }
  const { seasonId, pdfSource, date, label, dryRun } = args

  console.log(`Ingesting season=${seasonId} from ${pdfSource}${dryRun ? ' (dry run)' : ''}`)
  const pdf = await fetchPdfBuffer(pdfSource)
  const pdfText = await pdfTextLayer(pdf).catch(() => '')
  const context = await loadGateContext(REPO_ROOT, seasonId)
  const result = await runCascade({
    pdf,
    pdfText,
    extractors: defaultExtractors(),
    ...context,
    title: `${seasonId} from ${pdfSource}`,
  })
  await writeStepSummary(result.report)

  if (!result.passed || !result.releases) {
    console.error('No extractor produced a list that passes the quality gate. Nothing was written.')
    process.exit(1)
    return
  }
  if (dryRun) {
    console.log(`Dry run: would publish ${result.releases.length} releases (${result.extractor}).`)
    return
  }

  await publishSeason({ repoRoot: REPO_ROOT, seasonId, date, label, releases: result.releases })
  console.log(`Ingest complete: ${result.releases.length} releases via ${result.extractor}.`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
