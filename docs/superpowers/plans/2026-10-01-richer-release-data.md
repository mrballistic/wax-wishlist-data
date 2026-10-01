# Richer Release Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill `description` and four new optional fields (`tracklist`, `quantity`, `upc`, `rsdUrl`) from recordstoreday.com, recover PDF rows the parser drops, look up Discogs ids by barcode, keep it all fresh daily, and hand the new contract to the iOS and Android repos.

**Architecture:** A shared, per-run-memoized **site index** (`scripts/rsd/site-index.ts`) owns all recordstoreday.com fetching and parsing (moved out of `scripts/art/rsd-site.ts`) and now also parses descriptions, tracklists, labels, quantities and UPCs. **Repair** (`scripts/rsd/repair.ts`) uses it at ingest, before ids are assigned. **Enrichment** (`scripts/rsd/enrich.ts`) uses it after the gate and in the daily refresh. The art tier reads the same index.

**Tech Stack:** TypeScript (ESM, Node 24, tsx), Zod 3.23.8, Vitest 2 + msw 2, Bright Data Web Unlocker, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-01-richer-release-data-design.md`

## Global Constraints

- **PDF is the source of truth for which releases exist.** The site never adds a release; it only fills fields and repairs rows the PDF contains.
- **Contract change is additive only:** `ReleaseSchema` gains optional `tracklist?: string[]`, `quantity?: number | null` (positive int), `upc?: string | null` (8–14 digits), `rsdUrl?: string | null` (URL). No existing key changes. Files without the new keys stay valid.
- **Never overwrite a non-empty value** (`""`, `null`, absent count as empty; an empty array counts as empty for `tracklist`).
- **Never guess:** enrichment uses only the art matcher's *accepted* pairs (`matchReleases`); repair uses only exact normalized matches (`normalize` from `scripts/art/match.ts`).
- **Site index cost:** `?view=all` page + table page per season per process (memoized); probing rules unchanged (`rsd-events.json`, max+1..max+6, date-vote season check, 80% completeness with one retry, placeholder-photo guard).
- **Art behaviour must not change** (piece 2 measurements: 342/353 for 2026-april, 170/173 for 2025-november on fixtures — keep those tests passing).
- **Publishing never blocks** on site, repair, enrichment or Discogs failures; each is skipped with one log line.
- **Apps refetch only when `current.json` `contentUpdatedAt` moves:** any rewrite of a current season's `releases.json` must stamp it.
- Tests: no network (msw `onUnhandledRequest: 'error'`); `fetch` resolved per call; fixtures under `tests/fixtures/rsd-site/` are the source for markup.
- Style: ESM `.js` suffixes, `import/order`, no `any`, no `!`, `\uXXXX` escapes in regexes. `pnpm lint && pnpm typecheck && pnpm test && pnpm validate` (and `actionlint` when workflows change) before every commit; commits end with a Co-Authored-By line for the model that wrote them.
- Secrets never printed (`.env`: `GEMINI_API_KEY`, `BRIGHT_DATA_KEY`, `BRIGHT_DATA_ZONE`).

## Review Focus

1. **A parser-dropped row repaired into the wrong release** (e.g. a fused string that is a prefix of two site entries). Expected: only an exact `artist + " " + title` equality repairs; anything else stays dropped. Test: Task 3.
2. **Unrepaired partial rows tipping the gate's 2% rule.** Expected: partial rows never enter the candidate unless repaired to complete. Test: Task 3.
3. **A manual description or Discogs id overwritten by enrichment.** Expected: untouched. Test: Task 4.
4. **The daily refresh rewriting `releases.json` with no change, or changing it without bumping `contentUpdatedAt`.** Expected: write only on change; stamp only when the season is current. Test: Task 5.
5. **Table page JS-rendered (50 rows) while `?view=all` is complete.** Expected: index still complete from `?view=all`; quantity/UPC present only for the rows the table page had. Test: Task 1.

---

### Task 1: Shared site index

**Files:** Create `scripts/rsd/site-index.ts`, `tests/rsd/site-index.test.ts`. Modify `scripts/art/rsd-site.ts` (thin art source over the index), `tests/art/rsd-site.test.ts` (imports/expectations only; behaviour unchanged).

**Interfaces (produces):**

```ts
export interface SiteEntry {
  releaseId: string            // "/SpecialRelease/<id>" number as string
  artist: string
  title: string
  photoId: number
  format: string               // "" when absent
  label: string                // quickview Label line; "" when absent
  description: string          // "MORE INFO" prose; paragraphs joined by "\n\n"; "" when absent
  tracklist: string[]          // lines after the "Tracklist" heading, trimmed, blanks removed; [] when absent
  quantity: number | null      // from the table page join
  upc: string | null           // from the table page join (8–14 digits)
  pageUrl: string
}
export interface SiteIndex { seasonId: string; eventId: number; entries: SiteEntry[] }
export interface SiteIndexOptions {
  seasonId: string
  unlocker: Unlocker | null
  /** Completeness floor: entries must be ≥ INCOMPLETE_RATIO × expectedCount (0 = no floor). */
  expectedCount: number
  events?: RsdEvents
  log?: (line: string) => void
}
export function fetchSiteIndex(opts: SiteIndexOptions): Promise<SiteIndex | null>   // never throws
export function getSiteIndex(opts: SiteIndexOptions): Promise<SiteIndex | null>     // memoized per seasonId per process
export function resetSiteIndexCache(): void                                         // tests
export function parseListing(html: string): Omit<SiteEntry, 'quantity' | 'upc'>[]
export function parseTablePage(html: string): Map<string, { quantity: number | null; upc: string | null }>
export const tableUrl: (eventId: number) => string   // `${SITE}/PromotionalEvent/${id}` (no view=all)
```

Move (unchanged behaviour) from `rsd-site.ts` into `site-index.ts`: `SITE`, `RSD_EVENTS_FILE`, `EVENT_PROBE_LIMIT`, `INCOMPLETE_RATIO`, `RsdEventsSchema`, `RsdEvents`, `cleanText` (+ mojibake helpers), `eventUrl`, `photoUrl`, `isEventPage`, `listingSeason`, `dropSharedPhotos` (now over `SiteEntry`), `loadRsdEvents`, `parseReleasePage`, and the event-finding/probing/retry logic from `createRsdSiteSource`. `rsd-site.ts` keeps `createRsdSiteSource(opts)` which calls `getSiteIndex({ seasonId, unlocker, expectedCount: season.length, events, log })` in `prepare`, maps entries to candidates exactly as today, and runs `matchReleases`. Re-export moved names from `rsd-site.ts` only if existing imports need it; prefer updating imports.

Behaviour:
- `parseListing` extends today's quickview parse with `releaseId`, `label`, `description`, `tracklist`. Today's `quickviews()` cuts each block before `quickview_description`; keep that cut for the head fields, and parse the description/tracklist from the text after it (up to the next quickview). Inspect `promotional-event-601-view-all.html` for the exact markup (headings "MORE INFO" and "Tracklist", line/paragraph separators). Description: decode via `cleanText` per paragraph, join paragraphs with `"\n\n"`, exclude the heading and everything from "Tracklist" on. Tracklist: one string per printed line.
- `parseTablePage`: within `<tbody>`…`</tbody>` rows, read the `/SpecialRelease/<id>` link, the quantity cell (7th plain `<td>`; digits only after removing commas → number, else null) and `/UPC/(\d{8,14})` inside the row's HTML comment. Must tolerate the JS-rendered table (return what's there).
- `fetchSiteIndex`: resolve the event and fetch `eventUrl` exactly as today (mapped id / probing / date vote / soft-404 / completeness with one retry / placeholder guard), then fetch `tableUrl(eventId)` once; on any failure or if it parses to < `INCOMPLETE_RATIO × entries.length` rows, retry once; whatever is joined is joined (missing → `quantity: null, upc: null`). Unlocker unconfigured → log once per process and return null. Any error → log, return null.

- [ ] **Step 1: Failing tests** in `tests/rsd/site-index.test.ts` using fixtures and a fake `Unlocker` (an object with `fetchPage(url)` returning fixture HTML by URL, and `requestsMade()`):
  - `parseListing(view-all 601)`: 359 entries; a-ha `releaseId` "19926", label "Rhino", description starts "Analogue is a-ha's eighth studio album" (apostrophe decoded) and contains no "MORE INFO"/"Tracklist"; tracklist[0] "LP1:" and contains "A1. CELICE (2026 REMASTER)".
  - `parseTablePage(promotional-event-599-black-friday-2025.html)`: release "19267" → `{ quantity: 3500, upc: "075678604034" }`; "19313" → 1500 / "4895241437960".
  - `fetchSiteIndex` for `2025-november` (events map `{ "2025-november": 599 }`, fake serving `?view=all` → the 599 page (the table fixture also contains quickviews) and the table URL → the same 599 page): entries carry quantity/upc joined (Matchbox Twenty 3500 / "075678604034").
  - Table fetch serves the rendered 601 page (`live-601-rendered.html`) twice while `?view=all` serves the full page: index has 359 entries, quantity/upc set for ≤ 50 of them and null for the rest.
  - `getSiteIndex` memoizes: two calls → the fake's `fetchPage` called for the listing once and the table once.
  - Unlocker null → returns null and logs once across two calls.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**; move code; slim `rsd-site.ts`.
- [ ] **Step 4:** `pnpm vitest run tests/rsd tests/art tests/fetch-art.test.ts` — all pass, including the unchanged 342/353 and 170/173 art headline tests.
- [ ] **Step 5:** full checks; commit `refactor(rsd): shared recordstoreday.com site index with descriptions, tracklists, quantity and UPC`.

---

### Task 2: Contract fields

**Files:** Modify `scripts/types.ts` (`ReleaseSchema` only), `tests/types.test.ts`, `README.md` (data contract section).

- [ ] **Step 1: Failing tests** in `tests/types.test.ts`: a release with all four new fields parses; one with none parses (existing files stay valid); `tracklist: []` parses; `quantity: 0` and `-1` and `2.5` fail; `upc: "12ab"` and `"1234567"` fail, `"075678604034"` passes, `null` passes; `rsdUrl: "not a url"` fails, `null` passes; unknown extra keys still fail (`.strict()` kept).
- [ ] **Step 2:** add to `ReleaseSchema` (keep `.strict()`):

```ts
    /** Track listing as printed on recordstoreday.com, one line per entry. */
    tracklist: z.array(z.string().min(1)).optional(),
    /** Pressing size from recordstoreday.com; null when unknown. */
    quantity: z.number().int().positive().nullable().optional(),
    /** Barcode from recordstoreday.com; null when unknown. */
    upc: z.string().regex(/^\d{8,14}$/).nullable().optional(),
    /** The release's recordstoreday.com page; null when unknown. */
    rsdUrl: z.string().url().nullable().optional(),
