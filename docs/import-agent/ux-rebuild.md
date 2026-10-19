# AI Import — UX rebuild brief (Step 0, proposed)

Status: **proposed — pending review**. Companion artifact:
`public/mockups/import-ux.html` — mock v3 (open `/mockups/import-ux` on the branch preview).

v2 revision (from owner feedback on v1): the mock now runs at the full container width
of the patients page (v1 squeezed itself to 1080px), and review has two modes —
Simple (default) and Advanced.

v3 revision (from owner feedback on v2): every review row opens the **complete extracted
record** — all 17 registry fields, grouped like the intake form — not just the five scan
columns; the import bar carries the one field the AI never extracts (section).

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
5. **Problems first.** In Advanced, rows sort by severity and a "Next issue" action
   walks the reviewer through problems. Issue state = marker + tint + badge, never
   tooltip-only. In Simple, flagged rows keep their amber/red cell tints and badges so
   the eye finds them without machinery.
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
  marker column, bulk selection, attention strip, filter chips, duplicate resolution,
  row expansion with source, collapsed strips and bulk fill. The import bar is the same
  in both modes.
- **Status vocabulary** (patients-style badges): `Ready` (success), `Check` (warning),
  `Problem` (danger, skipped unless fixed), `Duplicate` (info, resolved in Advanced —
  skipped if left unresolved), `Removed` (secondary). Counts live in filter chips
  (Advanced) styled like the patients filters.
- **Row expansion is the full record.** Every row — in both modes — opens the complete
  extracted record: all 17 registry fields in intake-form groups (personal, demographics,
  address, visit data, notes), each editable in place. The table columns are only the
  scanning surface; nothing the AI extracted is unreachable. In Advanced the panel adds
  the source quote and row actions (row looks good / remove). One row expanded at a time
  on phones.
- **Section picker.** The AI never extracts `section` (it is authorization-relevant);
  the import bar carries one picker that applies a section to every row, and the row
  record has a per-row select. Import rejects rows without a section.
- **Attachments are out of scope**: they are Cloudinary uploads on the patient page,
  not extractable data; the record panel says so.
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
i18n test infrastructure and all existing tests. New surfaces are rendered from the
same review state; no rule changes are part of the UX rebuild.

## Baby steps (one commit + preview build each)

1. **Entry + shell** — dropdown entry, flag check (new `import_agent_enabled` read),
   import page shell with the start card; delete the navbar item.
2. **Review table I (Simple)** — five-column patients-style table, read-only, wired to
   `review.js`; mode toggle in place (Advanced shows an empty state until step 4).
3. **Review table II (Simple, editable)** — click-to-edit cells, the row Details panel
   with the complete 17-field record, issue tints/badges, autosave.
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
