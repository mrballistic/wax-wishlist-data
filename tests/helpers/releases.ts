import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ExtractedRow } from '../../scripts/extract/types.js'
import type { RawRelease } from '../../scripts/types.js'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const LETTER: Record<string, ExtractedRow['category']> = {
  exclusive: 'E',
  'small-run': 'L',
  'rsd-first': 'F',
}

/** A published season's releases.json, stripped to RawRelease fields. */
export async function loadRaw(seasonId: string): Promise<RawRelease[]> {
  const raw = await readFile(join(REPO_ROOT, 'releases', seasonId, 'releases.json'), 'utf8')
  const list = JSON.parse(raw) as (RawRelease & Record<string, unknown>)[]
  return list.map((r) => ({
    id: r.id,
    artist: r.artist,
    title: r.title,
    label: r.label,
    format: r.format,
    category: r.category,
    description: r.description,
  }))
}

/** Turn releases back into extractor rows (what a perfect extractor would return). */
export function toRows(releases: RawRelease[]): ExtractedRow[] {
  return releases.map((r) => ({
    category: LETTER[r.category] ?? 'E',
    artist: r.artist,
    title: r.title,
    label: r.label,
    format: r.format,
  }))
}

export function makeRelease(i: number, overrides: Partial<RawRelease> = {}): RawRelease {
  return {
    id: `artist-${i}-title-${i}`,
    artist: `Artist ${i}`,
    title: `Title ${i}`,
    label: 'Label',
    format: 'LP',
    category: 'exclusive',
    description: '',
    ...overrides,
  }
}
