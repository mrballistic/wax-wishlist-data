# Art coverage — design

**Date:** 2026-10-01
**Status:** Implemented (2026-10-01)
**Scope:** Piece 2 of the data-pipeline rethink
**Target:** In production before the RSD Black Friday 2026 list drops (late October 2026)

## Context

Piece 1 (automatic season ingest) is live: the `watch-rsd` workflow publishes
new and revised lists to `main`. Art is still the weak spot.

- Automatic coverage at list drop is roughly 60–65%: 2025-april 207/309,
  2025-november 106/173, 2026-april about 227/353 before manual work.
- 2026-april reached 353/353 only because Todd pasted 126 image URLs into
  `wax-wishlist-art-admin` by hand, one form and one commit per release, 99
  of them on 2026-04-22.
- Re-running Discogs/MusicBrainz months later adds only 6–8%.

Two new sources were found on 2026-10-01:

1. **recordstoreday.com product images** are served from an open image CDN,
   `https://img.broadtime.com/Photo/<photoId>[:<size>]` (WebP; `:360`,
   `:800`, or no suffix for full size; `cache-control: max-age=31557600`).
   The images are RSD's official, stickered product shots. Photo ids are
   allocated in upload batches: `418467310484` (a-ha, *Analogue*, 2026-april)
   and `418467310726` (13th Floor Elevators) are about 240 apart, and
   neighbouring ids are other RSD releases. The images carry no metadata, so
   mapping a release to its photo id needs RSD's pages, and recordstoreday.com
   blocks plain requests at CloudFront (403, even for `robots.txt`). Todd chose
   Bright Data Web Unlocker for that, art only (decided during piece 1
   planning; the release list stays PDF-sourced).
2. **RSD's public S3 bucket** (already read by the watcher) held 521
   distributor artwork images for April 2025 under
   `2025/Artwork RSD 2025/<distributor>/…` (UMG, Rhino, Atlantic, The
   Orchard, …). Filenames are messy (`Alison Moyet copy.png`,
   `7 Doors Of Death (Original Motion Picture Soundtrack)_652799000213.jpg`).
   A rough filename match covers about half of the 102 April 2025 releases
   still missing art. There is no artwork folder for Black Friday 2025 or
   April 2026, so this source is opportunistic.

## Goals

