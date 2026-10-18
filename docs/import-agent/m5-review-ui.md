# M5 — Review UI

| | |
|---|---|
| **Status** | Complete. The final commit lands in M6 (M6 wires `importAgent.review.confirm.import` to the commit action); in M5 the confirmation modal shows the real per-partition counts and the final button stays a documented placeholder |
| **Spec** | 10 (review UI), 8.4/8.5/8.6 (issues, duplicates, existence), 5.3 (preview), 6.2 (pooled source ids), 9 (extraction progress), 14.5 (contract), 18 (M5 exit criteria) |
| **Exit criteria** | Resumable review grid, inline with all rules; edit, fill, merge, delete with autosave and undo; the same code renders review and revalidates on reload; issues in both languages (10.10). Deferred to M6: the import button's server side |

The review page is Alpine state plus glue over two tested layers:
`src/features/import-agent/review.js` (pure model — every rule, no DOM) and
`src/features/import-agent/api.js` (every network touch). `ui.js` holds the
component; `index.html` the markup. Nothing opened or edited in review computes
its own rule — every status, issue and validated value comes from re-running the
shared `runPipeline`, the exact code the pump ran (I8).

## 1. Module layout

| Module | Responsibility |
|---|---|
| `import-core/pipeline.js` / `verify.js` | Revalidation inputs: `ground`/`keepPhantoms`/`_cells` prefills, cleared-cell origin retention, defaults guard, no `_`-prefixed meta keys in the unmapped loop |
| `src/features/import-agent/review.js` | Pure review model (below) |
| `src/features/import-agent/api.js` | `import-job` invocation, signed uploads, paged table reads, optimistic row saves, existence context, reject removal |
| `src/features/import-agent/ui.js` | Alpine component: wizard steps, pump loop, grid editors, trays, drawers, undo/redo |
| `index.html` | Nav entry + page markup (grid, drawers, modals, trays) |
| `src/main.js` | `window.importAgentWizard` registration, `navigate('import')` → `importAgentEnter()` |
| `supabase/functions/import-job/index.ts` | `add_row` action; pump persists unmapped text as `import_rejects` rows |
| `supabase/schema.sql` | DELETE policy for `import_rejects` (owner deletes own) |

## 2. Revalidation — the same code (8.10/I8)

