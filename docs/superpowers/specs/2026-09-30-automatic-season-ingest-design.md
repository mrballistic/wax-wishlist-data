# Automatic season ingest — design

**Date:** 2026-09-30
**Status:** Approved in conversation; awaiting written-spec review
**Scope:** Piece 1 of the data-pipeline rethink (see "Context")
**Target:** In production before the RSD Black Friday 2026 list drops (late October 2026; event 2026-11-27)

## Context

The pipeline today is: a human notices a new RSD PDF, pastes its URL into the
`ingest` workflow, and `scripts/parse-pdf.ts` extracts rows from fixed column
positions. Two failure modes have already happened:

- RSD shifts the PDF template between drops. Black Friday 2025 first parsed
  to `[]`, and the workflow committed the empty list.
- RSD revises PDFs after release (the Black Friday 2025 PDF was replaced
  2025-11-25, three days before the event). Nothing notices revisions.

The rethink was split into four pieces, done in order:

0. Pre-season hardening — **done** (commit `394bc4d`): cron keepalive,
   art cascade keeps existing files, `artFilename` always `<id>.jpg`,
   `refresh-art` workflow.
1. **This spec:** detect new and revised lists automatically, extract them
   robustly, publish without a human, fail safe.
2. Art coverage, including a Bright Data–backed recordstoreday.com art tier.
3. Richer release data (descriptions, variants, better Discogs ids).

## Goals

- When RSD publishes or revises a US release-list PDF, the season is
  published to `main` within a day with no human action.
- A PDF template change does not require a code change on drop day.
- Nothing wrong is ever published: anything the pipeline can't verify becomes
  a GitHub issue instead.
- Zero recurring cost in a normal season.

## Non-goals

- Changing the app-facing JSON contract (`current.json`, `seasons.json`,
  `releases.json` shapes and `artFilename` semantics). Consumers: iOS app,
  Android app, `wax-wishlist-art-admin`.
- Scraping recordstoreday.com, and any use of Bright Data. Both belong to
  piece 2 and are art-only.
- Reading non-PDF bucket objects (e.g. `RSD ORDERABLE STOCK AS OF 4-17.xlsx`).
  They appear to be store-facing documents; only PDFs are in scope.
- Descriptions or any field the current schema doesn't already populate.

## Source: the RSD S3 bucket

`https://recordstoreday.s3.us-east-1.amazonaws.com/` allows anonymous
`ListObjectsV2`. Observed on 2026-09-30:

| Key | LastModified | Notes |
|---|---|---|
| `2025/RSD_2025_Italia/2025_RSD_PUBLIC_PDF_Italia.pdf` | 2025-02-06 | Country list, must be skipped |
| `2025/RSD 2025 List Links/2025_RSD_PUBLICX354A.pdf` | 2025-04-10 | April 2025 |
| `2025/RSD 2025 List Links/2025_BLACK_FRIDAY_PUBLIC.pdf` | 2025-11-19 | Black Friday 2025 |
| `2025/RSD Black Friday 2025 l/2025_BLACK_FRIDAY_PUBLIC.pdf` | 2025-11-25 | Same season, later copy |
| `2026/RSD 2026_v2/RSD26_PDF_4-3.pdf` | 2026-02-04 | Probably the first April 2026 list; no "PUBLIC" in name |
| `2026/RSD 2026_v2/2026_RSD_PUBLIC_PDF.pdf` | 2026-04-16 | April 2026, later version |

Implications the design must handle: file names are not a stable signal,
the same season can appear under several keys, revisions can arrive as an
overwrite (same key, new ETag) or as a new key, and the bucket holds
non-list PDFs and non-PDF files. `2025/` holds 554 keys, so listing must
paginate.

Todd approved polling this listing once a day (2026-09-30). RSD could close
it at any time; manual `ingest` remains the fallback.

## Architecture

```
watch-rsd.yml (daily cron + manual dispatch)
  └─ scripts/watch-rsd.ts
       ├─ bucket.ts        list PDFs under <year>/ (+ <year+1>/ from Sep 1)
       ├─ sources.json     what we've seen: key, ETag, outcome
       ├─ classify.ts      key → season id | skip | unknown
       ├─ calendar.ts      season id → date
       ├─ extract/         parser → gemini → claude, each through the gate
       │    ├─ index.ts    orchestration + shared post-processing
       │    ├─ parser.ts   current pdfjs positional parser (rows only)
       │    ├─ gemini.ts   Gemini Flash, free tier
       │    └─ claude.ts   optional; only if ANTHROPIC_API_KEY is set
       ├─ gate.ts          pure pass/fail + markdown report
       ├─ publish.ts       releases.json, art cascade, register season
       └─ issues.ts        open/close deduplicated GitHub issues
```

`ingest.yml` (manual) keeps its inputs but calls the same extract → gate →
publish path, so a human-triggered ingest is held to the same checks.

### Data flow per run

