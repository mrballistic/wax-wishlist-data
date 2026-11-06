import { slugify } from '../extract/finalize.js'
import {
  isUsRelease,
  type Region,
  type Release,
  type UkList,
  type UkOverrides,
  type UkRow,
} from '../types.js'

/** Stable key for a UK row, used by uk-overrides.json and in reports. */
export function ukRowKey(row: UkRow): string {
  return slugify(`${row.artist} ${row.title} ${row.format}`)
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'in',
  'at',
  'on',
  'from',
  'to',
  'edition',
  'anniversary',
  'deluxe',
  'expanded',
  'live',
  'lp',
  'vinyl',
  'version',
])

function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘"“”]/g, '')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim()
}

/** "Coral, The" / "Beatles (The)" / "The Coral" → "coral". */
function artistKey(artist: string): string {
  return norm(artist.replace(/^(.*),\s*the$/i, '$1').replace(/\s*\(the\)\s*/i, ' ')).replace(
    /^the\s+/,
    '',
  )
}

/** "Coral, The" / "Beatles (The)" → "The Coral" / "The Beatles", as the US list writes them. */
export function displayArtist(artist: string): string {
  const inverted = /^(.*),\s*the$/i.exec(artist) ?? /^(.*?)\s*\(the\)$/i.exec(artist)
  return inverted?.[1] ? `The ${inverted[1].trim()}` : artist
}

function tokens(s: string): string[] {
  return norm(s)
    .replace(/\bvol\b/g, 'volume')
    .split(' ')
    .filter((w) => w !== '' && !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w)))
}

/** "96" matches "1996"; otherwise exact. */
const tokenEq = (a: string, b: string): boolean =>
  a === b || (/^\d+$/.test(a) && /^\d+$/.test(b) && (a.endsWith(b) || b.endsWith(a)))

/** Share of the shorter token list found in the longer; exact string match when both are empty. */
function overlap(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === 0 || tb.length === 0) return norm(a) === norm(b) && norm(a) !== '' ? 1 : 0
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  return short.filter((t) => long.some((u) => tokenEq(t, u))).length / short.length
}

function artistSim(a: string, b: string): number {
  const x = artistKey(a)
  const y = artistKey(b)
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.9
  return overlap(x, y)
}

const VARIOUS = /^various( artists)?$/i
const formatGroup = (f: string): string => {
  const s = f.toLowerCase()
  if (s.includes('cd')) return 'cd'
  if (s.includes('7')) return '7'
  if (s.includes('10')) return '10'
  if (s.includes('12')) return '12'
  return 'lp'
}

/** Both artist and title must clear these for a pair to count as the same release. */
const MIN_ARTIST = 0.6
const MIN_TITLE = 0.5
/** Matches scoring below this are reported for a human to confirm. */
const CONFIDENT = 0.8

export interface Scored {
  score: number
  artist: number
  title: number
}

/** How alike a UK row and a US release are. Exported for tests. */
export function scorePair(uk: UkRow, us: Pick<Release, 'artist' | 'title' | 'format'>): Scored {
  let artist = artistSim(uk.artist, us.artist)
  let title = overlap(uk.title, us.title)
  // US compilations: "Various Artists — Mile End Kicks - Music Inspired by…"
  // where the UK list puts the compilation name in the artist column.
  if (VARIOUS.test(us.artist)) {
    artist = 1
    title = overlap(`${uk.artist} ${uk.title}`, us.title)
  }
  const bonus = formatGroup(uk.format) === formatGroup(us.format) ? 0.05 : 0
  return { score: (artist + title) / 2 + bonus, artist, title }
}

export interface UkMatch {
  key: string
  row: UkRow
  usId: string
  score: number
  via: 'auto' | 'override'
}

export interface UkMatchResult {
  matches: UkMatch[]
  ukOnly: { key: string; row: UkRow }[]
  /** Auto matches below the confidence bar: check these, then pin or reject in uk-overrides.json. */
  uncertain: UkMatch[]
  /** Override keys that named a missing UK row or US release. */
  staleOverrides: string[]
}

/**
 * Pair UK rows with US releases. Overrides first; then every remaining pair
 * that clears both minimums, best score first, each side used at most once
 * (so the UK's LP and CD of one title land on the US's LP and CD).
 */
