# Frozen data for tests

Snapshots of the published data files as of commit `61e8671` (2026-10-01),
the last commit where every test passed against the live files. Tests read
these instead of the repo's live `releases/`, `seasons.json`, `current.json`,
`calendar.json` and `rsd-events.json`, so a routine re-ingest or art refresh
can't break them.

Notes:
- `releases/2025-november/releases.json` has 173 releases, what the parser
  reads from `tests/fixtures/2025-november.pdf`. The live file has 176: the
  site repair later added three rows the PDF parser drops (two David
  Johansen and the Harry Smiths editions and Larry June, 2 Chainz & The
  Alchemist's *Life Is Beautiful (Chopped Not Slopped)*).
- Refresh a snapshot only on purpose, together with the tests that pin it.
