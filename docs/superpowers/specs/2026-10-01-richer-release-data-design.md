# Richer release data — design

**Date:** 2026-10-01
**Status:** Approved in conversation (2026-10-01)
**Scope:** Piece 3 of the data-pipeline rethink
**Target:** Live before the RSD Black Friday 2026 list drops (late October 2026)

## Context

Pieces 1 (automatic ingest) and 2 (art coverage) are live. Piece 2 added an
`rsd-site` art tier that fetches each event's recordstoreday.com listing
through Bright Data Web Unlocker. Exploring that page on 2026-10-01 showed it
carries far more than art:

- `PromotionalEvent/<id>?view=all` (already fetched daily): per release, a
  quickview with artist, title, format, label, release type, a prose
  description ("MORE INFO") and a tracklist. 359 descriptions for April 2026.
- `PromotionalEvent/<id>` (the table page): per release, label, format,
  release type, quantity (pressing size) and the UPC in an HTML comment
  (`/UPC/<digits>`). 359 UPCs for April 2026.

Both shipped apps already display `description` when it's non-empty (iOS
`ReleaseDetailView`, Android Browse and PDF export), and both decode
`releases.json` leniently: Android uses `Json { ignoreUnknownKeys = true }`
and iOS uses synthesized `Decodable` on `ReleaseDTO`, so new optional keys
are ignored until the apps are updated.

The PDF parser drops rows it can't split. In Black Friday 2025, three real
releases are missing from the published list because RSD's PDF fuses artist
and title into one text item: two David Johansen and the Harry Smiths rows
(LP and SACD) and Larry June, 2 Chainz & The Alchemist, "Life Is Beautiful
(Chopped Not Slopped)". A fourth (Matchbox Twenty, "Mad Season (Live 2001)")
has a blank label in both the PDF and the site, so it can't be recovered.

Today only 152 of 353 April 2026 releases have a `discogsMasterId`, because
the Discogs lookup searches by artist and title.

## Decisions (Todd, 2026-10-01)

- Use recordstoreday.com for release data, not only art. The **PDF stays the
  source of truth for which releases exist**; the site fills descriptions and
  new fields, and repairs rows the PDF contains but the parser mangled.
- Add new optional fields to `releases.json` now; apps adopt them later.
- After it works, write a JSON contract document into the iOS and Android
  repos for their agents to pick up.

## Goals

- Every release that RSD describes gets its description in the apps, with no
  app update.
- Releases present in the PDF are no longer lost to fused artist/title text.
- Exact Discogs ids via barcode where RSD provides one.
- Tracklist, pressing quantity, UPC and the RSD page link available to the
  apps as optional fields.

## Non-goals

- Adding releases that aren't in the PDF (e.g. extra colour-variant rows the
  site lists separately).
- Changing any existing field's meaning, type or requiredness.
- App changes (the contract document hands those off).
- Overwriting values that are already set.

## Contract change (`releases.json`, additive)

`ReleaseSchema` gains four **optional** keys. Existing files without them stay
valid; absent and `null` both mean "unknown".

| Key | Type | Example | Source |
|---|---|---|---|
| `tracklist` | `string[]` (optional) | `["LP1:", "A1. CELICE (2026 REMASTER)", …]` | `?view=all` quickview, lines as printed, trimmed, blanks removed |
| `quantity` | positive integer or `null` (optional) | `2500` | table page quantity cell; non-numeric → `null` |
| `upc` | digit string (8–14) or `null` (optional) | `"075678604034"` | table page `/UPC/<digits>` comment |
| `rsdUrl` | URL or `null` (optional) | `"https://recordstoreday.com/SpecialRelease/19926"` | listing link |

`description` (existing, string) is filled with the quickview "MORE INFO" text:
plain text, HTML entities decoded, paragraph breaks kept as `\n\n`, the
"MORE INFO" heading and the tracklist excluded. RSD's own wording is kept
verbatim.

## Architecture

```
scripts/rsd/site-index.ts   fetch + parse both listing pages → SiteIndex (memoized per run)
scripts/rsd/repair.ts       repair parser-dropped / incomplete rows from the index (exact matches)
scripts/rsd/enrich.ts       fill description/tracklist/quantity/upc/rsdUrl from the index
scripts/enrich-discogs.ts   barcode-first lookup, then today's search
scripts/art/rsd-site.ts     art tier, now reading the shared SiteIndex
```

### Site index

- One module owns fetching and parsing recordstoreday.com: event resolution
  (`rsd-events.json` + probing), the `?view=all` page, date-vote season check,
  completeness check, placeholder-photo guard, and charset/mojibake handling,
  all moved from `rsd-site.ts`.
- `SiteEntry` gains `releaseId` (the `/SpecialRelease/<id>` number), `label`,
  `description`, `tracklist`, `quantity`, `upc`.
- The table page is fetched second and joined to the `?view=all` entries by
  `releaseId`, for `quantity` and `upc`. If the table fetch fails or comes back
  incomplete, those two fields are just absent; the rest of the index stands.