```

- [ ] **Step 3:** README data contract: document the four keys (optional, additive, sources) and that `description` is now populated from RSD.
- [ ] **Step 4:** full checks (`pnpm validate` must pass on the existing repo data); commit `feat(contract): optional tracklist, quantity, upc and rsdUrl on releases`.

---

### Task 3: Parser partial rows and row repair at ingest

**Files:** Modify `scripts/extract/parser.ts`, `scripts/extract/types.ts` (Extractor gains optional `partialRows?: () => ExtractedRow[]`), `scripts/extract/index.ts` (`CascadeInput.repair?`), `scripts/watch/run.ts`, `scripts/ingest.ts`. Create `scripts/rsd/repair.ts`, `tests/rsd/repair.test.ts`.

**Interfaces:**
- `parser.ts`: `parseRowsDetailed(pdf): Promise<{ rows: ExtractedRow[]; partial: ExtractedRow[] }>` — `partial` = rows the parser currently skips at `if (!artist || !title || !label || !format) continue` (keep category; empty strings for missing fields). `parseRows` returns `rows` only (unchanged). `parserExtractor` gains `partialRows()` returning the last call's `partial`.
- `repair.ts`: `repairRows(rows: ExtractedRow[], partial: ExtractedRow[], entries: SiteEntry[], log?): { rows: ExtractedRow[]; repaired: number }`:
  - For each partial row with an empty title: if `normalize(row.artist) === normalize(e.artist + ' ' + e.title)` for exactly one site entry `e` (or several entries with identical artist+title), set artist/title from `e`.
  - For every row (main and partial) with blank label or format: if exactly one artist+title-equal group of site entries exists and its value is non-empty (all entries agree, or pick by format equality when format is the known side), fill it.
  - Return `rows` (with blanks filled) + partial rows that are now complete; incomplete partials are discarded. Log `repair: recovered N rows, filled M fields`.
- `index.ts`: `CascadeInput.repair?: (rows: ExtractedRow[], partial: ExtractedRow[]) => ExtractedRow[]`; after a successful `extract`, `rows = input.repair ? input.repair(rows, extractor.partialRows?.() ?? []) : rows` before `finalizeRows`.
- `run.ts` / `ingest.ts`: before `runCascade`, `const index = await deps.siteIndex(seasonId, expectedCount)` where `expectedCount = context.previousSameSeason?.length ?? context.lastComparableCount ?? 0`; pass `repair: index ? (r, p) => repairRows(r, p, index.entries, log).rows : undefined`. `WatchDeps` gains `siteIndex: (seasonId: string, expectedCount: number) => Promise<SiteIndex | null>`; default in `watch-rsd.ts` and `ingest.ts` = `getSiteIndex({ seasonId, expectedCount, unlocker: unlockerFromEnv() })`. Existing run tests get a `siteIndex: async () => null` fake.

- [ ] **Step 1: Failing tests** (`tests/rsd/repair.test.ts`): with `parseRowsDetailed(tests/fixtures/2025-november.pdf)` and `parseListing` + `parseTablePage` of the 599 fixture: `partial` contains the David Johansen ×2, Larry June and Matchbox Twenty rows; after `repairRows` + `finalizeRows`, ids include `david-johansen-and-the-harry-smiths-david-johansen-and-the-harry-smiths`, its `-2` variant, and `larry-june-2-chainz-the-alchemist-life-is-beautiful-chopped-not-slopped`, with labels "Chesky Records" and "The Freeminded Records / 2 Chainz / ALC / EMPIRE"; Matchbox Twenty absent (no label anywhere); total = 173 + 3. A fused string matching two different site releases is not repaired. No site entries → output equals today's parser output. Cascade test: unrepaired partial rows never reach the gate (gate sees the same count as today when `repair` is absent).
- [ ] **Step 2–4:** fail → implement → pass; full suite.
- [ ] **Step 5:** commit `feat(extract): recover parser-dropped rows from recordstoreday.com`.

---

### Task 4: Enrichment and barcode Discogs at publish

**Files:** Create `scripts/rsd/enrich.ts`, `tests/rsd/enrich.test.ts`. Modify `scripts/enrich-discogs.ts`, `tests/enrich-discogs.test.ts`, `scripts/watch/publish.ts`, `tests/watch/publish.test.ts`.

**Interfaces:**
- `enrich.ts`: `enrichFromSite(releases: Release[], index: SiteIndex, season: RawRelease[]): { releases: Release[]; changed: number }` — builds site candidates exactly like the art tier (key `photo:<id>`, artist, title, format, photoId), runs `matchReleases(releases, candidates, season)`, and for each accepted pair fills only empty `description`, `tracklist`, `quantity`, `upc`, `rsdUrl` (= `entry.pageUrl`). `changed` counts releases with at least one filled field. Pure; never throws on bad data.
- `enrich-discogs.ts`: accept `(RawRelease & Partial<Pick<Release, 'discogsMasterId' | 'upc'>>)[]`; keep an existing non-null `discogsMasterId`; when `upc` is set, first `GET https://api.discogs.com/database/search?barcode=<upc>&type=release&per_page=1` and use the first hit's `master_id`; fall back to today's artist/title search (incl. the edition-suffix retry). Same rate limiting and auth rules.
- `publish.ts`: order becomes raw → `Release[]` with defaults (carrying forward previous non-empty `description`/`tracklist`/`quantity`/`upc`/`rsdUrl`/`discogsMasterId` by id from the existing releases.json) → `enrichFromSite` when `deps.siteIndex(seasonId, releases.length)` returns an index → `enrichDiscogs` → `writeReleases` → art → register. `PublishDeps` gains `siteIndex`; failures logged and skipped.