export function matchUk(us: Release[], rows: UkRow[], overrides: UkOverrides): UkMatchResult {
  const usIds = new Set(us.map((r) => r.id))
  const keyed = rows.map((row) => ({ key: ukRowKey(row), row }))
  const rowKeys = new Set(keyed.map((k) => k.key))
  const staleOverrides = [
    ...Object.entries(overrides.match)
      .filter(([k, id]) => !rowKeys.has(k) || !usIds.has(id))
      .map(([k]) => k),
    ...overrides.ukOnly.filter((k) => !rowKeys.has(k)),
  ]

  const matches: UkMatch[] = []
  const usedUs = new Set<string>()
  const settled = new Set<string>(overrides.ukOnly)
  for (const { key, row } of keyed) {
    const id = overrides.match[key]
    if (id && usIds.has(id) && !settled.has(key)) {
      matches.push({ key, row, usId: id, score: 1, via: 'override' })
      usedUs.add(id)
      settled.add(key)
    }
  }

  const pairs: { k: (typeof keyed)[number]; usId: string; s: Scored }[] = []
  for (const k of keyed) {
    if (settled.has(k.key)) continue
    for (const r of us) {
      if (usedUs.has(r.id)) continue
      const s = scorePair(k.row, r)
      if (s.artist >= MIN_ARTIST && s.title >= MIN_TITLE) pairs.push({ k, usId: r.id, s })
    }
  }
  pairs.sort((a, b) => b.s.score - a.s.score)
  for (const { k, usId, s } of pairs) {
    if (settled.has(k.key) || usedUs.has(usId)) continue
    matches.push({
      key: k.key,
      row: k.row,
      usId,
      score: Math.round(s.score * 100) / 100,
      via: 'auto',
    })
    usedUs.add(usId)
    settled.add(k.key)
  }

  const matchedKeys = new Set(matches.map((m) => m.key))
  return {
    matches,
    ukOnly: keyed.filter((k) => !matchedKeys.has(k.key)),
    uncertain: matches.filter((m) => m.via === 'auto' && m.score < CONFIDENT),
    staleOverrides,
  }
}

/** Straight inch marks, as the US list and both apps' format tables use. */
const ukFormat = (f: string): string => f.replace(/[”″]/g, '"').replace(/\s+/g, ' ').trim()

/**
 * Apply a UK list to a season's releases. US releases (no regions, or
 * including `us`) get `["us"]` or `["us","uk"]`; UK rows with no US match
 * become UK-exclusive releases (`["uk"]`, category `exclusive`). Whatever an
 * earlier merge or enrichment already knew about a UK exclusive (Discogs id,
 * description, …) is kept via `previous`. With no UK list the US releases
 * are returned unchanged and UK exclusives are dropped.
 */
export function mergeUk(
  releases: Release[],
  uk: UkList | null,
  overrides: UkOverrides,
  previous: Map<string, Release> = new Map(),
): { releases: Release[]; result: UkMatchResult | null } {
  const us = releases.filter(isUsRelease)
  if (!uk) return { releases: us, result: null }

  const result = matchUk(us, uk.rows, overrides)
  const inUk = new Set(result.matches.map((m) => m.usId))
  const regions = (id: string): Region[] => (inUk.has(id) ? ['us', 'uk'] : ['us'])
  const tagged = us.map((r) => ({ ...r, regions: regions(r.id) }))

  const taken = new Set(tagged.map((r) => r.id))
  const exclusives = result.ukOnly.map(({ row }) => {
    const artist = displayArtist(row.artist)
    const base = slugify(`${artist} ${row.title}`)
    let id = taken.has(base) ? `${base}-uk` : base
    for (let n = 2; taken.has(id); n++) id = `${base}-uk-${n}`
    taken.add(id)
    const prev = previous.get(id)
    const release: Release = {
      ...(prev && prev.regions?.length === 1 && prev.regions[0] === 'uk' ? prev : {}),
      id,
      artist,
      title: row.title,
      label: row.label || 'Unknown',
      format: ukFormat(row.format),
      category: 'exclusive',
      description: prev?.description ?? '',
      discogsMasterId: prev?.discogsMasterId ?? null,
      artFilename: `${id}.jpg`,
      regions: ['uk'],
    }
    return release
  })
  return { releases: [...tagged, ...exclusives], result }
}

/** Markdown report of a merge, for the step summary and the CLI. */
export function formatUkReport(result: UkMatchResult, seasonId: string): string {
  const line = (m: UkMatch): string => `- \`${m.key}\` → \`${m.usId}\` (${m.score})`
  return [
    `## UK list for ${seasonId}`,
    '',
    `${result.matches.length} on both lists, ${result.ukOnly.length} UK exclusives.`,
    '',
    ...(result.uncertain.length > 0
      ? [
          '### Check these matches',
          '',
          'Pin a correct one under `match`, or list a wrong one under `ukOnly`, in `uk-overrides.json`.',
          '',
          ...result.uncertain.map(line),
          '',
        ]
      : []),
    ...(result.staleOverrides.length > 0
      ? ['### Stale overrides', '', ...result.staleOverrides.map((k) => `- \`${k}\``), '']
      : []),
    '### UK exclusives',
    '',
    ...result.ukOnly.map(
      ({ key, row }) => `- ${row.artist} — ${row.title} (${row.format}) \`${key}\``,
    ),
    '',
  ].join('\n')
}
