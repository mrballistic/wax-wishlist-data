import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { type Unlocker, UnlockerBudgetError } from '../../scripts/art/brightdata.js'
import {
  cleanText,
  createRsdSiteSource,
  eventUrl,
  isEventPage,
  listingSeason,
  loadRsdEvents,
  parseListing,
  parseReleasePage,
  photoUrl,
} from '../../scripts/art/rsd-site.js'
import type { RawRelease } from '../../scripts/types.js'
import { loadRaw, REPO_ROOT } from '../helpers/releases.js'

const FIXTURES = join(REPO_ROOT, 'tests/fixtures/rsd-site')
const fixture = (name: string): Promise<string> => readFile(join(FIXTURES, name), 'utf8')

const EVENTS = { '2024-november': 596, '2025-april': 597, '2025-november': 599, '2026-april': 601 }

/** Serves fixture HTML by URL; anything unknown is a soft 404 like the real site. */
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

let html601: string
let viewAll601: string
let rendered601: string
let html599: string
let html600: string
beforeAll(async () => {
  html601 = await fixture('promotional-event-601-rsd-2026.html')
  viewAll601 = await fixture('promotional-event-601-view-all.html')
  rendered601 = await fixture('live-601-rendered.html')
  html599 = await fixture('promotional-event-599-black-friday-2025.html')
  html600 = await fixture('promotional-event-600-not-found.html')
})

