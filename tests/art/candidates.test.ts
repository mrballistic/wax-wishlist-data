import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ART_CANDIDATES_FILE, ArtCandidatesSchema, writeArtCandidates } from '../../scripts/art/candidates.js'
import type { ScoredCandidate } from '../../scripts/art/match.js'

const cand = (n: number, score: number, source: ScoredCandidate['source'] = 'rsd-bucket'): ScoredCandidate => ({
  source,
  key: `2025/pack/${n}.jpg`,
  imageUrl: `https://example.com/${n}.jpg`,
  thumbUrl: `https://example.com/${n}-t.jpg`,
  label: `${n}.jpg`,
  score,
})

describe('writeArtCandidates', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'art-candidates-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes entries sorted by release id with rounded scores, capped at 3', async () => {
    const suggestions = new Map<string, ScoredCandidate[]>([
      ['zz-release', [cand(1, 0.6666)]],
      ['aa-release', [cand(2, 0.8123, 'rsd-site'), cand(3, 0.7), cand(4, 0.6), cand(5, 0.55)]],
      ['empty', []],
    ])
    expect(await writeArtCandidates(dir, suggestions)).toBe('written')
    const parsed = ArtCandidatesSchema.parse(JSON.parse(await readFile(join(dir, ART_CANDIDATES_FILE), 'utf8')))
    expect(parsed.map((e) => e.releaseId)).toEqual(['aa-release', 'zz-release'])
    expect(parsed[0]?.candidates).toHaveLength(3)
    expect(parsed[0]?.candidates[0]).toEqual({
      source: 'rsd-site',
      imageUrl: 'https://example.com/2.jpg',
      thumbUrl: 'https://example.com/2-t.jpg',
      label: '2.jpg',
      score: 0.81,
    })
    expect(parsed[1]?.candidates[0]?.score).toBe(0.67)
  })

  it('deletes an existing file when nothing is left to suggest', async () => {
    const path = join(dir, ART_CANDIDATES_FILE)
    await writeFile(path, '[]\n')
    expect(await writeArtCandidates(dir, new Map())).toBe('deleted')
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await writeArtCandidates(dir, new Map())).toBe('unchanged')
  })

  it("returns 'unchanged' when the content is identical", async () => {
    const suggestions = new Map([['r1', [cand(1, 0.7)]]])
    expect(await writeArtCandidates(dir, suggestions)).toBe('written')
    expect(await writeArtCandidates(dir, suggestions)).toBe('unchanged')
  })

  it('rejects a candidate whose imageUrl is not a URL', async () => {
    const bad = { ...cand(1, 0.7), imageUrl: 'not a url' }
    await expect(writeArtCandidates(dir, new Map([['r1', [bad]]]))).rejects.toThrow()
    await expect(stat(join(dir, ART_CANDIDATES_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
