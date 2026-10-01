import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { type Unlocker, UnlockerBudgetError } from '../../scripts/art/brightdata.js'
import {
  cleanText,
  createRsdSiteSource,
  eventName,
  eventUrl,
  expectedEventName,
  isEventPage,
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
let html599: string
let html600: string
beforeAll(async () => {
  html601 = await fixture('promotional-event-601-rsd-2026.html')
  html599 = await fixture('promotional-event-599-black-friday-2025.html')
  html600 = await fixture('promotional-event-600-not-found.html')
})

describe('parseListing', () => {
  it('returns every release row of the April 2026 listing', () => {
    const entries = parseListing(html601)
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

  it('decodes entities, non-ASCII and line breaks inside cells', () => {
    const entries = parseListing(html601)
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

  it('returns every row of the Black Friday 2025 listing and nothing for a soft 404', () => {
    expect(parseListing(html599)).toHaveLength(177)
    expect(parseListing(html600)).toEqual([])
  })
})

describe('event pages', () => {
  it('reads the anchor name and tells real events from soft 404s', () => {
    expect(eventName(html601)).toBe('RECORD STORE DAY 2026')
    expect(eventName(html599)).toBe('BLACK FRIDAY 2025')
    expect(isEventPage(html601)).toBe(true)
    expect(isEventPage(html600)).toBe(false)
  })

  it('maps season ids to event names and URLs', () => {
    expect(expectedEventName('2026-april')).toBe('RECORD STORE DAY 2026')
    expect(expectedEventName('2026-november')).toBe('BLACK FRIDAY 2026')
    expect(expectedEventName('2026-june')).toBeNull()
    expect(eventUrl(601)).toBe('https://recordstoreday.com/PromotionalEvent/601')
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

  it('matches most of 2026-april from the recorded listing with one request', async () => {
    const unlocker = fakeUnlocker({ [eventUrl(601)]: html601 }, html600)
    const log = vi.fn()
    const source = createRsdSiteSource({ seasonId: '2026-april', unlocker, events: EVENTS, log })
    await source.prepare(april, april)

    const accepted = april.filter((r) => source.accepted(r.id) !== null)
    console.log(`rsd-site 601 vs 2026-april: ${accepted.length} / ${april.length} accepted`)
    expect(accepted.length).toBeGreaterThanOrEqual(330)
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
    expect(accepted.length).toBeGreaterThanOrEqual(160)
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

  it('skips a mapped event whose anchor is for another season', async () => {
    const unlocker = fakeUnlocker({ [eventUrl(601)]: html599 }, html600)
    const log = vi.fn()
    const source = createRsdSiteSource({ seasonId: '2026-april', unlocker, events: EVENTS, log })
    await source.prepare(april, april)
    expect(april.some((r) => source.accepted(r.id) !== null)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('BLACK FRIDAY 2025'))
  })

  it('discovers an unmapped event by probing ids above the last known one', async () => {
    const unlocker = fakeUnlocker({ [eventUrl(599)]: html599, [eventUrl(601)]: html601 }, html600)
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
