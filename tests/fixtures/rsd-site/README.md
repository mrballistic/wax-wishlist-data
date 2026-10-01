# recordstoreday.com fixtures

Recorded 2026-10-01 through Bright Data Web Unlocker (the zone named in `BRIGHT_DATA_ZONE`) with

```sh
pnpm tsx --env-file=.env scripts/art/record-rsd-pages.ts <url> <out-file>
```

The files are the HTML exactly as `createUnlocker().fetchPage()` returns it: raw markup, decoded to UTF-8.
recordstoreday.com returns a CloudFront 403 to plain requests, so every page fetch has to go through the Unlocker.
Product images are on an open CDN and are fetched directly (see below).

## Files

| File | URL | What it is |
|---|---|---|
| `promotional-event-601-rsd-2026.html` | `https://recordstoreday.com/PromotionalEvent/601` | April 2026 listing (`2026-april`): 359 releases, one page, 1.4 MB |
| `promotional-event-599-black-friday-2025.html` | `https://recordstoreday.com/PromotionalEvent/599` | Black Friday 2025 listing (`2025-november`): 177 releases |
| `promotional-event-600-not-found.html` | `https://recordstoreday.com/PromotionalEvent/600` | An unused event id: **HTTP 200** soft "not found" page |
| `special-release-19926-a-ha-analogue.html` | `https://recordstoreday.com/SpecialRelease/19926` | a-ha, *Analogue 20th Anniversary Deluxe Edition*, photo id `418467310484` |
| `special-release-19910-live-a-lolympia.html` | `https://recordstoreday.com/SpecialRelease/19910` | Jeff Buckley, *Live À L'Olympia*, photo id `418467310333` (non-ASCII title) |
| `promotional-event-601-view-all.html` | `https://recordstoreday.com/PromotionalEvent/601?view=all` | April 2026 image grid: 359 quickview blocks, no `<tbody>`. **What the parser fetches.** Saved during the Task 9 live check |
| `live-601-rendered.html` | `https://recordstoreday.com/PromotionalEvent/601` | A bad Unlocker response from the Task 9 live check: a JS-rendered, client-paginated DOM with only 50 of 359 rows (the incomplete-listing test) |

## Character encoding (read before parsing)

The server sends `Content-Type: text/html; charset=ISO-8859-1`, but the page's own `<meta charset="UTF-8">` says UTF-8.
The header is correct: the bytes are Windows-1252 (`À` is the single byte `0xC0`, `’` is `0x92`).
`fetchPage` decodes by the header charset (WHATWG maps `ISO-8859-1` to Windows-1252), so these fixtures contain real
`À`, `’`, `…`. An earlier version that used `res.text()` turned all of them into U+FFFD.

Titles and artists also contain `&amp;` / `&#39;` entities *and* bare `&`, non-breaking spaces (` `, e.g.
SpecialRelease 19761), trailing spaces (`We Are Not Live `) and CR/LF inside a cell (`Captain Beefheart &amp;\r\nThe Magic Band`).
Decode entities, map ` ` to a space, collapse whitespace, and trim.

## URL patterns

- **Event listing:** `https://recordstoreday.com/PromotionalEvent/<eventId>`. April and Black Friday use the same URL
  shape and the same template. There is no event-type or year in the URL.
- **Release page:** `https://recordstoreday.com/SpecialRelease/<releaseId>`.
- **Store availability page:** `https://recordstoreday.com/UPC/<upc>` (not needed for art).
- **Archive:** `https://recordstoreday.com/RSDArchive` links past events by id with a title attribute (`title="RSD 2026"`,
  `title="Black Friday 2024 Archive"`). It is hand-curated and incomplete: it has no Black Friday 2025 link.
- The home page off-season links no event at all. Its nav is just HOME / PODCAST / ARCHIVE / PRESS KIT / MRKT / CHARTS / ABOUT.

### Season id to event id

**The event id cannot be derived from a season id.** Ids are sequential but opaque and not every id is a public event:

| Season id | Event | Event id |
|---|---|---|
| `2024-november` | Black Friday 2024 (11/29/2024) | 596 |
| `2025-april` | RSD 2025 | 597 |
| `2025-november` | Black Friday 2025 (11/28/2025) | 599 |
| (none) | soft 404 | 600 |
| `2026-april` | RSD 2026 (4/18/2026) | 601 |

