# Feature PRD: Multi-Source Album Art Pipeline

**Parent project:** Wax Wishlist iOS App (see `PRD.md`)
**Feature scope:** Data repo (`wax-wishlist-data`) only — no iOS app changes
**Status:** Proposed, net-new feature
**Version:** v1.0

---

## 1. Overview / Executive Summary

The base Wax Wishlist PRD assumes album art is fetched from a single source: the Discogs API. In practice, newly-announced RSD releases frequently don't exist in Discogs until after the event, when collectors start cataloging them. Shipping with a single-source ingest means the seed season and first-run Browse experience are littered with placeholder vinyl icons for exactly the highest-interest, newest releases — the opposite of what a paid App Store user expects.

This feature replaces the single-source Discogs lookup with a **four-tier fallback cascade** that maximizes coverage while preserving the project's ToS-clean, no-scraping, no-runtime-API-calls posture. Each tier is tried in order; the first match wins. The entire cascade runs inside the existing `scripts/fetch-art.ts` module in the data repo — no new infrastructure, no iOS app changes, no new runtime dependencies.

**Value:** Coverage of the published RSD list is expected to jump from ~60–70% at announcement time (Discogs-only baseline) to ~90%+ by RSD day, with hand-curated overrides available for the handful of high-profile releases that matter most for launch-day polish.

**Deployment target:** `wax-wishlist-data` repo, consumed by `ingest-season.yml` GitHub Action
**Primary persona:** Todd (repo maintainer) and, indirectly, every Wax Wishlist App Store user

---

## 2. Goals & Non-Goals

### Goals
- Increase album art coverage of RSD releases from single-source (~60–70%) to multi-source (~90%+)
- Preserve all existing ToS-clean properties — no scraping, no site crawling, no ignoring `robots.txt`
- Allow hand-curation of high-value releases via a `manual-art/` override folder committed to the repo
- Keep the ingest runtime within a reasonable bound (under 30 minutes for a 100-release season)
- Add no runtime dependencies to the iOS app — the app continues to consume static `raw.githubusercontent.com` URLs and knows nothing about art source provenance
- Resolve the open licensing question for commercial MusicBrainz use before shipping

### Non-Goals
- Crawling or scraping `recordstoreday.com` — blocked by robots.txt and ToS
- Using Nova Act, headless browsers, or any tool that could be interpreted as bypassing anti-crawler measures
- Downloading art from artist or label social media / Instagram / Bandcamp
- Running an agent at iOS app runtime — all art work remains in the GitHub Action
- Building a web UI for managing the `manual-art/` folder — it's a plain git-committed directory
- Any Discogs replacement strategy — Discogs remains tier 1, not deprecated

---

## 3. User Stories

### Persona: Todd (Repo Maintainer)
Role: Data repo owner, runs the ingest Action a few times a year.
Context: Needs every RSD season to ship with as much art as possible, with a simple escape hatch for the 5–10 releases the automated cascade will always miss (new small-label pressings, region-exclusives, etc.).

---

**US-F-001: Automatic Multi-Source Lookup**
As Todd, I want the ingest Action to automatically try multiple art sources in order so that coverage is maximized without any manual work for the common case.
Acceptance Criteria:
- Ingest tries Discogs first, then MusicBrainz + Cover Art Archive, then manual overrides, then placeholder
- Each tier's success/failure is logged to the Action run output with release ID, tier hit, and source URL
- Final coverage report at end of run summarizes counts per tier (e.g. "Discogs: 42, MusicBrainz: 18, Manual: 3, Placeholder: 7")

**US-F-002: Hand-Curated Overrides**
As Todd, I want to drop manually-sourced art images into a versioned folder so that I can fix specific high-priority releases without code changes.
Acceptance Criteria:
- The data repo has a `manual-art/` directory committed to git
- Any image file in `manual-art/` whose basename matches a release slug is used instead of any auto-discovered art
- Images are copied into the season's `releases/[season-id]/art/` directory on ingest, replacing any auto-sourced version
- Manual overrides are logged distinctly in the Action run summary so Todd can see what was manually sourced

**US-F-003: Graceful Degradation**
As Todd, I want the ingest to never fail when a release has no art available so that a partial result is still publishable.
Acceptance Criteria:
- Releases with no art from any source end up with `artFilename: null` in `releases.json`
- The iOS app's existing placeholder handling (FR-016 in parent PRD) handles null `artFilename` with the vinyl SF Symbol — no iOS change needed
- Action exits with status 0 even if some releases have no art; only exits non-zero for infrastructure failures (API down, auth error, PDF parse failure)

