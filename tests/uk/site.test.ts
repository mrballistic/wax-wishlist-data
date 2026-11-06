import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Release } from '../../scripts/types.js'
import {
  createUkSite,
  enrichFromUkSite,
  parseReleasePage,
  splitUkDescription,
  type UkPage,
  type UkSite,
} from '../../scripts/uk/site.js'
import { REPO_ROOT } from '../helpers/releases.js'

const SEASON = '2026-november'
const SABBATH_URL = 'https://www.recordstoreday.co.uk/release/black-sabbath-technical-ecstasy'

const exclusive = (
  id: string,
  artist: string,
  title: string,
  over: Partial<Release> = {},
): Release => ({
  id,
  artist,
  title,
  label: 'Lab',
  format: 'LP',
  category: 'exclusive',
  description: '',
  discogsMasterId: null,
  artFilename: `${id}.jpg`,
  regions: ['uk'],
  ...over,
})
const page = (artist: string, title: string, over: Partial<UkPage> = {}): UkPage => ({
  url: `https://www.recordstoreday.co.uk/release/${artist}-${title}`
    .toLowerCase()
    .replace(/ /g, '-'),
  artist,
  title,
  label: 'Lab',
  date: '2026-11-27',
  image: 'https://media.example/cover.webp',
  description: `About ${title}`,
  ...over,
})

let png: Buffer
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wwd-uksite-'))
  png ??= await sharp({ create: { width: 600, height: 600, channels: 3, background: '#c33' } })
    .png()
    .toBuffer()
})
const artPath = (id: string) => join(root, 'releases', SEASON, 'art', `${id}.jpg`)

function fakeSite(
  slugs: string[],
  pages: Record<string, UkPage | null>,
): UkSite & { page: ReturnType<typeof vi.fn> } {
  return {
    slugs: vi.fn(async () => slugs),
    page: vi.fn(async (slug: string) => pages[slug] ?? null),
    image: vi.fn(async () => png),
  }
}
const run = (releases: Release[], site: UkSite, dryRun = false) =>
  enrichFromUkSite(releases, { repoRoot: root, seasonId: SEASON, site, log: () => {}, dryRun })

describe('parseReleasePage', () => {
  it('reads the MusicAlbum JSON-LD from a real page', async () => {
    const html = await readFile(
      join(REPO_ROOT, 'tests/fixtures/uk-site/black-sabbath-technical-ecstasy.html'),
      'utf8',
    )
    expect(parseReleasePage(html, SABBATH_URL)).toEqual({
      url: SABBATH_URL,
      artist: 'Black Sabbath',
      title: 'Technical Ecstasy',
      label: 'BMG',
      date: '2026-11-27',
      image:
        'https://media.recordstoreday.co.uk/storage/v1/object/public/release-images/releaseCard/90105ef9-48be-4ba2-8614-9fe881e25e0b.webp',
      description: '40th anniversary 3-colour splatter vinyl edition.',
    })
  })

  it('returns null without a MusicAlbum block', () => {
    expect(
      parseReleasePage('<script type="application/ld+json">{"@type":"Organization"}</script>', 'u'),
    ).toBeNull()
    expect(
      parseReleasePage('<script type="application/ld+json">{not json</script>', 'u'),
    ).toBeNull()
  })
})

