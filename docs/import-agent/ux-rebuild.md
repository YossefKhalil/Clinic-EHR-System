# AI Import — UX rebuild brief (Step 0, proposed)

Status: **proposed — pending review**. Companion artifact:
`public/mockups/import-ux.html` — v4, the live-feel preview (open `/mockups/import-ux` on
the branch preview; full EN/AR toggle, no design annotations).

v2 revision (from owner feedback on v1): the mock now runs at the full container width
of the patients page (v1 squeezed itself to 1080px), and review has two modes —
Simple (default) and Advanced.

v3 revision (from owner feedback on v2): every review row opens the **complete extracted
record** — all 17 registry fields, grouped like the intake form — not just the five scan
columns; the import bar carries the one field the AI never extracts (section).

v4 revision (from owner feedback on v3): the record panel is restyled to mirror the
Patient Intake Registry exactly (same numbered blue section headers, icons, colors and
field order — muscle memory); Section is now read from the file when present; a source
image is attached to the patient automatically; the mock is bilingual EN/AR and
annotation-free.

## Why

The M5 surface failed at first contact: the feature lived as a separate navbar page,
the first screen was wizard chrome, and basic actions (bulk edit, confirm) used
interruptive modals — one of which could even open with "0 rows" selected. The owner
never reached the review screen before rejecting the flow.

The rebuild keeps the engine (rules, validation, dedupe, revalidation, persistence —
everything behind `review.js`/`api.js`, all 351 tests) and replaces the entire surface.

## Principles

1. **The patients page is the home.** Entry lives in the "Add New Patient" dropdown
   (`Import from file or paste`). No navbar item; the dropdown hides when the feature
   flag is off (the M5 build forgot the flag check — restored in the rebuild).
2. **One screen that grows.** Add → extract → review → import happen on one page.
   No step pills, no separate "extracting" screen, no modals for confirmations —
   confirmation is inline, in place.
3. **Patients-table DNA.** Review rows use the exact visual language of the patients
   table (card + `table-hover`, `table-light` head, badges, row rhythm) — "the patients
   table, but editable". No 18-column spreadsheet grid. The review table renders at the
   same full container width as the patients page.
4. **Simple by default, advanced on demand.** Review opens in a calm mode: five columns
   (name, national ID, mobile, governorate, status), no bulk selection, no chips; fix a
   cell by clicking it. Everything for messy data — attention strip, "Next issue",
   filters, duplicate resolution, source expansion, strips, bulk fill — lives behind an
   Advanced toggle in the review header. The choice is remembered per user. Nothing
   auto-switches modes.
5. **Problems first.** In Advanced, rows sort by severity; one filter toolbar (chips
   with counts) plus a "Next issue" action walks the reviewer through problems. Issue
   state = marker + tint + badge, never tooltip-only, and never extra helper rows in
   the table — duplicate resolution and problem guidance open inside the row's own
   expanded panel. In Simple, flagged rows keep their amber/red cell tints and badges
   so the eye finds them without machinery.
6. **Source on demand.** The original text for a row is one expansion away in Advanced
   (right side on desktop, stacked below on phones) — not a separate drawer.
7. **Quiet by default.** No alerts on entry, no resume banner, no autosave noise.
   Resumability surfaces as a "Continue import" item inside the same dropdown.
8. **Bilingual and device-parity.** Arabic/RTL and small screens are first-class at
   every step; layouts mirror and stack structurally, not as afterthoughts.

## Flow

| Moment | Surface |
|---|---|
| Entry | Patients toolbar → Add New Patient ▾ → Import from file or paste |
| Add | Drop zone + paste box + "More options" (section, hints) — one card |
| Working | Rows appear in the table as chunks finish; a slim progress strip sits above |
| Review | Draft rows in patients-table style; Simple mode by default (five-column scan; every row opens its full 17-field record); Advanced toggle for issues/duplicates/source |
| Import | Sticky bottom bar → inline confirm strip → toast; lands back on Patients |
| Resume | Dropdown item "Continue import · N rows ready" (only when a job is unfinished) |

## Screen notes

- **Review modes.** A small segmented toggle in the review header: `Simple` (default) /
  `Advanced`, remembered per user. Simple renders five columns — name, national ID,
  mobile, governorate, status — at the patients-page width, no checkboxes or chips;
  cells are click-to-edit, flagged cells keep their tint and badge. Advanced adds the
  marker column, bulk selection, one filter toolbar (chips with counts + a "Next issue"
  button), source expansion, collapsed strips and bulk fill. The import bar is the same
  in both modes.