---

## 4. Functional Requirements

### Source Cascade

**FR-F-001** The `scripts/fetch-art.ts` module shall implement a four-tier fallback cascade executed sequentially per release:
1. **Tier 1 — Discogs Search API** (existing behavior from parent PRD)
2. **Tier 2 — MusicBrainz + Cover Art Archive** (new)
3. **Tier 3 — Manual Override folder** (new)
4. **Tier 4 — No art** (existing fallback; `artFilename: null`)

**FR-F-002** Tiers 1 and 2 shall be tried in order for each release until one succeeds. Tier 3 (manual override) shall always take precedence over tiers 1 and 2 if a matching file exists, regardless of whether auto-sourcing succeeded. The cascade order in practice is:

```
IF manual_art_exists(release.id):
    use manual art (tier 3)
ELIF discogs_returns_match(release):
    use discogs art (tier 1)
ELIF musicbrainz_returns_match(release):
    use musicbrainz art (tier 2)
ELSE:
    set artFilename = null (tier 4)
```

**FR-F-003** Each release's ingest result shall record which tier it hit in a structured log entry:
```typescript
interface ArtLookupResult {
  releaseId: string;
  tier: 'manual' | 'discogs' | 'musicbrainz' | 'none';
  sourceUrl: string | null;  // URL where art was fetched from; null for tier 3 and 4
  artFilename: string | null;
}
```

**FR-F-004** At the end of every ingest run, the Action shall print a coverage summary to stdout:
```
=== Art Coverage Summary ===
Total releases: 72
  Tier 1 (Discogs):      42 (58%)
  Tier 2 (MusicBrainz):  18 (25%)
  Tier 3 (Manual):        3 (4%)
  Tier 4 (No art):        9 (13%)
Coverage: 63 / 72 (87%)
===========================
```

---

### Tier 1 — Discogs (existing, unchanged)

**FR-F-005** Tier 1 Discogs behavior is as specified in the parent PRD (Section 6: Discogs Search API). No changes. The existing 2.5s-per-request rate limiting remains.

---

### Tier 2 — MusicBrainz + Cover Art Archive (new)

**FR-F-006** Tier 2 shall perform a two-step lookup:
1. Query the MusicBrainz Search API to find a release MBID matching the artist + title
2. Use the MBID to fetch the front cover image from the Cover Art Archive

**FR-F-007** The MusicBrainz search request shall be:
```
GET https://musicbrainz.org/ws/2/release/
  ?query=release:"[title]" AND artist:"[artist]"
  &fmt=json
  &limit=5
Headers:
  User-Agent: WaxWishlistBot/1.0 (contact@[DOMAIN])
  Accept: application/json
```

⚠️ OPEN QUESTION: What contact email should be used in the MusicBrainz User-Agent? MusicBrainz requires a contact string for all non-trivial bots. Todd should use an email address he controls (personal or a support@ alias for the app).

**FR-F-008** The MusicBrainz response shall be ranked by their `score` field (descending). The first result with `score >= 90` shall be selected. If no result meets the threshold, tier 2 returns no match and the cascade proceeds to tier 3.

**FR-F-009** The Cover Art Archive front-cover request shall be:
```
GET https://coverartarchive.org/release/[MBID]/front
```
This returns a 307 redirect to the binary image. The fetcher shall follow the redirect and save the image bytes. If CAA returns 404 (no cover art for this MBID), tier 2 returns no match and the cascade proceeds to tier 3.

**FR-F-010** MusicBrainz rate limiting shall be respected: one request per second maximum. The fetcher shall sleep 1000ms between MusicBrainz requests. Cover Art Archive has no rate limit and requires no delay.

**FR-F-011** Retry policy for MusicBrainz: on HTTP 503 (rate limited) or 500, retry up to 3 times with exponential backoff (1s, 2s, 4s). On HTTP 4xx other than 503, treat as no-match (not an error).

**FR-F-012** The User-Agent header shall be set on every MusicBrainz request. MusicBrainz blocks requests without a meaningful User-Agent. The data repo README shall document this requirement for future maintainers.

---

### Tier 3 — Manual Override Folder (new)

**FR-F-013** The data repo shall include a `manual-art/` directory at the root:
```
/manual-art/
  ├── README.md                          # Instructions for curation
  ├── [release-id-slug].jpg              # Image keyed by release slug
  ├── [another-release-id].png
  └── ...
```

**FR-F-014** Supported image formats: `.jpg`, `.jpeg`, `.png`. The fetcher shall recognize any of these extensions when looking up overrides. If multiple files exist with the same basename and different extensions, `.jpg` wins (arbitrary tiebreaker; documented in README).