- Completeness uses an expected count passed by the caller (the season's
  release count, or the candidate row count at ingest).
- Memoized per process by season id: the art tier, repair and enrichment share
  one fetch. Normal cost: 2 Unlocker requests per run (up to 8 while probing an
  unmapped event id).

### Row repair (ingest, before ids)

- The parser keeps rows it currently skips for missing fields and returns them
  separately as *partial* rows, so unrepaired partial rows never count against
  the gate (behaviour without the site is unchanged).
- Repair, using exact normalized matching only (the art matcher's `normalize`):
  - **Fused artist + title:** a partial row whose artist cell equals a site
    entry's `artist + " " + title` (and whose title cell is empty) is split into
    that artist and title.
  - **Blank label or format:** filled from the site entry whose artist and
    title equal the row's, if the site value is non-empty.
- Repaired partial rows join the extracted rows before `finalizeRows`, so their
  ids come from the repaired artist and title. Repair also fills blank
  label/format on rows any extractor returned (Gemini/Claude rows included).
- Rows still incomplete after repair are handled exactly as today (parser:
  dropped; LLM rows: the gate's 2% drop-and-flag rule).
- Runs in `runWatch` and manual `ingest` before the cascade when Bright Data is
  configured and the season's event page resolves. Otherwise it's skipped.
- Known limit: if the site page doesn't exist yet at ingest time, partial rows
  aren't recovered until the next ingest of that season (a revision or a manual
  ingest).

### Enrichment (after the gate)

- Matches the season's releases against the site index with the art matcher's
  `matchReleases` (same "never guess" rules) over **all** releases, not just
  those missing art.
- For each accepted pair, fills `description`, `tracklist`, `quantity`, `upc`,
  `rsdUrl` **only where the release's value is empty** (`""`, `null`, absent).
- Discogs: when `upc` is known and `discogsMasterId` is null, search
  `database/search?barcode=<upc>&type=release` and take the first hit's
  `master_id`; otherwise today's artist/title search. Existing ids are never
  replaced.
- Runs at publish (inside `publishSeason`, before `writeReleases`) and in the
  daily refresh.

### Daily refresh

- `refresh-art.yml` keeps its schedule and season selection. Its script now
  runs enrichment and then the art cascade, rewrites `releases.json` only when
  a field changed, and stamps `current.json` `contentUpdatedAt` when that
  season is current, so the apps refetch.
- The commit stages `releases/<season>/` and `current.json`; message
  `chore: refresh art and data for <season-id>`.

## Error handling

- Site index unavailable (no key, blocked, incomplete, wrong season): repair and
  enrichment are skipped with one log line; publishing proceeds exactly as
  today.
- Enrichment and repair never throw out to the caller; a failure leaves fields
  empty for a later run.
- The contract is validated by Zod in `validate.ts` before every commit.

## Testing

- **Site index:** fixture tests on the recorded pages: descriptions and
  tracklists from `?view=all` (a-ha *Analogue* description starts "Analogue is
  a-ha's eighth studio album"), quantity and UPC from the table page joined by
  release id (Matchbox Twenty 3500 / `075678604034`), table-page failure leaves
  the rest intact, memoization (one fetch per season per run).
- **Repair:** the Black Friday 2025 PDF fixture plus the 599 listing recovers
  the two David Johansen and the Harry Smiths rows and the Larry June row with
  correct artist/title/label/format; Matchbox Twenty stays out (no label
  anywhere); no repair without the site; ids of repaired rows follow the
  artist+title rule.
- **Enrichment:** fills only empty fields; never overwrites; uses only accepted
  matches; barcode Discogs lookup with msw (hit, miss → fallback, existing id
  untouched).
- **Contract:** schema accepts files with and without the new keys; rejects a
  bad UPC, a non-positive quantity, a non-URL `rsdUrl`.
- **Refresh:** `releases.json` rewritten only on change; `contentUpdatedAt`
  stamped only when the season is current.
- **Live check:** against a temp copy of 2025-november: rows recovered, share of
  releases with a description, quantity, UPC, and `discogsMasterId` coverage
  before and after.

## Contract hand-off

When the live check passes, write `docs/data-contract/releases-json.md` (or the
repo's existing docs location) into `wax-wishlist-ios` and
`wax-wishlist-android`: every field of `releases.json` with type, nullability,
example and meaning, flagging the four new optional fields and the now-populated
`description`, plus decoding notes (unknown keys must stay ignored, all new keys
optional) and suggested UI uses (tracklist on the detail view, quantity as
"Limited to N", UPC for store lookup, a link to the RSD page). Committed locally
in each repo; pushing is Todd's call.

## Rollout

1. Site index extraction (no behaviour change for art).
2. Contract fields + validation.
3. Parser partial rows + repair wired into ingest.
4. Enrichment + barcode Discogs at publish.
5. Daily refresh writes data + stamps `contentUpdatedAt`.
6. Live check, docs, contract hand-off to both app repos.