Ids for older events (from `/RSDArchive`): RSD 2024 593, RSD 2023 590, BF 2023 592 (BF logo, no year text), RSD 2022 585,
RSD Drops 2022 587, BF 2022 588. Ids 598
and 602+ were not checked. Black Friday 2026 (`2026-november`) will be a new id above 601, so a parser needs either a
`season id -> event id` map (simplest, set when a season is registered) or discovery: request ids upward from the
last known one and accept the first real listing whose quickview release dates, by majority vote, fall in the season
(`Date: 4/…/<year>` = `<year>-april`, `Date: 11/…/<year>` = `<year>-november`). The parser does both: `rsd-events.json`,
then probing ids max+1..max+6.

### Telling a real event from a missing one

A missing id still returns HTTP 200 (`promotional-event-600-not-found.html`). It has no `<tbody>`, no
`/SpecialRelease/` links, and contains `we are sorry, but the page you requested was not found`. The `<title>` is
`PromotionalEvent | RECORD STORE DAY` for real and missing events alike, so it is useless here.

To tell *which* season a real listing is, use the date vote: each row's quickview has
`<strong>Date</strong>: 4/18/2026` (M/D/YYYY), and the majority month/year names the season. The table page's
`<a id="anchor" name="RECORD STORE DAY 2026">` looks like an event name but is not reliable: on the `?view=all` page the
anchors name release-type sections instead (see "View-all page" below).

## Listing page (`PromotionalEvent/<id>`)

> **Superseded (Task 9 live check).** The Unlocker *intermittently* returns this URL as a JS-rendered DOM
> (`live-601-rendered.html`): bootstrap-table has already paginated it to 50 rows and re-laid the columns, so
> release type lands where format was. The parser therefore fetches `?view=all` and reads the per-release
> quickview blocks, not table cells; see "View-all page" below. The table description is kept for reference.

**No pagination.** Every release is in the server-rendered HTML in one `<table>` with exactly one `<tbody>`.
The table has `data-pagination="true" data-page-size="50"`, but that is bootstrap-table paginating client-side over rows
that are all already present. No JSON or API call is needed. There is also an `?view=all` ("IMAGES") link that was not
fetched.

Bound the parse to `<tbody>` ... `</tbody>`: **the page has 70 more `<tr>` after `</tbody>`** that are not releases.
Inside, one `<tr>` per release (359 for 601, 177 for 599, every row has a photo).

Each row has 8 `<td>`s (plus a commented-out ninth). The first cell is a quickview popup; the rest are plain cells:

```html
<tr>
  <td>... quickview ...
        <div class="quickview_image image">
            <a href="/SpecialRelease/19926">
                <img alt="Analogue 20th Anniversary Deluxe Edition" title="..." class="img-responsive"
                     src="https://img.broadtime.com/Photo/418467310484:284" />
            </a>
        ...
        <H2 style="...">A-Ha</h2>            <!-- artist; note H2 opened upper-case, closed lower-case -->
        <p><a href="/SpecialRelease/19926"><em>Analogue 20th Anniversary Deluxe Edition</em></a></p>
        <strong>Date</strong>: 4/18/2026<br/> ... Format, Label, Quantity, Release type ...
  </div></td>
  <td><a href="/SpecialRelease/19926">Analogue 20th Anniversary Deluxe Edition</a></td>   <!-- TITLE -->
  <td>A-Ha</td>          <!-- ARTIST -->
  <td>a-ha</td>          <!-- SORT key (hidden): surname-ish, e.g. "Adams" for Bryan Adams; may be empty. Not the artist. -->
  <td>Rhino</td>         <!-- LABEL -->
  <td>2 x LP</td>        <!-- FORMAT -->
  <td>RSD Exclusive </td><!-- RELEASE TYPE: "RSD Exclusive", "RSD Limited Run / Regional Focus", "'RSD First'" -->
  <td>2500</td>          <!-- QUANTITY -->
  <!-- <td><a href="/UPC/081227805869">link</a></td> -->
</tr>
```

Patterns, per row:

- **Release id + photo id:** `quickview_image image">\s*<a href="/SpecialRelease/(\d+)">\s*<img[^>]*src="https://img.broadtime.com/Photo/(\d+):284"`
- **Title:** the first plain `<td><a href="/SpecialRelease/\d+">([^<]*)</a></td>` (or the `<em>` in the quickview).
- **Artist:** the `<td>` right after the title cell (or the quickview `<H2 ...>(...)</h2>`, case-insensitive).
- **UPC:** `/UPC/(\d+)` inside the HTML comment, if needed.

