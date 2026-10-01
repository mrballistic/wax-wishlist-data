import { spawnSync } from 'node:child_process'

export type Runner = (cmd: string, args: string[]) => { status: number; stdout: string }

export interface GitOps {
  /** Validate, stage `paths`, commit, push with rebase retries. Returns the sha, or null if nothing changed. */
  commitAndPush(message: string, paths: string[]): Promise<string | null>
}

const PUSH_ATTEMPTS = 5

function defaultRunner(repoRoot: string): Runner {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    return { status: r.status ?? 1, stdout: r.stdout ?? '' }
  }
}

export function createGitOps(repoRoot: string, run: Runner = defaultRunner(repoRoot)): GitOps {
  const must = (cmd: string, args: string[], what: string): string => {
    const r = run(cmd, args)
    if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status})`)
    return r.stdout
  }
  return {
    async commitAndPush(message, paths) {
      must('pnpm', ['-s', 'tsx', 'scripts/validate.ts'], 'validate')
      must('git', ['add', '--', ...paths], 'git add')
      if (run('git', ['diff', '--staged', '--quiet']).status === 0) return null
      must('git', ['commit', '-m', message], 'git commit')
      // Same retry loop as the ingest/refresh-art workflows: survive
      // concurrent pushes (art-admin commits, auto-status).
      for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
        if (run('git', ['push', 'origin', 'HEAD:main']).status === 0) {
          return must('git', ['rev-parse', 'HEAD'], 'git rev-parse').trim()
        }
        if (attempt < PUSH_ATTEMPTS) must('git', ['pull', '--rebase', 'origin', 'main'], 'git pull --rebase')
      }
      throw new Error('Exhausted push retries')
    },
  }
}