describe('splitUkDescription (shapes seen on the 2026 Black Friday pages)', () => {
  it('splits at a "Track list" heading and keeps side headings as entries', () => {
    const r = splitUkDescription(
      'x4 Black LP Vinyl - Recorded live in 1975, this 4-LP set captures the set.\n' +
        'Including “Jungleland” plus powerhouse hits\n“Born To Run” and more.\n' +
        'Track list\nSIDE A\n1. Night\n2. Tenth Avenue Freeze-Out\nCD Track list\nDISC 1\n1. Night',
    )
    expect(r.description).toBe(
      'x4 Black LP Vinyl - Recorded live in 1975, this 4-LP set captures the set.\n\n' +
        'Including “Jungleland” plus powerhouse hits “Born To Run” and more.',
    )
    expect(r.tracklist).toEqual([
      'SIDE A',
      '1. Night',
      '2. Tenth Avenue Freeze-Out',
      'CD Track list',
      'DISC 1',
      '1. Night',
    ])
  })

  it('reads "Tracklisting:" with unnumbered entries', () => {
    const r = splitUkDescription('Only 500 copies.\nTracklisting:\nSide A:\nCity Killer\nOne Stone')
    expect(r).toEqual({
      description: 'Only 500 copies.',
      tracklist: ['Side A:', 'City Killer', 'One Stone'],
    })
  })

  it('keeps an inline "Tracks - a, b, c" as one entry', () => {
    const r = splitUkDescription(
      "Yellow vinyl. Landmark album from 1954.\nTracks - Goza, Mambo Inn, Bernie's Tune",
    )
    expect(r).toEqual({
      description: 'Yellow vinyl. Landmark album from 1954.',
      tracklist: ["Goza, Mambo Inn, Bernie's Tune"],
    })
  })

  it('finds an unheaded numbered list at the end', () => {
    const r = splitUkDescription(
      'A garage classic.\nRecorded in 1966.\n1. GLORIA’S DREAM\n2. MIDNIGHT TRAIN\n3. BABY BLUE',
    )
    expect(r.description).toBe('A garage classic.\n\nRecorded in 1966.')
    expect(r.tracklist).toEqual(['1. GLORIA’S DREAM', '2. MIDNIGHT TRAIN', '3. BABY BLUE'])
  })

  it('leaves prose alone when there is no tracklist, even with a stray number', () => {
    expect(
      splitUkDescription('2LP set of the full concert (23.12.80)\n1. It sold out in an hour.'),
    ).toEqual({
      description: '2LP set of the full concert (23.12.80)\n\n1. It sold out in an hour.',
      tracklist: [],
    })
  })
})

describe('createUkSite', () => {
  it('lists release slugs from the sitemap and 404s to null', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/sitemap.xml')) {
        return new Response(
          '<urlset><url><loc>https://www.recordstoreday.co.uk/about</loc></url>' +
            '<url><loc>https://www.recordstoreday.co.uk/release/coral-butterfly-house-acoustic-version</loc></url></urlset>',
        )
      }
      return new Response('gone', { status: 404 })
    }) as unknown as typeof fetch
    const site = createUkSite(fetchImpl)
    expect(await site.slugs()).toEqual(['coral-butterfly-house-acoustic-version'])
    expect(await site.page('nope')).toBeNull()
  })
})