Things a matcher has to cope with:

- **Same title, several release ids** for colour/format variants (e.g. 19761 and 19762; 19910 and 19911), each with its
  own photo id. 359 rows here vs 353 releases in our `2026-april`; 177 vs 173 in `2025-november`.
- Photo ids are unique per row and cluster tightly per event: 601 spans `418467310311`..`418467315351` (median
  `418467310735`); 599 spans `418467303631`..`418467306897` (median `418467303900`).
- Known anchors: a-ha *Analogue* = `418467310484`; 13th Floor Elevators *We Are Not Live* = `418467310726` (first row of 601).

## Release page (`SpecialRelease/<id>`)

Everything the listing has, plus a larger image link. Not needed when the listing is parsed, but useful to confirm one release:

- `og:title`: `RSD '26 Special Release: <Artist> - <Title>` (entities encoded, e.g. `L&#39;Olympia`).
- `og:image:url`: `https://img.broadtime.com/<photoId>:400.jpg` (note: no `/Photo/` segment).
- Main image: `<a href="https://img.broadtime.com/Photo/<photoId>:800"><img src="https://img.broadtime.com/Photo/<photoId>:360" />`
- Artist: `<H2 style="...">A-Ha</H2>`; title on the next line: `<em>Analogue 20th Anniversary Deluxe Edition</em>`.
- Event: `<a href="/PromotionalEvent/601">RECORD STORE DAY 2026</a>` (breadcrumb and DETAILS block).
- UPC: `<a class="btn" href="/UPC/081227805869">CHECK AVAILABILITY</a>`.
- `<script type="application/ld+json">` holds only the Event (name, startDate), not the release.

## Images (direct, no Unlocker)

`https://img.broadtime.com/Photo/<photoId>:<size>`; sizes seen: 284 (listing), 350, 360, 800. Verified 2026-10-01:
`Photo/418467310484:800` returns **`image/webp`** (175 KB) despite the global constraints talking about JPEG, so the
downloader must not assume JPEG; `sharp` normalises it to JPEG anyway. `https://img.broadtime.com/418467310484:400.jpg`
returns `image/jpeg`.

## Request count

11 Unlocker requests in total for this recording session (budget 30):

1. `/` (home page, discovery)
2. `/RSDArchive` (event ids)
3. `PromotionalEvent/601` (first look; decoded with the old `res.text()`, discarded)
4. `SpecialRelease/19926` (first look, discarded for the same reason)
5. `SpecialRelease/19910` via a throwaway probe that read the raw bytes and the `Content-Type` header (found the encoding bug; discarded)
6. `PromotionalEvent/601` (saved fixture)
7. `SpecialRelease/19926` (saved fixture)
8. `SpecialRelease/19910` (saved fixture)
9. `PromotionalEvent/596` (Black Friday 2024, template check only, not saved)
10. `PromotionalEvent/600` (saved: soft 404)
11. `PromotionalEvent/599` (saved: Black Friday 2025)

Requests 10 and 11 were made with the fixed recorder, so their saved HTML is correctly decoded.

## View-all page (`PromotionalEvent/<id>?view=all`): what the parser uses

- An image grid grouped by release type. Every release has the same quickview block as the table page's first cell:
  `quickview_image image">` + `<a href="/SpecialRelease/<id>">` + `<img src="https://img.broadtime.com/Photo/<photoId>:284">`,
  then `<H2 ...>Artist</h2>`, `<p><a ...><em>Title</em></a></p>`, `<strong>Date</strong>: M/D/YYYY`, `<strong>Format</strong>: …`.
  There is no `Quantity` line here.
- 359 blocks for 601, all `Date: 4/18/2026`. No `<tbody>`.
- **The anchor is not the event name here:** `<a id="anchor" name="…">` names each release-type section
  ("RSD Exclusive Release", "RSD Limited Run / Regional Focus Release"). The parser identifies the season by majority vote over
  the quickview dates instead (month 4 = april, 11 = november), on every page shape.
- The same quickview parse works on the table page (359 and 177 blocks) and on the rendered page (only the 50 rows it really
  has). A listing with fewer than 80% of the season's release count is refetched once, then skipped.