- **Issues live in the row, not in the table.** The table never grows helper rows for
  duplicates or problems. A row's issue opens inside its expanded panel: a compact
  banner at the top of the record (with "Row looks good" / "Remove row"), a comparison
  card for duplicates ("This row" vs the partner, keep/skip/compare) and a one-line
  fix-or-remove banner for blocked rows.
- **Status vocabulary** (patients-style badges): `Ready` (success), `Check` (warning),
  `Problem` (danger, skipped unless fixed), `Duplicate` (info, resolved in Advanced —
  skipped if left unresolved), `Removed` (secondary). Counts live in filter chips
  (Advanced) styled like the patients filters.
- **Row expansion is the full record, in intake-form clothes.** Every row — in both
  modes — opens the complete extracted record: all 17 registry fields, wearing the exact
  structure of the Patient Intake Registry (same numbered sections 1–5, same icons and
  colors: red Problem, green Diagnosis & Treatment Plan, blue section headers, notes
  list with Add Note, Attachments). The table columns are only the scanning surface;
  nothing the AI extracted is unreachable. In Advanced the panel adds the source quote
  and row actions (row looks good / remove). One row expanded at a time on phones.
- **Section is read from the file when present** (owner decision, see engine deltas):
  an extracted section is matched against the user's allowed sections and left blank if
  it doesn't match or isn't in the source. The import bar carries one picker that fills
  the rows that still have none; the record panel also has a per-row select. Rows
  without a section cannot be imported.
- **Source images are attached automatically** (owner decision, see engine deltas):
  when a row's source is an image, that image is saved with the patient at import — an
  additive extra, never a requirement. The record panel shows the attachment chip.
- **Collapsed strips** under the table replace the trays: unmapped lines, removed rows,
  and the bulk "fill blanks with common values" panel (defaults, re-housed inline).
- **Extraction strip**: while the job runs, a thin progress line with `done/total` and
  the current source — the page stays usable; failures surface as one inline line with
  a retry action.

## What gets deleted (versus M5)

- Navbar entry point; wizard step pills; the full-page extracting screen.
- Bulk-edit modal; confirm modal; resume alert bar; autosave banner.
- 18-column virtualized grid; mobile card fallback; row drawer; source drawer; trays.
- The inline `<style>` block with hardcoded colors in `index.html`.

## What stays untouched

`review.js` (39 pure functions), `api.js`, `import-core`, the edge functions, schema,
i18n test infrastructure and all existing tests — with one agreed exception, the two
engine deltas below. New surfaces are rendered from the same review state; no rule
changes are part of the UX rebuild itself.

## Engine deltas agreed with the owner

1. **`section` becomes an extracted field.** The registry currently marks it
   `extract: false` ("authorization-relevant, never guessed"). The owner decided the AI
   may read it from the import data. Implementation: flip the registry flag, regenerate
   the extractor guide, keep `enumMatch` against the user's allowed sections — an
   unmatched or absent section stays blank and must be picked by a human.
2. **Source-image attachment.** On commit, rows whose source is an image get that image
   saved with the patient (the job file already exists in storage; the commit copies the
   reference/image into the patient's attachments). Additive detail, no new required
   step. Lands with the M6 commit work.

## Baby steps (one commit + preview build each)

1. **Entry + shell** — dropdown entry, flag check (new `import_agent_enabled` read),
   import page shell with the start card; delete the navbar item.
2. **Review table I (Simple)** — five-column patients-style table, read-only, wired to
   `review.js`; mode toggle in place (Advanced shows an empty state until step 4).
3. **Review table II (Simple, editable)** — click-to-edit cells, the row Details panel
   with the complete 17-field record styled as the intake registry, issue tints/badges,
   autosave.
4. **Advanced mode + import** — attention strip, "Next issue", filter chips, duplicate
   resolution, row expansion with source, collapsed strips, bulk fill; sticky import
   bar with inline confirm (wired to the real commit endpoint when M6 lands — M6 stays
   scheduled as-is and plugs into this bar).
5. **Responsive + RTL pass**, delete old markup/styles, i18n additions with the
   completeness test.

Each step lands on `ai-import-rebuild`; the preview rebuilds automatically.

## Open questions for review

- Simple column set: name, national ID, mobile, governorate, status — enough, or should
  one more join (visit date? source file)?
- Mode toggle wording: `Simple` / `Advanced`, or friendlier (`Basic` / `Detailed`)?
  Should Advanced ever be the default for super admins, or always start Simple?
- In Simple, keep the extracted (file) order, or still float flagged rows up?
- Bottom import bar: sticky on scroll (proposed) or inside the card footer?