describe('parseListing', () => {
  it.each([
    ['table page', () => html601],
    ['?view=all page', () => viewAll601],
  ])('returns every release of the April 2026 listing (%s)', (_name, html) => {
    const entries = parseListing(html())
    expect(entries).toHaveLength(359)
    expect(entries[0]).toEqual({
      artist: '13th Floor Elevators',
      title: 'We Are Not Live',
      photoId: 418467310726,
      format: expect.any(String),
      pageUrl: expect.stringMatching(/^https:\/\/recordstoreday\.com\/SpecialRelease\/\d+$/),
    })
    expect(entries).toContainEqual({
      artist: 'A-Ha',
      title: 'Analogue 20th Anniversary Deluxe Edition',
      photoId: 418467310484,
      format: '2 x LP',
      pageUrl: 'https://recordstoreday.com/SpecialRelease/19926',
    })
    expect(new Set(entries.map((e) => e.photoId)).size).toBe(359)
  })

  it.each([
    ['table page', () => html601],
    ['?view=all page', () => viewAll601],
  ])('decodes entities, non-ASCII and line breaks (%s)', (_name, html) => {
    const entries = parseListing(html())
    const buckley = entries.filter((e) => e.artist === 'Jeff Buckley')
    expect(buckley.map((e) => [e.title, e.format, e.photoId])).toEqual([
      ["Live À L'Olympia", '2 x LP', 418467310333],
      ["Live À L'Olympia", 'CD', 418467310334],
    ])
    expect(entries.some((e) => e.artist === 'Captain Beefheart & The Magic Band')).toBe(true)
    for (const e of entries) {
      expect(e.artist).toBe(e.artist.trim())
      expect(e.title).not.toMatch(/&(amp|#39|nbsp);|\s{2,}|[\r\n\u00a0]/)
      expect(e.artist).not.toMatch(/&(amp|#39|nbsp);|\s{2,}|[\r\n\u00a0]/)
    }
  })

  it('repairs cells the site stored double-encoded (UTF-8 read as Windows-1252)', () => {
    const entries = parseListing(html599)
    expect(entries.some((e) => e.artist === 'Motörhead' && e.title === "Live at Brixton '87")).toBe(
      true,
    )
    expect(entries.some((e) => e.artist === 'Fred Again…')).toBe(true)
    expect(
      entries.some((e) => e.title === "And Then I Wrote… The First Three Albums Of The '90s"),
    ).toBe(true)
    expect(entries.some((e) => /[\u00c2\u00c3]/.test(e.artist + e.title))).toBe(false)
    expect(cleanText('Fran\u00e7oise H\u00e2rdy \u00c3')).toBe('Françoise Hârdy Ã')
  })

  it('never alters correct text whose accented capital is followed by punctuation', () => {
    expect(cleanText('CAF\u00c9\u2014LIVE')).toBe('CAF\u00c9\u2014LIVE')
    expect(cleanText('BEYONC\u00c9\u2122')).toBe('BEYONC\u00c9\u2122')
    expect(cleanText('Mot\u00c3\u00b6rhead')).toBe('Mot\u00f6rhead')
  })

  it('returns only the rows a JS-rendered page really has, without column confusion', () => {
    const entries = parseListing(rendered601)
    expect(entries).toHaveLength(50)
    expect(entries[0]).toMatchObject({
      artist: '13th Floor Elevators',
      title: 'We Are Not Live',
      format: 'LP',
    })
    expect(entries.filter((e) => /RSD|Exclusive|Limited/i.test(e.format))).toEqual([])
    const full = new Map(parseListing(viewAll601).map((e) => [e.photoId, e]))
    for (const e of entries) expect(full.get(e.photoId)).toEqual(e)
  })

  it('returns every row of the Black Friday 2025 listing and nothing for a soft 404', () => {
    expect(parseListing(html599)).toHaveLength(177)
    expect(parseListing(html600)).toEqual([])
  })
})

describe('event pages', () => {
  it('reads the season from the quickview release dates and tells real events from soft 404s', () => {
    expect(listingSeason(html601)).toBe('2026-april')
    expect(listingSeason(viewAll601)).toBe('2026-april')
    expect(listingSeason(rendered601)).toBe('2026-april')
    expect(listingSeason(html599)).toBe('2025-november')
    expect(listingSeason(html600)).toBeNull()
    expect(isEventPage(viewAll601)).toBe(true)
    expect(isEventPage(html601)).toBe(true)
    expect(isEventPage(html600)).toBe(false)
  })

  it('takes the majority date and rejects months that are not April or November', () => {
    const block = (date: string): string =>
      `<div class="quickview_image image"><a href="/SpecialRelease/1"><img src="https://img.broadtime.com/Photo/2:284" /></a></div>` +
      `<H2>A</h2><p><a href="/SpecialRelease/1"><em>T</em></a></p><strong>Date</strong>: ${date}<br/>`
    expect(
      listingSeason([block('11/28/2025'), block('11/28/2025'), block('4/18/2026')].join('')),
    ).toBe('2025-november')
    expect(listingSeason(block('6/14/2026'))).toBeNull()
  })

  it('fetches the unpaginated ?view=all listing', () => {
    expect(eventUrl(601)).toBe('https://recordstoreday.com/PromotionalEvent/601?view=all')
  })

  it('loads the committed rsd-events.json', async () => {
    expect(await loadRsdEvents(join(REPO_ROOT, 'rsd-events.json'))).toEqual(EVENTS)
    expect(await loadRsdEvents(join(REPO_ROOT, 'no-such-file.json'))).toEqual({})
  })
})

describe('parseReleasePage', () => {
  it('reads artist, title and photo id from each recorded release page', async () => {
    expect(
      parseReleasePage(
        await fixture('special-release-19926-a-ha-analogue.html'),
        'https://x/19926',
      ),
    ).toEqual({
      artist: 'A-Ha',
      title: 'Analogue 20th Anniversary Deluxe Edition',
      photoId: 418467310484,
      format: '2 x LP',
      pageUrl: 'https://x/19926',
    })
    expect(
      parseReleasePage(
        await fixture('special-release-19910-live-a-lolympia.html'),
        'https://x/19910',
      ),
    ).toEqual({
      artist: 'Jeff Buckley',
      title: "Live À L'Olympia",
      photoId: 418467310333,
      format: '2 x LP',
      pageUrl: 'https://x/19910',
    })
    expect(parseReleasePage(html600, 'https://x/600')).toBeNull()
  })
})

describe('photoUrl', () => {
  it('builds broadtime URLs', () => {
    expect(photoUrl(418467310484)).toBe('https://img.broadtime.com/Photo/418467310484:800')
    expect(photoUrl(418467310484, 360)).toBe('https://img.broadtime.com/Photo/418467310484:360')
  })
})

describe('createRsdSiteSource', () => {
  let april: RawRelease[]
  let november: RawRelease[]
  beforeAll(async () => {
    april = await loadRaw('2026-april')
    november = await loadRaw('2025-november')
  })

  it('matches most of 2026-april from the recorded ?view=all listing with one request', async () => {
    const unlocker = fakeUnlocker({ [eventUrl(601)]: viewAll601 }, html600)
    const log = vi.fn()
    const source = createRsdSiteSource({ seasonId: '2026-april', unlocker, events: EVENTS, log })
    await source.prepare(april, april)

    const accepted = april.filter((r) => source.accepted(r.id) !== null)
    console.log(`rsd-site 601 vs 2026-april: ${accepted.length} / ${april.length} accepted`)
    expect(accepted.length).toBeGreaterThanOrEqual(335)
    const aha = april.find((r) => /analogue/i.test(r.title) && /a-ha/i.test(r.artist))
    expect(aha && source.accepted(aha.id)).toMatchObject({
      source: 'rsd-site',
      key: 'photo:418467310484',
      photoId: 418467310484,
      imageUrl: 'https://img.broadtime.com/Photo/418467310484:800',
      thumbUrl: 'https://img.broadtime.com/Photo/418467310484:360',
    })
    expect(source.accepted('jeff-buckley-live-a-lolympia')?.photoId).toBe(418467310333)
    expect(source.accepted('jeff-buckley-live-a-lolympia-2')?.photoId).toBe(418467310334)
    expect(unlocker.urls).toEqual([eventUrl(601)])
  })

  it('matches most of 2025-november from the recorded Black Friday listing', async () => {
    const unlocker = fakeUnlocker({ [eventUrl(599)]: html599 }, html600)
    const source = createRsdSiteSource({
      seasonId: '2025-november',
      unlocker,
      events: EVENTS,
      log: vi.fn(),
    })
    await source.prepare(november, november)
    const accepted = november.filter((r) => source.accepted(r.id) !== null)
    console.log(`rsd-site 599 vs 2025-november: ${accepted.length} / ${november.length} accepted`)
    // "2 x LP" vs "2 x CD" rows of one title: each release takes its own format's photo.
    const dead = 'grateful-dead-the-warfield-san-francisco-ca-oct-4-6-1980'
    const lp = parseListing(html599).find(
      (e) => e.artist === 'Grateful Dead' && e.format === '2 x LP',
    )
    const cd = parseListing(html599).find(
      (e) => e.artist === 'Grateful Dead' && e.format === '2 x CD',
    )
    expect(lp && cd && lp.photoId !== cd.photoId).toBe(true)
    expect(source.accepted(dead)?.photoId).toBe(lp?.photoId)
    expect(source.accepted(`${dead}-2`)?.photoId).toBe(cd?.photoId)
    expect(source.accepted('bobby-womack-live-in-london')?.format).toBe('2 x LP')
    expect(source.accepted('bobby-womack-live-in-london-2')?.format).toBe('2 x CD')
    expect(accepted.length).toBeGreaterThanOrEqual(165)
  })

  it('still matches from the original table page', async () => {
    const unlocker = fakeUnlocker({ [eventUrl(601)]: html601 }, html600)
    const source = createRsdSiteSource({
      seasonId: '2026-april',
      unlocker,
      events: EVENTS,
      log: vi.fn(),
    })
    await source.prepare(april, april)
    const accepted = april.filter((r) => source.accepted(r.id) !== null)
    console.log(`rsd-site 601 table vs 2026-april: ${accepted.length} / ${april.length} accepted`)
    expect(accepted.length).toBeGreaterThanOrEqual(335)
  })

  it('retries an incomplete (JS-rendered) listing once, then skips without partial matching', async () => {
    const urls: string[] = []
    const unlocker: Unlocker = {
      async fetchPage(url: string): Promise<string> {
        urls.push(url)
        return rendered601
      },
      requestsMade: () => urls.length,
    }
    const log = vi.fn()
    const source = createRsdSiteSource({ seasonId: '2026-april', unlocker, events: EVENTS, log })
    await source.prepare(april, april)
    expect(urls).toEqual([eventUrl(601), eventUrl(601)])
    expect(log).toHaveBeenCalledWith(
      'rsd-site: listing for 2026-april looks incomplete (50 entries); skipping',
    )
    expect(
      april.some((r) => source.accepted(r.id) !== null || source.suggestions(r.id).length > 0),
    ).toBe(false)
  })

  it('uses the retry when it comes back complete', async () => {
    const pages = [rendered601, viewAll601]
    let calls = 0
    const unlocker: Unlocker = {
      async fetchPage(): Promise<string> {
        calls += 1
        return pages[calls - 1] ?? html600
      },
      requestsMade: () => calls,
    }
    const source = createRsdSiteSource({
      seasonId: '2026-april',
      unlocker,
      events: EVENTS,
      log: vi.fn(),
    })
    await source.prepare(april, april)
    expect(calls).toBe(2)
    expect(april.filter((r) => source.accepted(r.id) !== null).length).toBeGreaterThanOrEqual(335)
  })

  it('logs once and accepts nothing without Bright Data', async () => {
    const log = vi.fn()
    const source = createRsdSiteSource({
      seasonId: '2026-april',
      unlocker: null,
      events: EVENTS,
      log,
    })
    await source.prepare(april, april)
    await source.prepare(april, april)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('rsd-site: Bright Data not configured; skipping')
    expect(april.some((r) => source.accepted(r.id) !== null)).toBe(false)
  })

  it('skips a mapped event whose release dates are for another season', async () => {
    const unlocker = fakeUnlocker({ [eventUrl(601)]: html599 }, html600)
    const log = vi.fn()
    const source = createRsdSiteSource({ seasonId: '2026-april', unlocker, events: EVENTS, log })
    await source.prepare(april, april)
    expect(april.some((r) => source.accepted(r.id) !== null)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('2025-november'))
  })

  it('discovers an unmapped event by probing ids above the last known one', async () => {
    const unlocker = fakeUnlocker(
      { [eventUrl(599)]: html599, [eventUrl(601)]: viewAll601 },
      html600,
    )
    const log = vi.fn()
    const events = { '2024-november': 596, '2025-april': 597 }
    const source = createRsdSiteSource({ seasonId: '2026-april', unlocker, events, log })
    await source.prepare(april, april)
    // 598 and 600 are soft 404s, 599 is the wrong event.
    expect(unlocker.urls).toEqual([598, 599, 600, 601].map(eventUrl))
    expect(log).toHaveBeenCalledWith(
      'rsd-site: 2026-april is PromotionalEvent/601 — add it to rsd-events.json',
    )
    const aha = april.find((r) => /analogue/i.test(r.title) && /a-ha/i.test(r.artist))
    expect(aha && source.accepted(aha.id)?.photoId).toBe(418467310484)
  })

  it('gives up after six probes', async () => {
    const unlocker = fakeUnlocker({}, html600)
    const log = vi.fn()
    const source = createRsdSiteSource({ seasonId: '2026-november', unlocker, events: EVENTS, log })
    await source.prepare(april, april)
    expect(unlocker.urls).toEqual([602, 603, 604, 605, 606, 607].map(eventUrl))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no event found'))
  })

  it('stops at the Unlocker budget, logs it and does not throw', async () => {
    let calls = 0
    const unlocker: Unlocker = {
      async fetchPage(): Promise<string> {
        calls += 1
        if (calls >= 2) throw new UnlockerBudgetError('Bright Data budget of 1 requests reached')
        return html600
      },
      requestsMade: () => calls,
    }
    const log = vi.fn()
    const source = createRsdSiteSource({ seasonId: '2026-november', unlocker, events: EVENTS, log })
    await expect(source.prepare(april, april)).resolves.toBeUndefined()
    expect(calls).toBe(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('budget'))
    expect(april.some((r) => source.accepted(r.id) !== null)).toBe(false)
  })
})
