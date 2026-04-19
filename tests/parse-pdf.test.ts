import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parsePdf } from '../scripts/parse-pdf.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

async function loadFixture(name: string): Promise<Buffer> {
  return await readFile(join(FIXTURE_DIR, name))
}

describe('parsePdf — real RSD PDF fixtures', () => {
  it('parses the 2026 April PDF into ≥340 structured releases', async () => {
    const pdf = await loadFixture('2026-april.pdf')
    const releases = await parsePdf(pdf)
    // Observed baseline: 353 valid releases out of 359 total category-marked
    // rows in the 2026-april PDF. 340 is a floor with headroom for
    // pdfjs-dist positional jitter; drop this if the floor starts triggering.
    expect(releases.length).toBeGreaterThanOrEqual(340)

    const categories = new Set(releases.map((r) => r.category))
    expect(categories).toEqual(new Set(['exclusive', 'rsd-first', 'small-run']))

    for (const r of releases) {
      expect(r.artist.length).toBeGreaterThan(0)
      expect(r.title.length).toBeGreaterThan(0)
      expect(r.label.length).toBeGreaterThan(0)
      expect(r.format.length).toBeGreaterThan(0)
      expect(r.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  it('parses the 2025 April PDF into ≥295 structured releases', async () => {
    const pdf = await loadFixture('2025-april.pdf')
    const releases = await parsePdf(pdf)
    // Observed baseline: 309 valid releases out of 325 total. Floor at 295.
    expect(releases.length).toBeGreaterThanOrEqual(295)
  })

  it('resolves known artist+title+label+format rows from 2026 April', async () => {
    const pdf = await loadFixture('2026-april.pdf')
    const releases = await parsePdf(pdf)
    const find = (artist: string, title: string) =>
      releases.find((r) => r.artist === artist && r.title === title)

    const aha = find('a-ha', 'Analogue 20th Anniversary Deluxe Edition')
    expect(aha).toBeDefined()
    expect(aha?.label).toBe('Rhino')
    expect(aha?.format).toBe('2 x LP')
    expect(aha?.category).toBe('exclusive')

    // Salvaged via splitLabelFormat: original row fused "Fuzze-Flex RecordsLP".
    const soul = find('Collective Soul', 'Touch and Go')
    expect(soul).toBeDefined()
    expect(soul?.label).toBe('Fuzze-Flex Records')
    expect(soul?.format).toBe('LP')
  })

  it('disambiguates duplicate (artist, title) pairs by appending a suffix', async () => {
    const pdf = await loadFixture('2026-april.pdf')
    const releases = await parsePdf(pdf)
    // Jeff Buckley "Live À L'Olympia" ships in both 2xLP and CD formats.
    const buckley = releases.filter(
      (r) => r.artist === 'Jeff Buckley' && r.title === "Live À L'Olympia",
    )
    expect(buckley.length).toBe(2)
    const ids = buckley.map((r) => r.id).sort()
    expect(ids[0]).toBe('jeff-buckley-live-a-lolympia')
    expect(ids[1]).toBe('jeff-buckley-live-a-lolympia-2')
  })

  it('emits unique ids across the whole season', async () => {
    const pdf = await loadFixture('2026-april.pdf')
    const releases = await parsePdf(pdf)
    const ids = new Set(releases.map((r) => r.id))
    expect(ids.size).toBe(releases.length)
  })

  it('dedupes byte-identical rows on the full product tuple', async () => {
    const pdf = await loadFixture('2026-april.pdf')
    const releases = await parsePdf(pdf)
    // No two releases in the same season should share (artist, title,
    // format, label, category). Distinct formats of the same title —
    // like Jeff Buckley's "Live À L'Olympia" in 2xLP and CD — survive
    // dedup because they differ on `format`.
    const tuples = releases.map((r) =>
      [r.artist, r.title, r.format, r.label, r.category].join('|'),
    )
    const uniqueTuples = new Set(tuples)
    expect(uniqueTuples.size).toBe(tuples.length)
  })
})