describe('enrichFromUkSite', () => {
  it('fills description, link and cover through the site’s own slug', async () => {
    const r = exclusive(
      'the-coral-butterfly-house-acoustic-version',
      'The Coral',
      'Butterfly House (Acoustic Version)',
    )
    const site = fakeSite(['coral-butterfly-house-acoustic-version', 'madness-one-step-beyond'], {
      'coral-butterfly-house-acoustic-version': page(
        'The Coral',
        'Butterfly House (Acoustic Version)',
        {
          url: 'https://www.recordstoreday.co.uk/release/coral-butterfly-house-acoustic-version',
        },
      ),
    })
    const res = await run([r], site)

    expect(res.releases[0]).toMatchObject({
      description: 'About Butterfly House (Acoustic Version)',
      rsdUrl: 'https://www.recordstoreday.co.uk/release/coral-butterfly-house-acoustic-version',
    })
    expect(res.art).toEqual([r.id])
    const meta = await sharp(await readFile(artPath(r.id))).metadata()
    expect(meta).toMatchObject({ format: 'jpeg', width: 600, height: 600 })
  })

  it('fills the tracklist split out of the description', async () => {
    const r = exclusive('bravo-yankee', 'Bravo', 'Yankee')
    const site = fakeSite(['bravo-yankee'], {
      'bravo-yankee': page('Bravo', 'Yankee', {
        description: 'Red vinyl.\nTrack list\n1. One\n2. Two',
      }),
    })
    const res = await run([r], site, true)
    expect(res.releases[0]).toMatchObject({
      description: 'Red vinyl.',
      tracklist: ['1. One', '2. Two'],
    })
  })

  it('rejects a shortlisted page for a different release and tries the next', async () => {
    const r = exclusive('doctor-who-the-day-of-the-troll', 'Doctor Who', 'The Day of the Troll')
    // Equal slug similarity, so the shortlist keeps sitemap order: the decoy first.
    const site = fakeSite(['doctor-who-day-of-the-troll', 'doctor-who-the-day-of-the-troll'], {
      'doctor-who-day-of-the-troll': page('Doctor Who', 'The Rising Night'),
      'doctor-who-the-day-of-the-troll': page('Doctor Who', 'The Day of the Troll'),
    })
    const res = await run([r], site)
    expect(site.page).toHaveBeenCalledTimes(2)
    expect(res.releases[0]?.description).toBe('About The Day of the Troll')
  })

  it('rejects a page from another year’s event', async () => {
    const r = exclusive('them-belfast-gypsies', 'Them', 'Belfast Gypsies')
    const site = fakeSite(['them-belfast-gypsies'], {
      'them-belfast-gypsies': page('Them', 'Belfast Gypsies', { date: '2024-04-20' }),
    })
    const res = await run([r], site)
    expect(res.notFound).toEqual([r.id])
    expect(res.releases[0]).toBe(r)
  })

  it('never replaces existing art or a filled field, and asks nothing for complete releases', async () => {
    const complete = exclusive('a-x', 'A', 'X', {
      description: 'Mine',
      rsdUrl: 'https://example.com/a',
    })
    const noDesc = exclusive('bravo-yankee', 'Bravo', 'Yankee')
    for (const id of ['a-x', 'bravo-yankee']) {
      await mkdir(join(root, 'releases', SEASON, 'art'), { recursive: true })
      await writeFile(artPath(id), 'existing')
    }
    const site = fakeSite(['bravo-yankee'], { 'bravo-yankee': page('Bravo', 'Yankee') })
    const res = await run([complete, noDesc], site)

    expect(site.page).toHaveBeenCalledTimes(1)
    expect(site.page).toHaveBeenCalledWith('bravo-yankee')
    expect(site.image).not.toHaveBeenCalled()
    expect(await readFile(artPath('bravo-yankee'), 'utf8')).toBe('existing')
    expect(res.releases).toEqual([
      complete,
      { ...noDesc, description: 'About Yankee', rsdUrl: page('Bravo', 'Yankee').url },
    ])
  })

  it('leaves US releases alone and makes no request when there are no UK exclusives', async () => {
    const site = fakeSite([], {})
    const us: Release = { ...exclusive('a-x', 'A', 'X'), regions: ['us', 'uk'] }
    const res = await run([us], site)
    expect(site.slugs).not.toHaveBeenCalled()
    expect(res.releases).toEqual([us])
  })

  it('returns the releases unchanged when the sitemap fails', async () => {
    const r = exclusive('a-x', 'A', 'X')
    const site: UkSite = {
      slugs: async () => {
        throw new Error('HTTP 503 fetching the UK sitemap')
      },
      page: async () => null,
      image: async () => png,
    }
    const res = await run([r], site)
    expect(res.releases).toEqual([r])
  })

  it('writes no art on a dry run', async () => {
    const r = exclusive('bravo-yankee', 'Bravo', 'Yankee')
    const site = fakeSite(['bravo-yankee'], { 'bravo-yankee': page('Bravo', 'Yankee') })
    const res = await run([r], site, true)
    expect(res.releases[0]?.description).toBe('About Yankee')
    expect(site.image).not.toHaveBeenCalled()
  })
})
