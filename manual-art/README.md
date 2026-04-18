# manual-art/

Hand-curated album art overrides for releases the automated cascade
(Discogs → MusicBrainz + Cover Art Archive) can't find. Files in this
directory are **tier 3** of the art cascade and **always win** over
auto-sourced art when the release id matches — even if a higher-tier
source also has a hit.

See [`docs/FEATURE_PRD_multi_source_art.md`](../docs/FEATURE_PRD_multi_source_art.md)
for the full cascade spec.

## Filename convention

```
manual-art/<release-id>.<ext>
```

- `<release-id>` must match the `id` of a release in one of the
  per-season `releases/<season-id>/releases.json` files exactly
  (case-insensitive).
- Supported extensions: `.jpg`, `.jpeg`, `.png`.
- If two files share the same basename with different extensions
  (e.g. `foo.jpg` and `foo.png`), `.jpg` wins.

### How to find a release id

1. After the ingest workflow runs, check the generated
   `releases/<season-id>/releases.json`.
2. Each release has an `id` field, e.g. `2026-april-042`.
3. Use that id as the filename: `manual-art/2026-april-042.jpg`.

## Sharing across seasons

This folder is **shared across all seasons** — a single file like
`manual-art/a-ha-hunting-high-and-low-demos.jpg` applies to every
season that contains a release with that id. This is rare in
practice (ids are typically season-scoped) but allows reuse for RSD
Drops reissues.

## Image requirements

| Rule | Value |
|------|-------|
| Format | JPEG or PNG |
| Aspect ratio | Square (1:1) strongly preferred |
| Minimum dimension | 600 × 600 pixels |
| Maximum file size | 10 MB |

Images are automatically re-encoded to JPEG at 600×600 max (preserving
aspect ratio, no upscaling) during the ingest job. The original file
in `manual-art/` is never modified — only the copy written to
`releases/<season-id>/art/` is resized. Source files below 600 pixels
on the longest side pass through at their original size.

## Sourcing rules — read before committing

Committing a file here is **a public, permanent, git-tracked
publication**. Anything added is effectively distributed under the
repo's license the moment it's pushed. Treat every file like you would
any other asset you ship.

### Acceptable sources

- Official artist or label promo channels (press kits, EPKs, "download
  press assets" pages)
- Direct label correspondence
- Scans the maintainer legally owns (personal collection) where
  publishing a scan for identification purposes is permitted

### Not acceptable

- Third-party image hosts with unclear rights
- Instagram, Twitter/X, or Bluesky reposts of other photographers'
  work
- Discogs user uploads (those are already tier 1; rely on the API)
- MusicBrainz / CAA thumbnails already returned via tier 2
- Any image lacking a documentable rights-to-redistribute chain

## Orphan file warning

The ingest workflow prints a warning at the end of each run listing
any files in `manual-art/` whose basename doesn't match any release id
in the current season. If you see a warning for a file you expect to
be used, double-check the filename against the generated
`releases/<season-id>/releases.json`.