**FR-F-015** The release slug used for the filename must exactly match the `id` field generated by the slugification logic in `parse-pdf.ts`. The ingest script shall log a warning at the end of the run if any file in `manual-art/` does not match any release ID in the current season, to catch typos.

**FR-F-016** Manual override images shall be re-encoded to JPEG at 600x600 pixels maximum during ingest, to match the size profile of auto-sourced art and keep per-season art directory sizes reasonable. The original file in `manual-art/` is not modified — only the copy in `releases/[season-id]/art/` is resized.

**FR-F-017** The `manual-art/` folder shall be shared across seasons — a single file like `manual-art/a-ha-hunting-high-and-low-demos.jpg` applies to any season that contains a release with that ID. This allows reuse if a release appears in multiple seasons (rare, but possible for RSD Drops reissues).

**FR-F-018** The `manual-art/README.md` shall document:
- How to find a release's slug ID (look at the generated `releases.json`)
- Acceptable sourcing for manual art: official artist/label promo channels, label press kits, purchased scans the maintainer owns; NOT unlicensed third-party image hosts, Instagram reposts of others' photos, or any source without clear rights to redistribute
- Image format and size recommendations (square aspect ratio, ≥600×600)
- That committing to `manual-art/` is a public, permanent, git-tracked act — any image added there is effectively published

---

### Tier 4 — Placeholder (existing, unchanged)

**FR-F-019** Tier 4 behavior is as specified in the parent PRD (FR-016 in the main PRD). A `null` `artFilename` in `releases.json` causes the iOS app to render the vinyl SF Symbol placeholder. No changes to iOS behavior.

---

### Performance & Runtime

**FR-F-020** The full ingest for a 100-release season shall complete within 30 minutes on a standard GitHub Actions Ubuntu runner. At 1 request/second for Discogs and 1 request/second for MusicBrainz fallback, worst case is ~2 seconds per release × 100 = ~3.5 minutes for API lookups, plus image download bandwidth. 30 minutes provides generous headroom for retries and CAA latency.

**FR-F-021** All three art sources (Discogs, MusicBrainz, CAA) shall be called sequentially per release. Parallelization across releases is out of scope for v1 — sequential execution keeps rate-limit compliance trivial and debugging straightforward.

**FR-F-022** The fetcher shall implement a local HTTP cache keyed on request URL, stored in `.cache/` (gitignored, persisted across Action runs via `actions/cache` if desired in a future iteration). For v1, the cache is in-memory per-run only — so re-running the Action re-hits APIs. Future optimization, not required for shipping.

---

### Licensing & Compliance

