import { appendFile } from 'node:fs/promises'

/** Append markdown to the Actions step summary, or print it locally. */
export async function writeStepSummary(markdown: string): Promise<void> {
  const path = process.env['GITHUB_STEP_SUMMARY']
  if (path) await appendFile(path, `${markdown}\n\n`, 'utf8')
  else console.log(markdown)
}