- [ ] **Step 1: Failing tests:** `enrichFromSite` on 2026-april releases + view-all 601 index fills a-ha description/tracklist/rsdUrl; never overwrites a preset description or a preset `upc`; leaves unmatched releases untouched; `changed` counts correctly. Discogs (msw): barcode hit → master id; barcode miss → artist/title search used; preset id untouched (no request). Publish: carries forward previous fields; enrich skipped cleanly when `siteIndex` returns null.
- [ ] **Step 2–4:** fail → implement → pass; full suite.
- [ ] **Step 5:** commit `feat(rsd): enrich releases with descriptions, tracklists, quantity, UPC and barcode Discogs ids`.

---

### Task 5: Daily refresh writes data

**Files:** Create `scripts/refresh-season.ts`, `tests/refresh-season.test.ts`. Modify `.github/workflows/refresh-art.yml`.

**Interfaces:** `refreshSeason(opts: { repoRoot: string; seasonId: string; now?: () => string }, deps?): Promise<{ dataChanged: boolean; stamped: boolean }>`:
1. Load `releases/<season>/releases.json` (`ReleaseListSchema`).
2. `getSiteIndex({ seasonId, expectedCount: releases.length, unlocker: unlockerFromEnv() })`; if present, `enrichFromSite`.
3. `enrichDiscogs` for releases whose `discogsMasterId` is null (skip entirely without Discogs credentials, as today).
4. If any field changed: `writeReleases`; if `current.json`'s `id === seasonId`, set `contentUpdatedAt = now()` and `writeCurrent`.
5. Run the art cascade as `fetch-art.ts` does today (empty slots only; writes `art-candidates.json`).
CLI: `pnpm tsx scripts/refresh-season.ts <season-id>`; guarded entry like `register-season.ts`.