1. **List.** Fetch every PDF key under the current year's prefix, plus next
   year's from September 1 (the `2026/` prefix was created 2025-09-15). Record
   key, ETag, LastModified.
2. **Diff.** Compare with `sources.json`. A key is *pending* if it's new, its
   ETag changed, or its last outcome was `failed` (retried daily; see Issues).
3. **Classify** each pending key:
   - Path or name contains a country marker (initial list: `Italia`; kept as a
     constant) → `skipped-country`.
   - Contains `BLACK_FRIDAY` or `Black Friday` (case-insensitive) →
     `<year>-november`.
   - Otherwise a PDF under `<year>/` → candidate `<year>-april`.
   - `<year>` comes from the four-digit year in the file name, falling back
     to the prefix.
4. **Pick one per season.** If several pending keys map to one season, process
   only the newest LastModified; mark the others `superseded`.
5. **Extract** (see below). If no extractor produces a gate-passing result:
   - The file name has no list signal (`PUBLIC`, `LIST`, `BLACK_FRIDAY`), the
     parser found no category rows, and at least one LLM extractor ran → record
     `not-a-list`, no issue. That covers pledge forms, logo packs and the like.
   - Otherwise → record `failed` and open an issue.
6. **Date.** `calendar.ts` resolves the season date: `-november` = the day
   after the fourth Thursday of November; `-april` = looked up in
   `calendar.json`. A missing April date → `failed` + issue.
7. **Publish** (gate passed): write `releases/<id>/releases.json`, run the art
   cascade for that season (empty slots only, per piece 0), run
   `register-season` with the resolved date, run `validate`, update
   `sources.json`, and commit to `main` with the existing push-retry loop.
   Commit message: `chore: ingest <season-id> from <key> (<extractor>)`.
8. **Keepalive.** Last step, `if: always()`: re-enable the workflow through the
   Actions API, as in `auto-status.yml`.

### `sources.json`

Committed at the repo root; validated by Zod in `validate.ts`.

```jsonc
[
  {
    "key": "2025/RSD Black Friday 2025 l/2025_BLACK_FRIDAY_PUBLIC.pdf",
    "etag": "\"9f1c…\"",
    "lastModified": "2025-11-25T02:48:51.000Z",
    "seasonId": "2025-november",          // null when skipped / not-a-list
    "outcome": "published",               // published | not-a-list | skipped-country | superseded | failed
    "extractor": "parser",                // parser | gemini | claude | null
    "processedAt": "2026-10-02T12:00:41.000Z"
  }
]
```

It's seeded at implementation time from today's bucket listing, recording
what's already published, so the first run doesn't re-ingest history.

### `calendar.json`

Hand-maintained April dates (RSD announces them months ahead). Seeded with
`{ "2025": "2025-04-12", "2026": "2026-04-18" }`; `2027` is added once it's
announced. (`seasons.json` had 2025-april dated 2025-04-19; corrected to
2025-04-12 on 2026-09-30.)

## Extraction

### Shared contract

```ts
interface ExtractedRow {
  category: 'E' | 'L' | 'F'
  artist: string
  title: string
  label: string
  format: string
}

interface Extractor {
  name: 'parser' | 'gemini' | 'claude'
  /** Throws on transport/config failure; returns rows otherwise. */
  extract(pdf: Buffer): Promise<ExtractedRow[]>
}
```

Post-processing moves out of `parsePdf` into `extract/index.ts` and is
applied identically to every extractor's output: whitespace normalization,
E/L/F → slug category mapping, exact-tuple dedupe, and slug-based id
assignment with `-2`, `-3` suffixes. Ids depend only on artist + title, never
on which extractor ran, so they stay stable across extractor changes and PDF
revisions (protecting art slots, user wishlists and art-admin).

The existing `parsePdf(buffer): Promise<RawRelease[]>` export is kept as a
thin wrapper (parser + post-processing) so current tests and callers keep
working.

### Cascade

Run in order, stopping at the first candidate that passes the gate:

1. `parser`: always.
2. `gemini`: if `GEMINI_API_KEY` is set. A current Flash model on the free
   tier, with the PDF sent inline and the row schema as a JSON response
   schema. The model id is a single constant.
3. `claude`: only if `ANTHROPIC_API_KEY` is set. `claude-opus-5-5`, with the
   PDF as a base64 `document` block, structured output from the Zod row
   schema via the official `@anthropic-ai/sdk`, streaming with
   `finalMessage()`, and the server-side refusal fallback enabled.

A thrown error (rate limit, timeout, refusal, unset key, malformed output)
counts as that extractor failing; the reason is recorded in the report and the
next extractor runs. LLM extractors make one request per PDF (the current
lists are 8 pages and about 28K characters, comfortably within one request).

Expected cost: $0 in a season where the parser passes. Gemini free tier when
the template changes. Claude (roughly under $1 per run, estimated) only when
Gemini also fails and the key is configured.

## Gate

`gate.ts` exports a pure function:

```ts
checkCandidate(candidate: RawRelease[], ctx: {
  extractor: Extractor['name']
  pdfText: string                    // pdfjs text layer, for the LLM check
  previousSameSeason: RawRelease[] | null   // set for revisions
  lastComparableCount: number | null        // last season of the same kind
}): { pass: boolean; failures: string[]; report: string }
```

Rules (all must hold):

| Rule | Applies to | Threshold |
|---|---|---|
| Minimum size | all | ≥ 25 rows |
| Complete rows | all | artist, title, label, format non-empty for every row |
| Valid categories | all | every category ∈ {exclusive, small-run, rsd-first} |
| Unique ids | all | no collisions after suffixing |
| Plausible size | when `lastComparableCount` is known and this isn't a revision | 0.6× – 1.6× of it |
| Bounded revision | revisions | ≤ 15% of previous ids removed; count change ≤ 25% |
| Grounded in PDF | gemini, claude | ≥ 98% of artist strings and ≥ 98% of title strings found in `pdfText` after normalization (case-fold, NFKD, strip punctuation, collapse whitespace); empty `pdfText` fails |

"Same kind" means April vs April and November vs November, using the season
id suffix.

The report (markdown) includes: the season and source key; each extractor
tried, with its outcome and failure reasons; row counts against the
comparisons; and for revisions, a diff of added, removed and changed rows (by
id, comparing label and format). It's written to `$GITHUB_STEP_SUMMARY` on
every run and used as the issue body on failure.

## Issues

- One open issue per (season, ETag). Title:
  `watch-rsd: could not publish <season-id> (<etag-short>)`, or
  `watch-rsd: unrecognized list PDF <key>` when the season can't be determined.
  The job searches open issues by title before creating one; `failed` keys
  are retried daily without opening new issues.
- When a season is later published (by this job or by manual `ingest`), open
  issues for that season are closed with a comment that links the commit.
- Bucket unreachable (non-2xx, network error, malformed XML): one issue
  `watch-rsd: bucket unreachable`, closed automatically on the next successful
  listing.
- The workflow needs `contents: write`, `issues: write` and `actions: write`
  (keepalive).

## Secrets and configuration

| Secret | Required | Use |
|---|---|---|
| `GEMINI_API_KEY` | Recommended | Gemini fallback. Without it, a template change goes straight to an issue (or to Claude). |
| `ANTHROPIC_API_KEY` | Optional | Second LLM fallback |
| `DISCOGS_CONSUMER_KEY` / `_SECRET`, `METABRAINZ_ACCESS_TOKEN` | Existing | Art cascade during publish |

## Testing

- **Gate:** unit tests per rule and threshold boundary, using fixtures built
  from the real 2025-april, 2025-november and 2026-april `releases.json`
  (truncated lists, removed rows, a fabricated row for the grounding check).
- **Classify:** table test over the observed bucket keys above, plus the
  `.xlsx`/`.doc`/`.zip` keys, which must never be classified.
- **Calendar:** Black Friday rule for 2025 (11-28), 2026 (11-27) and 2027
  (11-26); April lookup hit and miss.
- **Watcher:** msw-mocked listing (recorded XML, including a paginated
  response) covering: new list PDF → publish; ETag change → revision; two keys
  for one season → newest wins; non-list PDF → `not-a-list`; country list →
  skipped; bucket 403 → issue. Git and issue side effects go through injected
  functions so tests don't touch the network or the repo.
- **Extractors:** the parser against the existing `tests/fixtures/*.pdf`.
  Gemini and Claude against recorded responses (no network in CI). One
  manually run `scripts/check-llm-extractors.ts` per provider against a real
  fixture, for live verification.
- **Rehearsal (before the October drop):** run `watch-rsd` with a
  `--dry-run` flag (no commit, no issues, report only) against a copy of
  `sources.json` without the Black Friday 2025 entries. It must classify,
  extract, gate and produce a release list matching the published
  2025-november season.

## Rollout

1. Land the extract/gate refactor with `ingest.yml` switched over; the
   existing tests stay green.
2. Land the watcher with `--dry-run` as the workflow default; seed
   `sources.json`; add the `GEMINI_API_KEY` secret.
3. Rehearse (above). Then flip the workflow to publishing.
4. Watch the first real drop; manual `ingest` remains available.

## Open risks

- **The bucket listing closes.** Detected the same day (issue); fall back to
  manual `ingest` with the PDF URL.
- **A list with no list signal in its name, a changed template, and no LLM
  available** (no key, or Gemini rate-limited). Every pending PDF goes through
  the full cascade before step 5 decides, so normally Gemini reads such a list
  and it gets published. Only when the parser finds zero category rows *and*
  no LLM ran does it become `not-a-list` silently. Mitigation: record
  `not-a-list` only when at least one LLM extractor actually ran; otherwise
  record `failed`, which opens an issue.
- **Free-tier quota changes.** A rate-limited Gemini call is an extractor
  failure: Claude if configured, otherwise an issue.