`revalidate()` groups rows by `chunk_id` (`__manual__` for manual rows) and
re-runs `runPipeline` per group with the chunk payload's lines reduced to
`{id, text}` (canonical copies stripped — the pump's contract). Only `user` and
`default` origin cells are fed back as `_cells` prefills; snapped and derived
values reproduce themselves deterministically from the same raw inputs. Manual
rows revalidate with `ground: false`. `keepPhantoms: true` keeps rejected
documents visible as phantom rows instead of re-raising them. Cleared cells
keep `origin: 'user'`, so defaults never overwrite a reviewer's deliberate
blank, and the reload rebuilds the defaults panel from `origin: 'default'`
cells merged over `config.defaults`. A chunk whose payload is missing (retention
window) leaves its group untouched instead of flagging everything ungrounded.

Stored issues are replaced wholesale on merge, `pruneAcks` drops
acknowledgements whose key no longer warns, and the result is diffed per row
(`snapshotRow`/`snapshotsDiffer`) so only changed rows persist. The version
number stays monotonic: the guard trigger only accepts `old + 1`.

## 3. Statuses and duplicates (8.5, 10.4)

`effectiveStatus()` resolves the row's pipeline status with the duplicate state:
once `dup.action` is `fill` or `keep`, dedupe codes stop blocking (`DUP_*`) —
`skip` keeps blocking. Grid chips, pills, counts and the review/commit
partitions all read `effectiveStatus`; the stored `status` keeps the pipeline
verdict untouched so server-side revalidation and the triggers stay coherent.

`confirmationCounts()` partitions rows exactly like M6 will commit: importable,
fresh (`duplicateOf` absent), fill-only, skipped errors, skipped duplicate-skip,
removed, and rows with unacknowledged warnings. The confirm modal shows these
real numbers; the import button is disabled while warnings are unacknowledged
(tooltip explains the count) and, when enabled in M5, surfaces the placeholder
note that M6 wires the commit.

## 4. Client API (`api.js`)

- `callJob(action, payload)` wraps `functions.invoke`; a non-2xx response's
  `{ok, code, message_key}` body becomes a thrown `ImportApiError` whose
  `messageKey` the UI renders through i18n — never a raw server string.
- `uploadToSignedCell` posts each file through the `create` step's signed URLs.
- Table reads page at 500 rows until PostgREST returns a short page.
- `saveRow` updates the review fields with `.eq('version', v)` and `version: v + 1`;
  a missed row means another writer moved first → `SAVE_CONFLICT` banner.
- `loadExistingContext(rows)` mirrors the exact engagement rules of 8.6:
  `existing_national_ids` RPC (SECURITY DEFINER — existence across every
  section), an RLS-scoped `patients` read for visibility + the visible patient's
  id, and name+DOB matches built with the same `nameDobKey` the pipeline runs
  (client-side name folding, so review and engine cannot disagree).
- `deleteReject` removes an `import_rejects` row the reviewer just placed into a
  cell (new owner DELETE policy); `fetchSeenHashes` feeds the preview's
  "imported before" warning.

## 5. Server additions

- `add_row` builds the manual row through `runPipeline` (validation,
  derivations, job defaults; grounding off — nothing to cite), inserts with
  `chunk_id = null`, `src = []`, `extracted = null`, and returns the row. RLS
  forbids direct INSERTs, so this is the only path.
- The pump now persists unmapped leftovers at save time as `import_rejects`
  rows (`reason 'UNMAPPED'`, `src {seq}`), so the tray survives reloads.
- Schema DELETE policy "`Owner deletes own rejects`" + RLS assertions in
  `tests/rls/01-access.sql` (owner delete ok; other user's reject denied).
- Fixed a leftover from the grounding rename: `LOW_CONFIDENCE_IMAGE` read the
  dead `ground.citedIds` identifier and would have thrown on image chunks.

## 6. Wizard (`ui.js`) — add → preview → extracting → review

- **Add**: multi-file intake through `analyzeFile` + `readFile` (size/type/zip
  guards, per-file errors and warnings as chips, sha-256 shown), pasted text,
  default section (placed by `app_options`), hints, live `buildPreview` totals
  with the 7-day privacy note and the seen-before hash check.
- **Preview** (5.3): per-source rows/chars/columns/images table; "send" starts
  `create` → per-file signed upload → `add_source` with **client-prepared,
  pre-shifted chunks** (`shiftSourceIds(chunks, index+1)` matches the server's
  idx-by-add-order rule), pasted text chunked server-side (6.2).
- **Extracting**: pump loop (`pump` every 800 ms), progress, token meter,
  banners (`importAgent.warn.*`), cancel, and failed-chunk retry
  (`retry_chunk` requeues; allowed from both extracting and review).
- **Resume**: `latestResumableJob` appears as a bar; `extracting` restarts the
  pump, `uploaded` offers extract, `review` goes straight to the grid.
- **Review load**: parallel fetches, existence context, defaults reconstruction,
  one silent full revalidation whose diffs persist (pump rows may predate rule
  changes).

## 7. Review grid

- **Editors per registry type**: text, number (`dir=ltr` digits), date
  (dd/mm/yyyy text + native picker), enum selects (`enumOptions` from the job's
  enum snapshot; governorate/marital get localized labels), notes open the row
  drawer. Edits go through per-cell 400 ms debounce → `editCell` → revalidate →
  optimistic save. Blur and key-down flush pending drafts; Esc cancels a draft.
- **Cell states** are icon + tooltip + tint (`cellState`): error / warn /
  question (uncertain) / snapped / derived / default / edited / info. Colour is
  never the only signal (10.4).
- **Keyboard**: Tab moves, ArrowUp/Down change rows, Enter commits and moves
  down, Esc reverts, `I` shows the source for select editors; the other editors
  use the drawer button. The hint line states this (10.3).
- **Virtualization**: fixed 52 px rows, pad rows, overscan 8, sticky header;
  the window recomputes from the scroll container. Below `lg` the grid swaps to
  cards (first 30 visible + load-more) with the same actions.
- **Toolbar**: add row, delete/restore selected, set-value bulk (field, value,
  blanks-only vs overwrite), mark reviewed, undo/redo, filter pills with live
  counts, defaults panel toggle, two trays with counts.
- **Defaults panel** (10.2): the registry's `bulkFill` fields; applying
  revalidates every group fill-blanks-only and persists the diffs; clearing a
  default stops filling that field on future edits without touching user cells.
- **Duplicates** (10.6): status badges name the kind (in-batch, existing visible,
  existing hidden, possible, name-DOB); the drawer side-panel shows the partner
  row and the fill/keep/skip actions; keeping a row also skips the collapsed
  partner; overlap copies are labelled "merged copy".
- **Source drawer**: cited lines with context; sheets render as mini-tables,
  text as L### list with the focused cell's value highlighted (`highlightLine`).
- **Trays** (10.7): rejected & unmapped items (reason labels, chunk `#idx`, raw
  text) can be moved into address/problem/solution/notes (appended, cell turns
  user-edited, the reject row is deleted) or seeded by `add_row`-ing a manual
  row; removed rows restore from their tray.

## 8. Messages (10.10)

Both locales gained **191** keys (`issue` for all 46 catalogued codes plus
`VALUE_NOT_IN_SOURCE`, `DATE_RANGE` reason variants `future`/`too_old`/
`before_dob`, every function error code, chunk failure codes, wizard/progress/
review UI) plus 7 file-level intake errors. The completeness tests are driven by
`SEVERITY_BY_CODE` (new code ⇒ missing key fails the suite) and also assert
en/ar key-set parity and identical `:param` placeholders per key — a message
that interpolates what its counterpart does not fails loudly.

## 9. Tests and gates

- `tests/unit/review.test.js` (18) — filters/counts, ack keys, edit/revert/bulk,
  revalidation diffs, effective status, confirmation partitions, virtual window,
  source model, defaults reconstruction.
- `tests/unit/pipeline-review-inputs.test.js` (9) — prefills, cleared-cell
  origin, defaults guard, keepPhantoms, meta-key fix, manual group revalidation.
- `tests/unit/i18n-import-keys.test.js` (7) — bilingual completeness as above.
- RLS suite extended for reject deletion; full suite 351 tests / 28 files,
  coverage gate unchanged (normalizers 100%), `check:registry` 17 fields.
- `eslint` clean; `vite build` bundles the wizard (import-core alias resolves
  from the browser).

## 10. Known limits for M5

- The final Import button in the confirm modal intentionally does not commit —
  M6 adds the `commit` action and switches the button to it.
- Save conflicts surface a reload banner; the winning row's server state is not
  re-fetched per cell (optimistic-versioned saves keep data coherent).
- `I`-to-source is limited to select editors to avoid colliding with typing;
  the drawer button covers text/number/date/notes.
