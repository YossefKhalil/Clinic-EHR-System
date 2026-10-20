# Review screen screenshots

Reference captures of the v6 review surface (the mockup target is
`public/mockups/import-ux.html`).

- `review-simple.png` — Simple mode: five columns + Details, the inline record
  panel with the 17 fields, the sticky import bar.
- `review-advanced.png` — Advanced mode: the filter chips, "Next issue", the
  full table (source, section, follower, visit date), the record panel with the
  source column, the duplicate panel and the strips.

Both were taken against the mock route (`?mock=review`), which renders the
real component with mock rows. They were captured *before* the audit fixes of
2026-10-21, so they still show the defects that were fixed afterwards (the
empty red banner, the always-visible "removed by you" strip, the duplicated
row numbers). Use them as a "before" reference; the current state is in the
audit document.
