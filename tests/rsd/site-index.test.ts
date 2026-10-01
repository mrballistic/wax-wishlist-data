import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Unlocker } from '../../scripts/art/brightdata.js'
import {
  eventUrl,
  fetchSiteIndex,
  getSiteIndex,
  parseListing,
  parseTablePage,
  resetSiteIndexCache,
  tableUrl,
} from '../../scripts/rsd/site-index.js'
import { REPO_ROOT } from '../helpers/releases.js'

const FIXTURES = join(REPO_ROOT, 'tests/fixtures/rsd-site')
const fixture = (name: string): Promise<string> => readFile(join(FIXTURES, name), 'utf8')

/** Serves fixture HTML by URL; anything unknown is the soft 404 like the real site. */
function fakeUnlocker(
  pages: Record<string, string>,
  notFound: string,
): Unlocker & { urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    async fetchPage(url: string): Promise<string> {
      urls.push(url)
      return pages[url] ?? notFound
    },
    requestsMade: () => urls.length,
  }
}

let viewAll601: string
let html601: string
let rendered601: string
let html599: string
let html600: string
beforeAll(async () => {
  viewAll601 = await fixture('promotional-event-601-view-all.html')
  html601 = await fixture('promotional-event-601-rsd-2026.html')
  rendered601 = await fixture('live-601-rendered.html')
  html599 = await fixture('promotional-event-599-black-friday-2025.html')
  html600 = await fixture('promotional-event-600-not-found.html')
})

beforeEach(() => {
  resetSiteIndexCache()
})

describe('parseListing', () => {
  it('reads release id, label, description and tracklist from each quickview', () => {
    const entries = parseListing(viewAll601)
    expect(entries).toHaveLength(359)
    const aha = entries.find((e) => e.releaseId === '19926')
    expect(aha).toMatchObject({
      artist: 'A-Ha',
      title: 'Analogue 20th Anniversary Deluxe Edition',
      photoId: 418467310484,
      format: '2 x LP',
      label: 'Rhino',
      pageUrl: 'https://recordstoreday.com/SpecialRelease/19926',
    })
    expect(aha?.description.startsWith("Analogue is a-ha's eighth studio album")).toBe(true)
    expect(aha?.description).not.toMatch(/MORE INFO|Tracklist/)
    expect(aha?.tracklist[0]).toBe('LP1:')
    expect(aha?.tracklist).toContain('A1. CELICE (2026 REMASTER)')
    expect(aha?.tracklist).toContain('D3. THE SUMMERS OF OUR YOUTH (2026 REMASTER)')
    expect(aha?.tracklist.every((l) => l === l.trim() && l !== '')).toBe(true)
  })

  it('copes with the other tracklist layouts and missing descriptions', () => {
    const byId = new Map(parseListing(viewAll601).map((e) => [e.releaseId, e]))
    // "TRACK LISTING:" heading in a <div>, sides split over several <div>s.
    const frusciante = byId.get('19936')
    expect(frusciante?.description).toBe(
      '25th Anniversary Double Vinyl Edition Includes 4 Bonus Tracks Pressed on Blue and Orange color vinyl Record Store Day Limited Edition',
    )
    expect(frusciante?.tracklist[0]).toBe('A1. GOING INSIDE')
    expect(frusciante?.tracklist).toContain('D4. BEGINNING AGAIN')
    // Heading in its own <p>, tracks one per <div>.
    expect(byId.get('20176')?.tracklist).toEqual([
      '1. Celestial Crown/Barael’s Blade',
      '2. Winter’s Wolves',
      '3. Iron Swan',
    ])
    // "Tracklist:" between <br><br> pairs inside one paragraph; a <style> block is ignored.
    const castaways = byId.get('20284')
    expect(castaways?.description).toMatch(/^Castaways by Johnny Blue Skies & The Dark Clouds/)
    expect(castaways?.description).not.toMatch(/mso|border|Tracklist/)
    expect(castaways?.tracklist).toEqual([
      '"A Whiter Shade of Pale" / "You Don\'t Miss Your Water"',
    ])
    // No MORE INFO block at all.
    expect(byId.get('20155')).toMatchObject({ description: '', tracklist: [] })
    // "Tracks:" heading between <br><br> pairs, sides in following paragraphs.
    const lucy = byId.get('20035')
    expect(lucy?.description).toMatch(/^Lucy Dacus shares her first song/)
    expect(lucy?.description).not.toMatch(/Tracks/)
    expect(lucy?.tracklist).toEqual(['Side A: Planting Tomatoes', 'Side B: Planting Tomatoes Demo'])
  })

  it('keeps paragraph breaks as blank lines', () => {
    const html =
      '<div class="quickview_image image"><a href="/SpecialRelease/7"><img src="https://img.broadtime.com/Photo/8:284" /></a></div>' +
      '<H2>Artist</h2><p><a href="/SpecialRelease/7"><em>Title</em></a></p><strong>Date</strong>: 4/18/2026<br/>' +
      '<div class="quickview_description description"><h3>MORE INFO</h3><p>First &amp; one.<br>Same para.<br><br></p>' +
      '<p>Second.</p><p>Tracklist<br>A1. One<br> <br>A2. Two</p></div><div class="caption">Not this</div>'
    expect(parseListing(html)).toEqual([
      {
        releaseId: '7',
        artist: 'Artist',
        title: 'Title',
        photoId: 8,
        format: '',
        label: '',
        description: 'First & one. Same para.\n\nSecond.',
        tracklist: ['A1. One', 'A2. Two'],
        pageUrl: 'https://recordstoreday.com/SpecialRelease/7',
      },
    ])
  })
})

