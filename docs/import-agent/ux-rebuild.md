# AI Import — UX rebuild brief (Step 0, proposed)

Status: **proposed — pending review**. Companion artifact:
`public/mockups/import-ux.html` (open `/mockups/import-ux.html` on the branch preview).

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
   table, but editable". No 18-column spreadsheet grid.
4. **Problems first.** Rows sort by severity; an attention strip and a "Next issue"
   action walk the reviewer through problems. Issue state = marker + tint + badge,
   never tooltip-only.
5. **Source on demand.** The original text for a row is one expansion away (right side
   on desktop, stacked below on phones) — not a separate drawer.
6. **Quiet by default.** No alerts on entry, no resume banner, no autosave noise.
   Resumability surfaces as a "Continue import" item inside the same dropdown.
7. **Bilingual and device-parity.** Arabic/RTL and small screens are first-class at
   every step; layouts mirror and stack structurally, not as afterthoughts.

## Flow

| Moment | Surface |
|---|---|
| Entry | Patients toolbar → Add New Patient ▾ → Import from file or paste |
| Add | Drop zone + paste box + "More options" (section, hints) — one card |
| Working | Rows appear in the table as chunks finish; a slim progress strip sits above |
| Review | Draft rows in patients-table style; problems first; inline row expansion with source |
| Import | Sticky bottom bar → inline confirm strip → toast; lands back on Patients |
| Resume | Dropdown item "Continue import · N rows ready" (only when a job is unfinished) |

## Screen notes

- **Status vocabulary** (patients-style badges): `Ready` (success), `Check` (warning),
  `Problem` (danger, skipped unless fixed), `Duplicate` (info, resolved inline),
  `Removed` (secondary). Counts live in filter chips styled like the patients filters.
- **Row expansion** replaces the old drawer: remaining registry fields + source quote +
  row actions (row looks good / remove). One row expanded at a time on phones.
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
2. **Review table I** — render draft rows in patients-table style (read-only), filters,
   attention strip; wired to `review.js`.
3. **Review table II** — inline editing, issue states, row expansion with source.
4. **Import strip + strips** — bulk fill, unmapped/removed strips; inline confirm
   (wired to the real commit endpoint when M6 lands — M6 stays scheduled as-is and
   plugs into this bar).
5. **Responsive + RTL pass**, delete old markup/styles, i18n additions with the
   completeness test.

Each step lands on `ai-import-rebuild`; the preview rebuilds automatically.

## Open questions for review

- Column set for the review table: mirror the patients table exactly (proposed) or add
  an "issues" summary column?
- Does "problems first" sorting feel right for the clinic staff, or should extracted
  order be preserved by default?
- Bottom import bar: sticky on scroll (proposed) or inside the card footer?