- [ ] **Step 1: Failing tests** with injected deps (site index fake, discogs fake, art fake): unchanged data → no write, no stamp; changed → write + stamp when current; changed for a non-current season → write, no stamp; art cascade always invoked.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** `refresh-art.yml`: run `scripts/refresh-season.ts "$SEASON_ID"` instead of `fetch-art.ts`; pass Discogs and MetaBrainz secrets too; stage `releases/$SEASON_ID/` and `current.json`; message `chore: refresh art and data for $SEASON_ID`. `actionlint` clean.
- [ ] **Step 6:** full checks; commit `feat(rsd): daily refresh fills release data and bumps contentUpdatedAt`.

---

### Task 6: Live check, docs, and the app contract hand-off

**Files:** `README.md`; spec status line; new contract doc in `../wax-wishlist-ios` and `../wax-wishlist-android`.

- [ ] **Step 1: Live check** (≤ 4 Unlocker requests; Discogs credentials unset unless `.env` has them; temp copies under `/tmp`, never the real `releases/`): re-ingest `tests/fixtures/2025-november.pdf` as season `2025-november` into a temp repo with `ingest.ts --dry-run`-style instrumentation or a throwaway script calling `runCascade` with repair, then `enrichFromSite`; report: rows recovered (expect 3), releases with description / tracklist / quantity / upc / rsdUrl out of the total, and (if credentials exist) Discogs coverage before/after.
- [ ] **Step 2:** README: "Release data from recordstoreday.com" (what's filled, when, never-overwrite, the four optional fields, repair, daily refresh, Bright Data request counts).
- [ ] **Step 3: Contract hand-off.** In each app repo, find the existing docs location (look for `docs/`, a `DataContract` folder, or a README section that documents `releases.json`; iOS has `WaxWishlist/Sources/DataContract/DTOs.swift`, Android `data/remote/*`). Write `docs/data-contract/releases-json.md` (or alongside existing contract docs) covering: every `releases.json` field (type, nullability, example, meaning, source); the four new optional fields and the now-populated `description`; decoding rules (all new keys optional; unknown keys must stay ignored — cite `ignoreUnknownKeys = true` / synthesized `Decodable`); refresh semantics (`contentUpdatedAt` bump); suggested UI uses (tracklist on the detail view, "Limited to N" from quantity, UPC for store lookup, an RSD page link); and a real example object for a-ha *Analogue* from the enriched data. Commit locally in each repo with the repo's own author config (`git -C <repo> log -1 --format=%ae` to match). Do not push.
- [ ] **Step 4:** spec status → "Implemented (2026-10-xx)"; commit `docs(rsd): release-data runbook and live-check results`.

## Execution order

Tasks 1 → 6 in order (each builds on the previous). Bright Data is configured; only Task 6's live check spends Unlocker requests.

## Self-review notes

- Spec coverage: contract (T2), site index incl. table join and memoization (T1), repair (T3), enrichment + barcode Discogs (T4), daily refresh + stamping (T5), live check + hand-off (T6), error handling across T1/T3/T4/T5.
- Markup specifics for description/tracklist parsing are taken from the recorded fixtures in Task 1 rather than fixed here; the tests pin the a-ha example.
