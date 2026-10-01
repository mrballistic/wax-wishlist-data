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
.github/workflows/        # validate / ingest / update-status pipelines
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
  "artFilename": "2026-april-001.jpg" // nullable; joined with artBaseUrl by the app
}
```

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

Writes `releases/<season-id>/releases.json`, sorted stably by artist then
title (case-insensitive). Art is **not** pre-downloaded — the consuming app
fetches art lazily per release.

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
  result that passes the quality gate wins.
- **Quality gate:** at least 25 complete rows, a size within 0.6–1.6× of the
  last same-kind season, bounded revisions (≤ 15% removed, ≤ 25% count
  change), and LLM rows that actually appear in the PDF's text.
- **Failures** publish nothing and open a `watch-rsd:` issue, which closes
  itself once the season is published (by the watcher or manual `ingest`).
- **State:** `sources.json` records every bucket PDF seen and what happened
  to it; `calendar.json` holds April dates (add each year's once RSD
  announces it; Black Friday is computed).
- **Publishing switch:** scheduled runs are dry runs (report in the step
  summary) unless the repository variable `WATCH_RSD_PUBLISH` is `true`.
  Manual runs take a `publish` checkbox and an `only` extractor choice.

Local dry run (reads `.env` for `GEMINI_API_KEY`):

```sh
pnpm tsx --env-file=.env scripts/watch-rsd.ts --dry-run
pnpm tsx --env-file=.env scripts/watch-rsd.ts --dry-run --prefix=2025/ --sources=/tmp/sources.json --only=gemini
```

Manual `ingest` now takes the date as a third argument and runs the same
cascade and gate:

```sh
pnpm tsx scripts/ingest.ts 2026-november <pdf-url-or-path> 2026-11-27 [--label="..."] [--dry-run]
```

Live-check one LLM extractor against a real PDF (spends API quota):

```sh
pnpm tsx --env-file=.env scripts/check-llm-extractors.ts gemini tests/fixtures/2025-november.pdf 2025-november
```

## Season promotion flow

1. A new PDF drops. Open the **Actions -> ingest** workflow in GitHub and
   run it with the new `season-id` and the PDF URL. The workflow commits
   `releases/<season-id>/releases.json` back to `main`.
2. Edit `current.json` and prepend a new entry to `seasons.json` by hand
   (or via a follow-up script) with `status: "upcoming"`.
3. The daily **update-status** workflow (or a manual dispatch) moves the
   season through `upcoming -> active -> past` as the calendar advances.
4. The consuming iOS app polls `current.json` — a change in `id` prompts
   a download; a change in `status` updates silently.

## CI

- **validate.yml** — on every push and PR: `pnpm install`, lint, typecheck,
  tests, and schema validation of every shipped JSON file.
- **ingest.yml** — manual dispatch only. Runs `ingest.ts`, validates, and
  commits back to `main`.
- **update-status.yml** — manual dispatch only. Runs `update-status.ts`,
  validates, and commits back to `main`.
- **auto-status.yml** — daily cron. Recomputes every season's status from
  its date. Each run re-enables itself through the Actions API, which resets
  GitHub's 60-day inactivity timer for scheduled workflows.
- **refresh-art.yml** — manual dispatch only. Re-runs the art cascade for an
  already-ingested season, filling only empty art slots. Existing files
  (including ones committed by `wax-wishlist-art-admin`) are never
  overwritten.

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

The cascade tries sources in the order manual → Discogs → MusicBrainz
per release and stops at the first hit; releases with no match in any
tier ship with `artFilename: null` and the iOS app renders its
placeholder. See [`docs/FEATURE_PRD_multi_source_art.md`](docs/FEATURE_PRD_multi_source_art.md)
for the full specification.

### Running the art cascade locally

```sh
# Actually fetch art.
#   Tier 1 (Discogs) requires a consumer key/secret pair; omit both to skip tier 1.
#   Tier 2 (MusicBrainz + Cover Art Archive): the access token is optional —
#     the endpoint works anonymously with only the User-Agent, but a MetaBrainz
#     Supporter / commercial token grants higher rate ceilings and is currently
#     valid only for non-commercial use (see LICENSE compliance in CLAUDE.md).
# Either source independently no-ops when its credentials are absent.
export DISCOGS_CONSUMER_KEY=...
export DISCOGS_CONSUMER_SECRET=...
export METABRAINZ_ACCESS_TOKEN=...   # optional
pnpm tsx scripts/fetch-art.ts <season-id>

# Dry-run: simulate the cascade without HTTP calls or file writes.
pnpm tsx scripts/fetch-art.ts <season-id> --dry-run
```

The script prints a coverage summary to stdout at the end of every
run (Tier 1/2/3/4 counts and overall coverage percentage).

## License

See repository license metadata.