**FR-F-023** Before shipping v1 of Wax Wishlist to the App Store, Todd shall contact MetaBrainz Foundation via their commercial licensing form (https://metabrainz.org/supporters/account-type) to obtain a commercial use license or plan for MusicBrainz API access. This is a one-time setup step, not a per-release task.

⚠️ OPEN QUESTION: What is MetaBrainz's commercial pricing for an indie paid App Store app at Wax Wishlist's expected scale? Expected scale: ingest runs 2–4 times per year, ~100 API calls per run. This is well below any reasonable commercial threshold, but MetaBrainz requires a license regardless of volume for commercial use.

**FR-F-024** Cover Art Archive images carry metadata indicating allowed usage. The fetcher shall read the `approved` field in the CAA response and only use images where `approved: true`. Images with `approved: false` (community-flagged as questionable) are treated as no-match.

**FR-F-025** The data repo README shall include a "Data Sources" section documenting:
- That album art is sourced from Discogs API, Cover Art Archive (MusicBrainz), and hand-curated overrides
- That RSD release metadata is parsed from Record Store Day's publicly-published PDF
- That neither the data repo nor the Wax Wishlist iOS app is affiliated with Discogs, MusicBrainz, MetaBrainz, or Record Store Day
- A link to each data source's terms of use

---

## 5. Technical Requirements / Stack

All changes are contained within the **`wax-wishlist-data` repo**. No iOS app changes. No new workflow files.

### New TypeScript modules

```
scripts/
├── fetch-art.ts              # UPDATED: now orchestrates the cascade
├── sources/                  # NEW directory
│   ├── discogs.ts            # Existing Discogs logic, moved here
│   ├── musicbrainz.ts        # NEW: MusicBrainz + CAA lookup
│   └── manual.ts             # NEW: manual-art/ folder lookup
└── types.ts                  # UPDATED: add ArtLookupResult interface
```

### Updated TypeScript types (scripts/types.ts additions)

```typescript
export type ArtTier = 'manual' | 'discogs' | 'musicbrainz' | 'none';

export interface ArtLookupResult {
  releaseId: string;
  tier: ArtTier;
  sourceUrl: string | null;
  artFilename: string | null;
}

export interface ArtSource {
  name: ArtTier;
  lookup(release: Release): Promise<ArtLookupResult | null>;
}
```

### New npm dependencies

- `sharp` — for image resizing in tier 3 (manual override normalization). Already widely used, MIT-licensed, pure-JS fallback available.

No other new dependencies. MusicBrainz and CAA are plain HTTP endpoints hit with Node's built-in `fetch`.

---

## 6. API / Data Contracts

### MusicBrainz Search Response (relevant fields)

```typescript
interface MBReleaseSearchResponse {
  releases: Array<{
    id: string;              // MBID — used to query CAA
    score: number;           // 0-100 match confidence
    title: string;
    'artist-credit': Array<{ name: string }>;
    date?: string;           // release date, may be absent
  }>;
}
```

### Cover Art Archive Response

Either:
- **Success**: HTTP 307 redirect to an image URL on `archive.org`. Follow redirect, save bytes.
- **Not found**: HTTP 404. Treat as no-match.

No JSON is returned for `/front` endpoint — it's a direct redirect. The `/release/{mbid}` JSON endpoint is not needed for v1; we only need the front cover.

### Manual Art Filesystem Contract

```
manual-art/[release-id].{jpg|jpeg|png}
```

- `release-id` must exactly match a `Release.id` value generated by `parse-pdf.ts`
- Max file size: 10 MB (larger files rejected with warning)
- Must be a valid JPEG or PNG (verified via `sharp` before use)

---

## 7. CI/CD & Quality Gates

The existing data repo quality gates (Section 8 in parent PRD) apply. Additions:

1. **Test coverage on new modules**: `sources/musicbrainz.ts` and `sources/manual.ts` shall have minimum 80% coverage in Vitest
2. **Mock HTTP in tests**: Use `msw` or `nock` to mock MusicBrainz/CAA responses; do not hit real APIs in CI
3. **Lint the manual-art folder**: A CI step shall scan `manual-art/` for valid image files and fail the build if any file is corrupt, over size limit, or has an unsupported extension
4. **Dry-run mode**: `scripts/fetch-art.ts` shall accept a `--dry-run` flag that logs what would be done without making HTTP calls or writing files, useful for local dev

---

## 8. Migration / Backwards Compatibility

This feature is a **drop-in enhancement** to the existing `fetch-art.ts`. Existing `releases.json` files from prior ingest runs are unchanged — the schema is identical; only the source of `artFilename` can now be MusicBrainz or manual in addition to Discogs.

The iOS app requires **zero changes**. It has always consumed `artFilename` as an opaque string. It doesn't know or care which tier sourced it.

Seasons ingested before this feature shipped will have their art gap profile frozen; they can be re-ingested manually by running the `workflow_dispatch` Action again with the same inputs, which will overwrite the existing `releases/[season-id]/` directory with the new cascade's output.

---

## 9. Out of Scope

- **Any kind of site crawling** of `recordstoreday.com`, artist sites, label sites, or social media
- **Nova Act, Playwright, or headless-browser agents**
- **Parallelization across releases** (sequential only in v1)
- **Persistent HTTP cache across runs** (in-memory per-run cache only in v1)
- **A fourth API source** (Last.fm, Spotify, Apple Music) — v2 candidate if coverage is still inadequate after tier 1–3
- **iOS app changes** — all work is server-side ingest
- **Automatic detection of better art** — manual tier always wins, even if Discogs has a higher-res version. The maintainer's explicit choice is trusted
- **UI for managing manual-art/** — plain git folder, managed via standard PR workflow
- **Crowdsourced or user-submitted art** from Wax Wishlist app users — data repo is maintainer-only

---

## 10. Open Questions

1. **MusicBrainz contact email for User-Agent** (FR-F-007) — what email does Todd want to use?
2. **MetaBrainz commercial licensing** (FR-F-023) — what is the plan/cost, and what is the timeline for getting approved before App Store submission?
3. **Cache strategy for v2** — worth adding a persistent `actions/cache` layer, or is per-run re-fetch fine given 2–4 ingests per year?
4. **Should the coverage summary (FR-F-004) also be written to a file committed to the repo** (e.g. `releases/[season-id]/coverage.json`) for historical tracking of how coverage improved over time? Low cost to add, potentially useful for debugging.
