# wax-wishlist-data

Public, static data pipeline for the consuming iOS app. This repository is a
fan-made project and is **not affiliated with, endorsed by, or sponsored by**
Record Store Day or any participating label, artist, or store.

The repo holds:

- Per-season release metadata JSON
- Album art assets
- TypeScript scripts that build those artifacts from a source PDF
- Zod schemas that guarantee the JSON shape matches the consuming iOS app's data contract

Artifacts are served via `raw.githubusercontent.com` — there is no backend,
no API, no analytics, no user data of any kind.

## Repository layout

```
current.json              # the active season (downloaded on app launch/refresh)
seasons.json              # history of all seasons, newest first
releases/
  <season-id>/
    releases.json         # full release list for the season
    art/                  # album art (one file per release, name matches artFilename)
scripts/                  # TypeScript ingestion + validation tooling
tests/                    # Vitest suite for schemas + generators
.github/workflows/        # validate / ingest / watch-rsd / status / art pipelines
```

## Data contract

The schemas in [`scripts/types.ts`](scripts/types.ts) are the single source
of truth for the JSON shape. They mirror the consuming iOS app's Swift
`Decodable` DTOs one-to-one. Renaming a field, changing a type, or adding
a required key here is a breaking change for every shipped version of the
app — treat the schema file as a public API.

All field names are camelCase: `releasesUrl`, `artBaseUrl`,
`discogsMasterId`, `artFilename`.

### `current.json`

```jsonc
{
  "id": "2026-april",
  "label": "April Drop 2026",
  "date": "2026-04-18",             // yyyy-MM-dd, parsed by the app
  "status": "upcoming",             // upcoming | active | past
  "releasesUrl": "https://...",     // absolute URL to releases.json
  "artBaseUrl": "https://..."       // absolute URL to the art/ directory, trailing slash
}
```

### `seasons.json`

Array of season objects in the same shape as `current.json`, newest first.
The app reads only the fields it needs; extra fields are ignored.

### `releases/<season-id>/releases.json`

Array of release objects:

```jsonc
{
  "id": "2026-april-001",
  "artist": "Azure Parallax",
  "title": "Low Tide at Dawn",
  "label": "Halcyon Pressing Co.",
  "format": "LP, 180g, Translucent Blue",
  "category": "Exclusive Release",
  "description": "Debut reissue on translucent blue vinyl, limited to 2,000 copies.",
  "discogsMasterId": 1048576,       // nullable
  "artFilename": "2026-april-001.jpg", // nullable; joined with artBaseUrl by the app
  "tracklist": ["A1. Low Tide", "B1. Dawn"],            // optional
  "quantity": 2000,                                     // optional, nullable
  "upc": "075678604034",                                // optional, nullable
  "rsdUrl": "https://recordstoreday.com/Release/12345"  // optional, nullable
}
```

`tracklist`, `quantity`, `upc` and `rsdUrl` are optional and additive: older
files without them stay valid, and the app can ignore them. All four come from
the release's page on recordstoreday.com. `tracklist` is one string per line as
printed there, `quantity` is the pressing size, `upc` is 8-14 digits, and
`rsdUrl` is the release page itself. `quantity`, `upc` and `rsdUrl` are `null`
when unknown. `description` is now populated from recordstoreday.com too.

## Prerequisites

- Node.js 24
- pnpm 10 (activate via `corepack enable`)

## Commands

```sh
pnpm install              # install dependencies
pnpm typecheck            # tsc --noEmit, strict
pnpm lint                 # eslint
pnpm test                 # vitest run
pnpm validate             # re-parse every JSON file through Zod
pnpm format               # prettier --write .
```

### Ingest a new season from a PDF

```sh
# Optional for Discogs master-id lookups; omit both to leave discogsMasterId null.
# Obtain a key/secret pair by registering an application at
# https://www.discogs.com/settings/developers
export DISCOGS_CONSUMER_KEY=...
export DISCOGS_CONSUMER_SECRET=...

pnpm tsx scripts/ingest.ts <season-id> <pdfUrl-or-local-path> <YYYY-MM-DD> [--label="..."] [--dry-run]
```

