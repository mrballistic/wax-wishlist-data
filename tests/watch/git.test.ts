import { describe, expect, it } from 'vitest'

import { createGitOps, type Runner } from '../../scripts/watch/git.js'

/** Scripted runner: returns the first matching status for a command prefix. */
function scripted(rules: [string, number[]][]): { run: Runner; calls: string[] } {
  const calls: string[] = []
  const queues = new Map(rules.map(([prefix, statuses]) => [prefix, [...statuses]]))
  const run: Runner = (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    for (const [prefix, queue] of queues) {
      if (line.startsWith(prefix)) {
        const status = queue.length > 1 ? (queue.shift() ?? 0) : (queue[0] ?? 0)
        return { status, stdout: prefix === 'git rev-parse' ? 'abc1234\n' : '' }
      }
    }
    return { status: 0, stdout: '' }
  }
  return { run, calls }
}

describe('commitAndPush', () => {
  it('returns null without committing when nothing is staged', async () => {
    const { run, calls } = scripted([['git diff --staged --quiet', [0]]])
    expect(await createGitOps('/repo', run).commitAndPush('msg', ['sources.json'])).toBeNull()
    expect(calls.some((c) => c.startsWith('git commit'))).toBe(false)
  })

  it('validates, commits, rebases on a rejected push, and returns the sha', async () => {
    const { run, calls } = scripted([
      ['git diff --staged --quiet', [1]],
      ['git push', [1, 0]],
      ['git rev-parse', [0]],
    ])
    expect(await createGitOps('/repo', run).commitAndPush('chore: x', ['a', 'b'])).toBe('abc1234')
    expect(calls).toEqual([
      'pnpm -s tsx scripts/validate.ts',
      'git add -- a b',
      'git diff --staged --quiet',
      'git commit -m chore: x',
      'git push origin HEAD:main',
      'git pull --rebase origin main',
      'git push origin HEAD:main',
      'git rev-parse HEAD',
    ])
  })

  it('stops before staging when validation fails', async () => {
    const { run, calls } = scripted([['pnpm -s tsx scripts/validate.ts', [1]]])
    await expect(createGitOps('/repo', run).commitAndPush('m', ['a'])).rejects.toThrow(/validate/)
    expect(calls).toEqual(['pnpm -s tsx scripts/validate.ts'])
  })

  it('gives up after five rejected pushes', async () => {
    const { run } = scripted([
      ['git diff --staged --quiet', [1]],
      ['git push', [1]],
    ])
    await expect(createGitOps('/repo', run).commitAndPush('m', ['a'])).rejects.toThrow(/push retries/)
  })
})
