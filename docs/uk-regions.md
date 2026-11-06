# UK list and release regions

Status: built on `feat/uk-regions`, not live. Nothing in `releases/` carries
`regions` until `ingest-uk` runs for a season.

## What changes in the data contract

`releases/<season>/releases.json` gains one optional field per release:

| `regions` | Meaning |
|---|---|
| absent | Season has no UK list merged. Treat as US-only (today's behaviour). |
| `["us"]` | On the US list only. |
| `["us","uk"]` | On both lists. |
| `["uk"]` | **UK exclusive**: not sold in US stores. |

Once a season has a UK list, **every** release in it has `regions`.

UK exclusives are ordinary release objects otherwise:

- `category` is always `exclusive`.
- `description` is usually empty, and there's no `tracklist`, `quantity`,
  `upc` or `rsdUrl`. The UK PDF has only artist, title, label and format.
- `artFilename` is `<id>.jpg` like every release; art arrives through the
  usual cascade (Discogs, MusicBrainz, art-admin).
- Ids follow the US scheme (`slugify(artist + title)`), with `-uk` appended
  when that id is already taken by a US release.

Artist names are written the US way ("The Coral", not "Coral, The"); formats
use straight inch marks (`12"`), as the US list does.

## What the apps need before this goes live

Both decoders already ignore unknown keys (Android `ignoreUnknownKeys = true`,
iOS synthesized `Decodable`), so the field itself is safe to ship early. The
UK exclusives are the reason for the app update: today's apps would show 40
records US shoppers can't buy, unmarked.

Minimum app work:

1. Decode `regions` as an optional string array (`[String]?` /
   `List<String>?`). Unknown region values should be ignored, not fail.
2. A region preference (US / UK), defaulting from the device locale/region.
3. Filter Browse to releases whose `regions` include the user's region
   (absent `regions` counts as `["us"]`).
4. Badge cross-region items when showing them at all: e.g. "UK exclusive"
   for `["uk"]` to US users, "US only" for `["us"]` to UK users.

Wishlisted items that later turn out to be outside the user's region should
stay on the wishlist, badged, rather than silently disappear.

## Pipeline

- `scripts/uk/parse.ts`: parses recordstoreday.co.uk's four-column PDF.
- `scripts/uk/merge.ts`: fuzzy-matches UK rows to US releases (artist + title,
  format as a tie-break, one-to-one), tags regions, builds UK exclusives.
- `releases/<season>/uk.json`: the parsed UK rows plus source URL. Every US
  publish (watcher or manual `ingest`) re-applies it, so a US revision keeps
  the regions and the UK exclusives.
- `releases/<season>/uk-overrides.json` (optional): fixes for the matcher,
  keyed by the UK row key shown in the report:

  ```json
  {
    "match": { "cher-christmas-ep-12": "cher-christmas-dj-party-edition" },
    "ukOnly": ["some-row-key-lp"]
  }
  ```

- `scripts/ingest-uk.ts` / the `ingest-uk` workflow:
  `pnpm tsx scripts/ingest-uk.ts <season> <pdf-url> [--dry-run]`. Omit the URL
  to re-merge the saved `uk.json` after editing overrides. Prints (and writes
  to the step summary) the matches to check and the UK exclusives.
- The gate and site repair see only US releases, and the daily refresh never
  matches a UK exclusive against recordstoreday.com, so neither can misfire on
  UK rows.

## 2026 Black Friday, measured

151 UK rows: 111 on both lists, 40 UK exclusives, 75 US-only. One match flagged
for review (Cher "Christmas EP" 12" → "Christmas – DJ Party Edition").

## Not built yet

- **Discovery.** The PDF URL is an unguessable id, but
  `https://www.recordstoreday.co.uk/black-friday` links it in plain HTML (not
  blocked, `robots.txt` allows it), so a watcher could find it.
- **Art and descriptions for UK exclusives.** Every release has a page at
  `https://www.recordstoreday.co.uk/release/<slug>` whose `og:image` is the
  cover (500×500 WebP) and which carries a description. Slugs are the site's
  own (`coral-butterfly-house-acoustic-version`), but `sitemap.xml` lists them
  all, so the merge matcher can pair rows with slugs.