Runs the extractor cascade and quality gate, then writes
`releases/<season-id>/releases.json` (sorted stably by artist then title,
case-insensitive), fills empty art slots via the art cascade, and registers
the season (see [Season promotion flow](#season-promotion-flow)).

### Update season status

```sh
pnpm tsx scripts/update-status.ts <season-id> <upcoming|active|past>
```

Mutates `current.json` (if the id matches) and `seasons.json`. The consuming
app reads `status == "active"` to display its day-of banner.

### Bundle a season into the iOS build

The iOS release pipeline clones this repo at a pinned commit and runs:

```sh
pnpm tsx scripts/bundle-season.ts <season-id> <destination-dir>
```

This copies `releases.json` and the `art/` directory into the caller's
destination so the iOS app bundle can seed SwiftData on first launch with
zero network calls.

## Automatic ingest (`watch-rsd`)

A daily workflow (`.github/workflows/watch-rsd.yml`, 13:30 UTC) lists RSD's
public S3 bucket and ingests new or revised release-list PDFs with no human
step. Design: `docs/superpowers/specs/2026-09-30-automatic-season-ingest-design.md`.

- **Extraction:** the positional parser first, then Gemini Flash
  (`GEMINI_API_KEY`), then Claude (`ANTHROPIC_API_KEY`, optional). The first
  result that passes the quality gate wins. Gemini tries a chain of Flash
  models (`GEMINI_MODELS` in `scripts/extract/gemini.ts`), newest first,
  moving on when a model is overloaded.
- **Quality gate:** at least 25 complete rows, a size within 0.6–1.6× of the
  last same-kind season, bounded revisions (≤ 15% removed, ≤ 25% count
  change), and LLM rows that actually appear in the PDF's text. Rows missing
  an artist, title, label or format are dropped rather than published (up to
  2% of the list; more fails the gate) and listed in the report and in a
  `watch-rsd: <season-id> published without incomplete rows` issue.
- **Failures** publish nothing and open a `watch-rsd:` issue, which closes
  itself once the season is published (by the watcher or manual `ingest`).
- **State:** `sources.json` records every bucket PDF seen and what happened
  to it; `calendar.json` holds April dates (add each year's once RSD
  announces it; Black Friday is computed).
- **Publishing switch:** scheduled runs are dry runs (report in the step
  summary) unless the repository variable `WATCH_RSD_PUBLISH` is `true`.
  Manual runs take a `publish` checkbox and an `only` extractor choice:
  `all` (the full cascade, default), `parser`, `gemini` or `claude`. Choosing
  an LLM whose key isn't configured fails the run up front.

Local dry run (reads `.env` for `GEMINI_API_KEY`):

```sh
pnpm tsx --env-file=.env scripts/watch-rsd.ts --dry-run
pnpm tsx --env-file=.env scripts/watch-rsd.ts --dry-run --prefix=2025/ --sources=/tmp/sources.json --only=gemini
```

Manual `ingest` now takes the date as a third argument and runs the same
cascade and gate. When the PDF URL points into the RSD bucket, a successful
publish is also recorded in `sources.json`, so the watcher treats that PDF
as handled instead of retrying or republishing it:

```sh
pnpm tsx scripts/ingest.ts 2026-november <pdf-url-or-path> 2026-11-27 [--label="..."] [--dry-run]
```

Live-check one LLM extractor against a real PDF (spends API quota):

```sh
pnpm tsx --env-file=.env scripts/check-llm-extractors.ts gemini tests/fixtures/2025-november.pdf 2025-november
```

## Season promotion flow

1. A new PDF drops. **watch-rsd** picks it up on its next daily run and
   publishes it if it passes the gate. If it doesn't (or publishing is still
   switched off), run the **Actions -> ingest** workflow with the
   `season-id`, the PDF URL and the season `date` (`yyyy-MM-dd`; required).
2. Either path registers the season itself via `register-season`: the entry
   is upserted into `seasons.json` (new seasons start `upcoming`; an existing
   entry keeps its status), and `current.json` is pointed at it if its date
   is later than the current season's, or if it *is* the current season (a
   revision). Every `current.json` write stamps a fresh `contentUpdatedAt`.
   Registering an older season never touches `current.json`. Both commit
   `releases/<season-id>/`, `seasons.json`, `current.json` and `sources.json`
   back to `main`.
3. The daily **auto-status** workflow moves the season through
   `upcoming -> active -> past` as the calendar advances (**update-status**
   is the manual override).
4. The consuming iOS app polls `current.json` — a change in `id` prompts
   a download; a change in `status` updates silently.

## CI

- **validate.yml** — on every push and PR: `pnpm install`, lint, typecheck,
  tests, and schema validation of every shipped JSON file.
- **ingest.yml** — manual dispatch only. Inputs: `season-id`, `pdfUrl`,
  `date` (`yyyy-MM-dd`, required so the season can be registered) and an
  optional `label`. Runs `ingest.ts` (cascade, gate, publish,
  register-season), validates, commits back to `main`, and closes this
  season's `watch-rsd:` issues.
