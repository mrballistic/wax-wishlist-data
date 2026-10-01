const API = 'https://api.github.com'
const MAX_BODY = 60_000

export const BUCKET_ISSUE_TITLE = 'watch-rsd: bucket unreachable'

export function etagShort(etag: string): string {
  return etag.replace(/"/g, '').slice(0, 8)
}

export function seasonIssuePrefix(seasonId: string): string {
  return `watch-rsd: could not publish ${seasonId} (`
}

export function failureIssueTitle(seasonId: string, etag: string): string {
  return `${seasonIssuePrefix(seasonId)}${etagShort(etag)})`
}

export interface IssueClient {
  /** Open an issue unless an open one already has this exact title. */
  ensure(title: string, body: string): Promise<void>
  /** Comment on and close open issues with this exact title. */
  close(title: string, comment: string): Promise<void>
  /** Comment on and close open issues whose title starts with `prefix`. */
  closeByPrefix(prefix: string, comment: string): Promise<void>
}

/** For dry runs: no issue side effects. */
export const noopIssueClient: IssueClient = {
  async ensure() {},
  async close() {},
  async closeByPrefix() {},
}

interface OpenIssue {
  number: number
  title: string
  pull_request?: unknown
}

export interface GitHubIssueOptions {
  token: string
  /** owner/name, e.g. GITHUB_REPOSITORY. */
  repo: string
  fetchImpl?: typeof fetch
}

export function createGitHubIssueClient(opts: GitHubIssueOptions): IssueClient {
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    // Resolved per call, not at creation: msw patches global fetch after module load.
    const fetchImpl = opts.fetchImpl ?? fetch
    const res = await fetchImpl(`${API}/repos/${opts.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'wax-wishlist-data/watch-rsd',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
    return res.json()
  }

  async function openIssues(): Promise<OpenIssue[]> {
    const all: OpenIssue[] = []
    for (let page = 1; page <= 20; page++) {
      const batch = (await call('GET', `/issues?state=open&per_page=100&page=${page}`)) as OpenIssue[]
      all.push(...batch.filter((i) => !i.pull_request))
      if (batch.length < 100) break
    }
    return all
  }

  async function closeWhere(match: (title: string) => boolean, comment: string): Promise<void> {
    for (const issue of (await openIssues()).filter((i) => match(i.title))) {
      await call('POST', `/issues/${issue.number}/comments`, { body: comment })
      await call('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' })
    }
  }

  return {
    async ensure(title, body) {
      if ((await openIssues()).some((i) => i.title === title)) return
      const trimmed = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n…(truncated)` : body
      await call('POST', '/issues', { title, body: trimmed })
    },
    close: (title, comment) => closeWhere((t) => t === title, comment),
    closeByPrefix: (prefix, comment) => closeWhere((t) => t.startsWith(prefix), comment),
  }
}
