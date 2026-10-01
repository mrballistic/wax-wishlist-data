import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  type BucketObject,
  loadSources,
  pendingObjects,
  saveSources,
  type SourceEntry,
  upsertSource,
} from '../../scripts/watch/sources.js'

const obj = (key: string, etag: string): BucketObject => ({
  key,
  etag,
  lastModified: '2026-10-01T00:00:00.000Z',
  size: 1,
})
const entry = (key: string, etag: string, outcome: SourceEntry['outcome']): SourceEntry => ({
  key,
  etag,
  lastModified: '2026-09-01T00:00:00.000Z',
  seasonId: '2026-april',
  outcome,
  extractor: null,
  processedAt: '2026-09-01T00:00:00.000Z',
})

describe('sources', () => {
  it('treats a missing file as empty', async () => {
    expect(await loadSources(join(tmpdir(), 'does-not-exist', 'sources.json'))).toEqual([])
  })

  it('propagates read errors other than a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wwd-sources-'))
    await expect(loadSources(dir)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('round-trips sorted by key and validates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wwd-sources-'))
    const path = join(dir, 'sources.json')
    await saveSources(path, [entry('b', '"2"', 'published'), entry('a', '"1"', 'superseded')])
    expect((await loadSources(path)).map((e) => e.key)).toEqual(['a', 'b'])
    expect(await readFile(path, 'utf8')).toMatch(/\n$/)
  })

  it('marks new, changed and failed keys pending', () => {
    const sources = [
      entry('same', '"1"', 'published'),
      entry('changed', '"1"', 'published'),
      entry('failed', '"1"', 'failed'),
    ]
    const pending = pendingObjects(
      [obj('same', '"1"'), obj('changed', '"2"'), obj('failed', '"1"'), obj('new', '"1"')],
      sources,
    )
    expect(pending.map((o) => o.key)).toEqual(['changed', 'failed', 'new'])
  })

  it('upserts by key', () => {
    const next = upsertSource([entry('a', '"1"', 'failed')], entry('a', '"2"', 'published'))
    expect(next).toHaveLength(1)
    expect(next[0]?.outcome).toBe('published')
  })
})