- **watch-rsd.yml** — daily cron (13:30 UTC) plus manual dispatch. Watches
  RSD's bucket and publishes new or revised lists; see
  [Automatic ingest](#automatic-ingest-watch-rsd). Dry run unless
  `WATCH_RSD_PUBLISH` is `true` (scheduled) or `publish` is ticked (manual).
- **update-status.yml** — manual dispatch only. Runs `update-status.ts`,
  validates, and commits back to `main`.
- **auto-status.yml** — daily cron. Recomputes every season's status from
  its date. Each run re-enables itself through the Actions API, which resets
  GitHub's 60-day inactivity timer for scheduled workflows.
- **refresh-art.yml** — daily cron (14:00 UTC) for the upcoming season,
  plus manual dispatch for any season. Re-runs the art cascade, filling only
  empty art slots, and rewrites `art-candidates.json`. Existing files
  (including ones committed by `wax-wishlist-art-admin`) are never
  overwritten. See [Album art](#album-art).

`artFilename` is always `<id>.jpg`: it names the release's art slot, not a
promise the file exists. `pnpm validate` prints per-season art coverage.

## Data Sources

Album art and release metadata in this repository are assembled from
several independent public sources, combined in a fallback cascade by
the ingest pipeline. Neither this repository nor the consuming Wax
Wishlist iOS app is affiliated with, endorsed by, or sponsored by any
of the organizations below.

| Tier | Source | Used for | Terms of Use |
|---|---|---|---|
| 1 | [Discogs API](https://www.discogs.com/developers) | Album art + master release IDs | [discogs.com/developers](https://www.discogs.com/developers) |
| 2 | [MusicBrainz](https://musicbrainz.org/) + [Cover Art Archive](https://coverartarchive.org/) | Album art fallback when Discogs has no match | [MusicBrainz License](https://metabrainz.org/license) · [CAA Terms](https://coverartarchive.org/) |
| 3 | `manual-art/` (hand-curated) | Maintainer-sourced overrides for specific releases — see [`manual-art/README.md`](manual-art/README.md) | — |
| 4 | RSD release list PDF | Release metadata (artist, title, format, etc.), parsed locally | [Record Store Day](https://recordstoreday.com/) |
| — | [recordstoreday.com](https://recordstoreday.com/) event listings + product images | Album art (`rsd-site` tier) | [Record Store Day](https://recordstoreday.com/) |
| — | RSD's public S3 bucket (distributor art packs) | Album art (`rsd-bucket` tier) | [Record Store Day](https://recordstoreday.com/) |

The tier numbers above are the historical labels used in the coverage
summary; the order the cascade actually tries sources in is described
under [Album art](#album-art). Releases with no match in any tier have no
file in their art slot and the iOS app renders its placeholder. See
[`docs/FEATURE_PRD_multi_source_art.md`](docs/FEATURE_PRD_multi_source_art.md)
and [`docs/superpowers/specs/2026-10-01-art-coverage-design.md`](docs/superpowers/specs/2026-10-01-art-coverage-design.md)
for the full specifications.

## Album art

Every release has one art slot, `releases/<season-id>/art/<id>.jpg`
(`artFilename` is always `<id>.jpg`, whether or not the file exists yet).
`scripts/fetch-art.ts` fills empty slots; it never overwrites a file that is
already there.

### Cascade order

Per release, the first tier that produces an image wins:

1. **manual** — a file in `manual-art/` named after the release id. Always
   wins, even over an existing file.
2. **existing file** — a file already in `art/` (an earlier run, or a
   `wax-wishlist-art-admin` commit) is kept, with no network lookups.
3. **`rsd-site`** — the product images on recordstoreday.com (see below).
4. **`rsd-bucket`** — distributor art packs in RSD's S3 bucket (see below).
5. **discogs** — Discogs API (`DISCOGS_CONSUMER_KEY` +
   `DISCOGS_CONSUMER_SECRET`; skipped without both).
6. **musicbrainz** — MusicBrainz + Cover Art Archive
   (`METABRAINZ_ACCESS_TOKEN` optional; works anonymously at 1 req/s).
7. **none** — the slot stays empty and the app shows its placeholder.

The two RSD tiers are matched across the whole season at once by a shared
matcher (`scripts/art/match.ts`): a candidate is accepted only at score ≥ 0.85
with a 0.15 margin over the next distinct candidate, one image per release.
Below the bar it never publishes; scores ≥ 0.5 become suggestions (see
`art-candidates.json`). Images from both RSD tiers are normalized with sharp
to JPEG (≤ 800×800, never upscaled, EXIF-rotated, mozjpeg quality 85). A
failure in any tier (network, bad image, budget) is logged and falls through
to the next tier; art never blocks a publish.

### `rsd-site`: recordstoreday.com

- Needs `BRIGHT_DATA_KEY` and `BRIGHT_DATA_ZONE`. recordstoreday.com returns
  a CloudFront 403 to plain requests, so the event listing page is fetched
  through Bright Data Web Unlocker. Without both secrets the tier is skipped
  with one log line.
- Needs the season in `rsd-events.json` (`season id → PromotionalEvent id`).
  Event ids are opaque and cannot be derived from the season id. For a season
  that isn't in the file, the tier probes the six ids above the highest known
  one, takes the first listing whose release dates fall in the season, and
  logs `rsd-site: <season> is PromotionalEvent/<id> — add it to
  rsd-events.json`. **Runbook: when you see that line, add the discovered id
  to `rsd-events.json` and commit it**, so later runs skip the probing.
- Unlocker requests per run: 1 normally (the whole season is one `?view=all`
  listing page); 2 when the listing comes back incomplete (under 80% of the
  season's releases) and is retried once; up to 7 when probing an unmapped
  season. Hard cap of 400 per run. The product images themselves come
  straight from `img.broadtime.com` and cost nothing.
- A photo id that appears on rows for different releases is treated as a site
  placeholder and ignored for all of them (logged once per photo).
- Recorded pages and site notes: `tests/fixtures/rsd-site/README.md`.

### `rsd-bucket`: RSD's S3 bucket

- Needs nothing: it lists `<year>/` in the same public bucket `watch-rsd`
  watches and matches image filenames (`.jpg .jpeg .png .webp .tif .tiff`,
  skipping `logos/`, `__MACOSX/`, files over 25 MB) against the season.
- Only useful when RSD uploads art packs for that year and leaves them
  publicly readable. After matching, the tier probes one matched image; if
  the bucket refuses it (401/403) or can't be reached, the whole tier is
  skipped for the run (`rsd-bucket: art images not publicly readable;
  skipping`), so no 403 URLs reach the cascade or `art-candidates.json`. As
  of 2026-10-01 only `2025/` has art packs, and their objects return 403.

### `art-candidates.json`

When a release still has no art but the matcher found suggestions, the run
writes `releases/<season-id>/art-candidates.json`: per release, up to three
candidates (`source`, `imageUrl`, `thumbUrl`, `label`, `score`), best first.
It is rewritten on every run, releases that now have art drop out, and the
file is deleted when no release has suggestions. `pnpm validate` checks its
shape. The apps never read it; `wax-wishlist-art-admin` does.

### Daily refresh

`refresh-art.yml` runs daily at 14:00 UTC (after `watch-rsd`) for the season
in `current.json` while its date is today or later, and commits any new art
and the updated `art-candidates.json` (`chore: refresh art for <season-id>`).
Past seasons are skipped. Manual dispatch takes an optional `season-id` and
works for any season. `ingest.yml` and `watch-rsd.yml` run the same cascade
when they publish a season.

### Bright Data secrets

Set `BRIGHT_DATA_KEY` (the Web Unlocker API key) and `BRIGHT_DATA_ZONE` (the
zone name) as repository secrets; `watch-rsd.yml`, `ingest.yml` and
`refresh-art.yml` all pass them through. Both are optional: without them
`rsd-site` is skipped and the other tiers still run. Harden the zone so a
leaked key can do little:

- use a **dedicated Web Unlocker zone** for this repo, not one shared with
  other projects;
- **restrict its target domains to `recordstoreday.com`**;
- set a **spend limit** on the zone (a normal run uses one request a day).

### Reviewing suggestions in art-admin

`wax-wishlist-art-admin` reads `art-candidates.json` for the season. Each
missing release with suggestions shows the top candidate's thumbnail, label
and score with an **Accept** checkbox, plus links to the other candidates;
the pasted-URL field still works for anything else. One **Save** commits
every accepted suggestion and every filled-in URL in a single commit
(`art: add N images`), with each image normalized to the same JPEG first.
Rows that fail (fetch error, not an image, over 10 MB) are reported next to
the row; the rest are still committed. The next refresh sees the files and
drops those releases from `art-candidates.json`.

A wrong accepted match is fixed by deleting the file (or reverting its
commit) and adding the right image in art-admin; the cascade never
overwrites an existing file.

### Running the cascade locally

```sh
# Uses BRIGHT_DATA_KEY / BRIGHT_DATA_ZONE from .env for rsd-site; Discogs and
# MusicBrainz credentials are optional (see the tier list above).
pnpm tsx --env-file=.env scripts/fetch-art.ts <season-id>

# Dry-run: no HTTP calls (RSD tiers, Discogs and MusicBrainz are all
# skipped) and no file writes; manual-art/ is still checked.
pnpm tsx scripts/fetch-art.ts <season-id> --dry-run
```

Every run ends with a coverage summary (per-tier counts, files already on
disk, overall coverage) and, unless dry-run, the `art-candidates.json`
outcome. Without Discogs credentials an anonymous MusicBrainz pass is slow
(about 30 minutes for a 350-release season).

## License

See repository license metadata.
