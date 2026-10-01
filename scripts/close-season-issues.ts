import { createGitHubIssueClient, seasonIssuePrefix } from './watch/issues.js'

/** After a manual ingest is pushed, close the watcher's open issues for that season. */
async function main(): Promise<void> {
  const [, , seasonId, sha] = process.argv
  const token = process.env['GITHUB_TOKEN']
  const repo = process.env['GITHUB_REPOSITORY']
  if (!seasonId || !sha || !token || !repo) {
    console.error('Usage: GITHUB_TOKEN=… GITHUB_REPOSITORY=… pnpm tsx scripts/close-season-issues.ts <season-id> <sha>')
    process.exit(1)
    return
  }
  const issues = createGitHubIssueClient({ token, repo })
  await issues.closeByPrefix(seasonIssuePrefix(seasonId), `Published by manual \`ingest\` in ${sha}.`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
