import { cp, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { loadGateContext, seasonKind } from '../../scripts/watch/season-context.js'
import { REPO_ROOT } from '../helpers/releases.js'

let repo: string
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'wwd-ctx-'))
  await cp(join(REPO_ROOT, 'seasons.json'), join(repo, 'seasons.json'))
  // releases.json only: the art directories are large and irrelevant here.
  for (const season of ['2025-april', '2025-november', '2026-april']) {
    await mkdir(join(repo, 'releases', season), { recursive: true })
    await cp(join(REPO_ROOT, 'releases', season, 'releases.json'), join(repo, 'releases', season, 'releases.json'))
  }
})

describe('seasonKind', () => {
  it('is the part after the year', () => {
    expect(seasonKind('2026-november')).toBe('november')
    expect(seasonKind('2027-april')).toBe('april')
  })
})

describe('loadGateContext', () => {
  it('treats an existing season as a revision', async () => {
    const ctx = await loadGateContext(repo, '2025-november')
    expect(ctx.previousSameSeason).toHaveLength(173)
  })

  it('compares a new season with the latest one of the same kind', async () => {
    expect(await loadGateContext(repo, '2026-november')).toEqual({
      previousSameSeason: null,
      lastComparableCount: 173,
    })
    expect((await loadGateContext(repo, '2027-april')).lastComparableCount).toBe(353)
  })

  it('returns nulls when there is nothing comparable', async () => {
    expect(await loadGateContext(repo, '2027-summer')).toEqual({
      previousSameSeason: null,
      lastComparableCount: null,
    })
  })
})