- Near-full art coverage within a day of a list drop, with no human action in
  the common case (Todd's choice, 2026-10-01).
- When a human is needed, it takes a click per release, not a paste-and-commit
  per release.
- Never overwrite existing art (piece 0 rule) and never guess: an uncertain
  match becomes a suggestion, not a published image.

## Non-goals

- Changing the app-facing contract (`artFilename` is always `<id>.jpg`; the
  apps read `releases.json` and `art/` only).
- Scraping anything from recordstoreday.com beyond what's needed to map a
  release to its photo id. No release data comes from the site.
- Replacing Discogs or MusicBrainz; they stay as later tiers.
- Image-similarity or OCR matching.

## Cascade

Per release, first hit wins (unchanged rule: manual art always wins; an
existing file in `art/` is kept and no lookup runs):

1. `manual` — `manual-art/` (unchanged).
2. existing file in `releases/<season>/art/` — kept (unchanged).
3. **`rsd-site`** (new) — RSD product image via the season's site index.
4. **`rsd-bucket`** (new) — distributor artwork in the S3 bucket.
5. `discogs` (unchanged).
6. `musicbrainz` (unchanged).
7. `none`.

Official RSD art comes before Discogs because Discogs often returns the
generic master release, not the RSD variant.

Every new-tier image is normalized with sharp to a JPEG no larger than
800×800 (never upscaled, EXIF orientation applied, mozjpeg quality 85) and
written to `<id>.jpg`.

`ArtTier` gains `'rsd-site' | 'rsd-bucket'`; the coverage summary reports
them. `ArtTier` is internal, not part of the app contract.

## Matching (shared by `rsd-site` and `rsd-bucket`)

`scripts/art/match.ts`, pure functions:

- **Normalize:** NFKD, strip accents, lower-case, `&` → `and`, drop
  punctuation, drop filename noise (`copy`, `cover`, `front`, `final`,
  `us only`, `rsd`, `rsd25`-style tags, file extensions, standalone runs of
  8+ digits, which are barcodes), collapse whitespace.
- **Stopwords** are ignored when scoring: `the a an of and in on at to for
  with feat featuring live edition deluxe anniversary remastered vinyl lp
  ep cd picture disc sticker packshot art artwork 1lp 2lp`, ordinals
  (`25th`, `30th`), and single characters.
- **Score** (token sets after normalization and stopwords):
  - *Site entries* (separate artist and title): `0.4 × artistScore +
    0.6 × titleScore`, each part = |shared| ÷ |release-side tokens|.
  - *Bucket filenames* (one string), three shapes, evaluated in order:
    1. *Artist + title:* the filename contains at least half of the
       release's artist tokens and at least one title token → score as a site
       entry, with the artist part taken from the shared artist tokens.
    2. *Artist only:* every filename token is an artist token and they cover
       at least half of the artist → score `0.9`, but only if that artist has
       exactly one release in the season; otherwise it can only be a
       suggestion (score `0.6`). Real examples: `Alison Moyet copy.png`,
       `Collective Soul_Cover.jpg`.
    3. *Title only:* score = |shared| ÷ |release title tokens|, and it must
       cover every title token to reach acceptance. One-word fragments
       (`Sweet copy.jpeg`) therefore become suggestions at most.
    4. *Partial artist:* every filename token is an artist token but they
       cover less than half of the artist (`gilmour.jpg` for David Gilmour
       with Romany Gilmour) → score `0.5`, a suggestion at most.
- **Accept** a candidate when its score is at least `0.85` and it beats the
  second-best candidate for that release by at least `0.15`. Otherwise, if
  the best score is at least `0.5`, record the top three as suggestions.
  Constants live in one exported object and are checked against the
  hand-labelled April 2025 fixture.
- **Duplicates:** candidates whose normalized names are identical (the same
  file in `01-ALL ART COMBINED/` and in a distributor folder) count as one
  image; the first key in listing order is used.
- **Foreign-artist guards (added 2026-10-01 after review):** site artist
  scores use shared ÷ max(candidate, release artist tokens), so `Pink Floyd`
  never fully matches `Pink`; a title-only filename is acceptable only when
  it has no tokens outside the release's artist and title; an artist-only
  filename scores `0.9` only when it covers the whole artist; and an
  accepted image is demoted when any *other* release in the whole season
  (not just those missing art) scores at least as high for it.
- **One image, one release:** if a candidate image is the accepted match for
  two releases, neither is accepted; both get it as a suggestion. Exception:
  releases whose ids differ only by a `-2`/`-3` suffix (the same title in two
  formats) may share an image.
- **Photo-id range check (`rsd-site` only):** once at least 10 releases in a
  season have accepted matches, compute the median photo id; an accepted match
  whose id is more than 20,000 from the median is demoted to a suggestion.

## `rsd-site` source

`scripts/art/rsd-site.ts`:

- **Fetching.** Through Bright Data Web Unlocker:
  `POST https://api.brightdata.com/request` with
  `Authorization: Bearer <BRIGHT_DATA_KEY>` and body
  `{ "zone": <BRIGHT_DATA_ZONE>, "url": <page>, "format": "raw" }`. The exact
  request shape is confirmed against the live API in the plan's first task. A
  missing key or zone disables the tier (logged once). Non-2xx, timeouts
  (60 s) and empty bodies are tier failures: logged, never thrown into the
  cascade.
- **Index.** Builds a per-run index of `{ artist, title, photoId, pageUrl }`
  for the season by fetching RSD's release listing for that event and parsing
  it. If the listing does not include photo ids, it fetches the individual
  release pages, but only for our releases that are still missing art after
  the earlier tiers, so the paid request count shrinks every day.
- **Parsing.** The site's markup is unknown until the Bright Data key exists.
  The plan's first task records real listing and release pages as test
  fixtures (`tests/fixtures/rsd-site/`), and the parser is written and tested
  against them. Photo ids are taken from `img.broadtime.com/Photo/<digits>`
  URLs in the markup.
- **Download.** `https://img.broadtime.com/Photo/<photoId>:800`, fetched
  directly (no Bright Data), then normalized to JPEG.
- **Budget.** A hard cap of 400 Unlocker requests per run (constant). Hitting
  it stops the tier for that run, logged.

### As built (2026-10-01)

Where this differs from the sections above, this is what shipped:

- **Site score:** `0.85 × (0.4a + 0.6t) + 0.15 × format` when both the
  listing row and the release have a format; format tokens drop quantity
  (`2 x LP` = `LP`, `2 x LP` ≠ `2 x CD`). Without a format on either side the
  score is `0.4a + 0.6t`.
- **Colour variants:** site rows identical in artist, title and format
  collapse to the row with the lowest photo id before matching.
- **Event ids:** `rsd-events.json` (season id → PromotionalEvent id) at the
  repo root; an unmapped season probes ids max+1..max+6 above the highest
  known id and logs the one it finds, to be added to the file.
- **Listing:** `PromotionalEvent/<id>?view=all`, parsed from the per-release
  quickview blocks (the plain URL is sometimes returned JS-rendered and
  paginated to 50 rows).
- **Season check:** a listing is used only when the majority of its quickview
  release dates (`M/D/YYYY`) fall in the season's month and year.
- **Completeness:** a listing with fewer entries than 80% of the season's
  releases is refetched once, then skipped; never matched partially.
- **Placeholder guard:** a photo id on rows for different releases
  (normalized artist + title) is dropped for all of them, logged once.
- **Tokens:** single letters are dropped but single digits are kept
  (`Vol. 1` ≠ `Vol. 2`). Two releases count as format variants (exempt from
  the owner check and the one-image rule) only when their ids differ solely
  by a trailing `-[2-9]` suffix **and** their normalized titles are identical.
- **Bucket tier:** after matching it probes one matched image and disables
  itself for the run when the bucket refuses it (401/403) or can't be
  reached; the 2025 art packs return 403, so the tier currently self-disables.

## `rsd-bucket` source

`scripts/art/rsd-bucket.ts`:

- Lists image keys (`.jpg`, `.jpeg`, `.png`, `.webp`, `.tif`, `.tiff`) under
  the season year's prefix (`<year>/`), excluding any path containing
  `/logos/` (case-insensitive) and macOS metadata (`.DS_Store`, `__MACOSX/`).
  Reuses `listPdfs`' listing code, generalized to a key filter.
- Matches by filename (the last path segment) using the shared matcher.
- Downloads via `objectUrl(key)` and normalizes to JPEG; images over 25 MB are
  skipped.
- Free: no credentials needed.

## Suggestions file

When a release still has no art after the cascade but the matcher produced
suggestions, the run writes `releases/<season>/art-candidates.json`:

```jsonc
[
  {
    "releaseId": "matchbox-twenty-mad-season-live-2001",
    "candidates": [
      {
        "source": "rsd-site",          // rsd-site | rsd-bucket
        "imageUrl": "https://img.broadtime.com/Photo/418467310999:800",
        "thumbUrl": "https://img.broadtime.com/Photo/418467310999:360",
        "label": "Matchbox Twenty – Mad Season (Live 2001)",
        "score": 0.78
      }
    ]
  }
]
```

- Rewritten each run; releases that now have art are removed. When no release
  has suggestions, the file is deleted.
- Validated by Zod in `validate.ts` when present. Not read by the apps.
- Committed alongside the art by the existing workflows.

## Daily art refresh

`refresh-art.yml` gains a daily schedule (14:00 UTC, after `watch-rsd`):

- Targets the season in `current.json` while its date is today or later
  (statuses `upcoming` or `active`). Past seasons are skipped. Manual dispatch
  with a `season-id` input keeps working for any season.
- Runs the cascade for empty slots only, writes `art-candidates.json`,
  validates, and commits with the existing push-retry loop
  (`chore: refresh art for <season-id>`).
- Keepalive step (`if: always()`, re-enables the workflow), as in
  `auto-status.yml`.
- `watch-rsd.yml`, `ingest.yml` and `refresh-art.yml` all pass
  `BRIGHT_DATA_KEY` and `BRIGHT_DATA_ZONE`.

## art-admin (`wax-wishlist-art-admin` repo)

- **Suggestions.** Reads `releases/<season>/art-candidates.json` over
  `raw.githubusercontent.com` (missing file = no suggestions). Each missing
  release with suggestions shows the top candidate's thumbnail, its label and
  score, and an **Accept** checkbox, plus links to the other candidates.
- **Batch save.** One **Save** button commits every accepted suggestion and
  every filled-in URL field in a single commit
  (`art: add N images`), using the Git Data API (blobs → tree → commit →
  update `main`). Per-row errors (fetch failure, not an image, over 10 MB) are
  reported next to the row; the rows that succeeded are still committed.
- **Normalization.** Images are converted with sharp to the same JPEG
  (≤800×800, quality 85) before committing, so a WebP from the CDN never lands
  in a `.jpg` slot.
- The pasted-URL field and Basic Auth gate stay as they are.

## Error handling

- Art never blocks a publish. Any tier failure leaves the slot for later tiers,
  later days, or art-admin.
- Bright Data down, blocked, out of budget, or unconfigured: `rsd-site` is
  skipped with one log line; the other tiers run.
- A bad accepted match is fixable by deleting the file (git revert) and
  pasting the right image in art-admin; the cascade never overwrites an
  existing file.

## Secrets

| Secret | Required | Use |
|---|---|---|
| `BRIGHT_DATA_KEY` | Recommended | Web Unlocker API key (`rsd-site` tier) |
| `BRIGHT_DATA_ZONE` | With the key | Web Unlocker zone name |

art-admin needs no new secrets.

## Testing

- **Matcher:** unit tests on normalization and scoring, plus fixture tests:
  a hand-labelled sample of real April 2025 bucket filenames against
  2025-april releases (true matches accepted, near-misses suggested, unrelated
  files rejected), the one-image-two-releases rule, and the photo-id range
  check.
- **`rsd-site`:** parser tests against the recorded fixtures; Unlocker client
  tests with msw (request shape, auth header, non-2xx, timeout, missing key,
  budget cap). No network in tests.
- **`rsd-bucket`:** key filtering (logos, `.DS_Store`, extensions) and
  matching against a recorded listing.
- **Cascade:** tier order (manual and existing files still win; rsd-site
  before rsd-bucket before discogs), JPEG normalization, and
  `art-candidates.json` written, updated and deleted.
- **Workflow:** `actionlint`.
- **art-admin:** a small vitest suite for the candidate-file parsing and the
  batch-commit builder (with a mocked Octokit); `next build` and typecheck.
- **Live check (manual, before relying on it):** run the cascade in dry-run
  against 2026-april with its art directory emptied in a temp copy, and report
  per-tier counts and the number of suggestions. 2026-april has 353
  hand-verified images, so accepted `rsd-site` matches can be spot-checked
  against them.

## Rollout

1. Matcher, `rsd-bucket`, cascade changes and `art-candidates.json` (no
   Bright Data needed).
2. Bright Data client and the fixture-recording task, as soon as the key is
   available; then the `rsd-site` parser and tier.
3. Daily `refresh-art` schedule.
4. art-admin suggestions and batch save.
5. Live check against 2026-april, then rely on it for Black Friday 2026.

## Open risks

- **Site markup and listing shape are unknown** until the key exists. Mitigated
  by recording fixtures first and keeping per-release page fetching as the
  fallback.
- **RSD posts art after the PDF.** The daily refresh keeps catching up until
  event day.
- **The matcher's thresholds are a guess until fixtures exist.** They're
  constants, tuned in the plan against real data, and anything below the bar
  becomes a suggestion rather than a published image.
- **Bright Data cost.** Capped per run; the per-release fallback only runs for
  releases still missing art.
