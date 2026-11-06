import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { applyDiscogsOverrides, isPinned, loadDiscogsOverrides } from '../scripts/discogs-overrides.js'

const r = (id: string, discogsMasterId: number | null) => ({ id, discogsMasterId })

describe('applyDiscogsOverrides', () => {
  const o = { pin: { pinned: 7 }, reject: { wrong: [51329], pinned: [7] } }

  it('sets pinned masters, even over a found or rejected one', () => {
    expect(applyDiscogsOverrides([r('pinned', null), r('pinned', 99)], o)).toEqual([r('pinned', 7), r('pinned', 7)])
  })

  it('clears a rejected master and leaves other masters alone', () => {
    expect(applyDiscogsOverrides([r('wrong', 51329), r('wrong', 12), r('other', 51329)], o)).toEqual([
      r('wrong', null),
      r('wrong', 12),
      r('other', 51329),
    ])
  })

  it('returns the same object when nothing changes', () => {
    const same = r('other', 3)
    expect(applyDiscogsOverrides([same], o)[0]).toBe(same)
  })
})

describe('loadDiscogsOverrides', () => {
  it('is empty without the file and parses it when present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wwd-dov-'))
    expect(await loadDiscogsOverrides(root, '2026-november')).toEqual({ pin: {}, reject: {} })
    await mkdir(join(root, 'releases', '2026-november'), { recursive: true })
    await writeFile(join(root, 'releases', '2026-november', 'discogs-overrides.json'), '{"reject":{"a":[1]}}')
    const o = await loadDiscogsOverrides(root, '2026-november')
    expect(o).toEqual({ pin: {}, reject: { a: [1] } })
    expect(isPinned('a', o)).toBe(false)
  })

  it('rejects a malformed file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wwd-dov-'))
    await mkdir(join(root, 'releases', '2026-november'), { recursive: true })
    await writeFile(join(root, 'releases', '2026-november', 'discogs-overrides.json'), '{"pin":{"a":"x"}}')
    await expect(loadDiscogsOverrides(root, '2026-november')).rejects.toThrow()
  })
})