describe('parseTablePage', () => {
  it('reads quantity and UPC per release from the server-rendered table', () => {
    const rows = parseTablePage(html599)
    expect(rows.size).toBe(177)
    expect(rows.get('19267')).toEqual({ quantity: 3500, upc: '075678604034' })
    expect(rows.get('19313')).toEqual({ quantity: 1500, upc: '4895241437960' })
    expect(parseTablePage(html601).size).toBe(359)
  })

  it('tolerates the JS-rendered table and pages without one', () => {
    const rows = parseTablePage(rendered601)
    expect(rows.size).toBeLessThanOrEqual(50)
    expect(parseTablePage(viewAll601).size).toBe(0)
    expect(parseTablePage(html600).size).toBe(0)
  })

  it('is the plain event URL', () => {
    expect(tableUrl(601)).toBe('https://recordstoreday.com/PromotionalEvent/601')
  })
})

describe('fetchSiteIndex', () => {
  it('joins quantity and UPC from the table page onto the listing entries', async () => {
    const unlocker = fakeUnlocker({ [eventUrl(599)]: html599, [tableUrl(599)]: html599 }, html600)
    const index = await fetchSiteIndex({
      seasonId: '2025-november',
      unlocker,
      expectedCount: 173,
      events: { '2025-november': 599 },
      log: vi.fn(),
    })
    expect(index?.seasonId).toBe('2025-november')
    expect(index?.eventId).toBe(599)
    expect(index?.entries).toHaveLength(177)
    expect(index?.entries.find((e) => e.artist === 'Matchbox Twenty')).toMatchObject({
      releaseId: '19267',
      quantity: 3500,
      upc: '075678604034',
    })
    expect(unlocker.urls).toEqual([eventUrl(599), tableUrl(599)])
  })

  it('retries an incomplete table once and keeps the listing with whatever joined', async () => {
    const unlocker = fakeUnlocker(
      { [eventUrl(601)]: viewAll601, [tableUrl(601)]: rendered601 },
      html600,
    )
    const index = await fetchSiteIndex({
      seasonId: '2026-april',
      unlocker,
      expectedCount: 353,
      events: { '2026-april': 601 },
      log: vi.fn(),
    })
    expect(unlocker.urls).toEqual([eventUrl(601), tableUrl(601), tableUrl(601)])
    expect(index?.entries).toHaveLength(359)
    const joined = index?.entries.filter((e) => e.quantity !== null || e.upc !== null) ?? []
    expect(joined.length).toBeLessThanOrEqual(50)
    expect(index?.entries.filter((e) => e.quantity === null && e.upc === null).length).toBe(
      359 - joined.length,
    )
    expect(index?.entries.find((e) => e.releaseId === '19926')?.description).toMatch(/^Analogue/)
  })

  it('keeps the listing when the table fetch throws twice', async () => {
    const urls: string[] = []
    const unlocker: Unlocker = {
      async fetchPage(url: string): Promise<string> {
        urls.push(url)
        if (url === tableUrl(601)) throw new Error('boom')
        return viewAll601
      },
      requestsMade: () => urls.length,
    }
    const log = vi.fn()
    const index = await fetchSiteIndex({
      seasonId: '2026-april',
      unlocker,
      expectedCount: 353,
      events: { '2026-april': 601 },
      log,
    })
    expect(urls).toEqual([eventUrl(601), tableUrl(601), tableUrl(601)])
    expect(index?.entries).toHaveLength(359)
    expect(index?.entries.every((e) => e.quantity === null && e.upc === null)).toBe(true)
  })

  it('returns null, logging, when the listing is incomplete or the fetch fails', async () => {
    const log = vi.fn()
    const short = fakeUnlocker({ [eventUrl(601)]: rendered601 }, html600)
    expect(
      await fetchSiteIndex({
        seasonId: '2026-april',
        unlocker: short,
        expectedCount: 353,
        events: { '2026-april': 601 },
        log,
      }),
    ).toBeNull()
    expect(short.urls).toEqual([eventUrl(601), eventUrl(601)])
    expect(log).toHaveBeenCalledWith(
      'rsd-site: listing for 2026-april looks incomplete (50 entries); skipping',
    )

    const failing: Unlocker = {
      fetchPage: () => Promise.reject(new Error('blocked')),
      requestsMade: () => 1,
    }
    await expect(
      fetchSiteIndex({
        seasonId: '2026-april',
        unlocker: failing,
        expectedCount: 353,
        events: { '2026-april': 601 },
        log,
      }),
    ).resolves.toBeNull()
    expect(log).toHaveBeenCalledWith('rsd-site: skipped (Error: blocked)')
  })

  it('applies no completeness floor when expectedCount is 0', async () => {
    const unlocker = fakeUnlocker(
      { [eventUrl(601)]: rendered601, [tableUrl(601)]: html601 },
      html600,
    )
    const index = await fetchSiteIndex({
      seasonId: '2026-april',
      unlocker,
      expectedCount: 0,
      events: { '2026-april': 601 },
      log: vi.fn(),
    })
    expect(index?.entries).toHaveLength(50)
    expect(unlocker.urls).toEqual([eventUrl(601), tableUrl(601)])
  })
})

describe('getSiteIndex', () => {
  it('fetches each page once per season per process', async () => {
    const unlocker = fakeUnlocker(
      { [eventUrl(601)]: viewAll601, [tableUrl(601)]: html601 },
      html600,
    )
    const opts = {
      seasonId: '2026-april',
      unlocker,
      expectedCount: 353,
      events: { '2026-april': 601 },
      log: vi.fn(),
    }
    const first = await getSiteIndex(opts)
    const second = await getSiteIndex(opts)
    expect(second).toBe(first)
    expect(unlocker.urls).toEqual([eventUrl(601), tableUrl(601)])
    expect(first?.entries.find((e) => e.releaseId === '19926')).toMatchObject({
      quantity: 2500,
      upc: '081227805869',
    })
  })

  it('returns null and logs once without an Unlocker', async () => {
    const log = vi.fn()
    const opts = { seasonId: '2026-april', unlocker: null, expectedCount: 353, events: {}, log }
    expect(await getSiteIndex(opts)).toBeNull()
    expect(await getSiteIndex(opts)).toBeNull()
    expect(await fetchSiteIndex(opts)).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('rsd-site: Bright Data not configured; skipping')
  })
})
