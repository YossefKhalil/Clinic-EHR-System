# M3 — Readers and intake

| | |
|---|---|
| **Status** | Complete — sniffing, intake validation, the five readers, the chunker and the preview summary are in |
| **Spec** | §5.1–5.4 (limits, intake, readers), §6.1–6.4 (pooling, chunk format, boundaries, row budgets), §15 (edge cases) |
| **Exit criteria** | Reader fixtures pass; a 500-row sheet chunks correctly; rejected types give clear messages — enforced by `npm test` (see below) |

Everything under `src/features/import-agent/` is plain ESM: no DOM, no Node built-ins, all tunables read
from `@import-core/limits.js`, so the same code runs in the browser and (later) in Edge Functions.

## 1. Module layout

| Module | Responsibility |
|---|---|
| `intake.js` | `validateIntake` (empty / size / deep checks), `analyzeFile` (+ SHA-256, size), `sha256Hex`, `hashWarning`, `formatBytes` |
| `preview.js` | `buildPreview` — per-source counts, columns, the privacy line, duplicate-hash warnings |
| `chunker.js` | `poolSources` (S-ids, composed lines, canonical copy), `splitRecords`, `chunkPool`, `prepareSources` |
| `readers/index.js` | content sniffing (`sniffKind`, `readZipIndex`, `isZipBomb`, `isTextLike`) and `readFile` / `readPastedText` dispatch |
| `readers/table.js` | shared rows-source logic: raw cell text, header detection, merges, repeated headers, column selection |
| `readers/spreadsheet.js` | xlsx/xlsm/xls via SheetJS (lazy) — one source per visible sheet |
| `readers/text.js` | encodings, delimiter sniffing, the CSV/TSV parser, prose files and pasted text |
| `readers/docx.js` | mammoth (lazy) → own HTML→blocks parser: paragraphs, lists, tables, images |
| `readers/pdf.js` | pdf.js text layer (lazy) — page checks, RTL sanity check, page separators |
| `readers/image.js` | stub source + warning; the real reader is M8 |
| `readers/reader-error.js` | `ReaderReject` with `code` + `params`; `readFile` returns `{ok:false, ...}` instead of throwing |

## 2. Intake and sniffing (spec §5.1–5.2)

- **Content only, never the extension.** Order: ZIP signatures → part names (`xl/workbook.xml` ⇒ xlsx,
  `word/document.xml` ⇒ docx, anything else ⇒ unsupported); OLE2 → stream names (`Workbook`/`Book` ⇒ xls,
  `WordDocument` ⇒ legacy `.doc` rejection, otherwise unsupported); `%PDF-` ⇒ pdf; image signatures
  (png/jpeg/gif/webp/bmp/heic) ⇒ image; text-like bytes ⇒ text; anything else is rejected — there is no
  fall-through to "treat as text".
- **Zip-bomb guard reads the central directory only** — no decompression. A container is refused when the
  declared uncompressed total exceeds 100 MB or 50× the compressed total (both in `limits.js`). Zip64
  containers count as unreadable (the classic limit-bypass).
- **PDF encryption** is probed cheaply by looking for `/Encrypt` before any parsing.
- **Pasted text** takes the text path directly, with the `MAX_TEXT_CHARS` budget.
- `analyzeFile` returns `{ ok, kind, detail, size, sha256, warnings }`; duplicate hashes produce the
  `FILE_SEEN_BEFORE` warning with the earlier import date (lookup accepts a Map, an array of
  `{sha256, date}` rows, or a plain object).

## 3. Readers (spec §5.4)

### Spreadsheets

- One source per visible sheet, named `file.xlsx › Sheet` (spec §6.1's `(file, sheet)` example) — no
  `# Sheet:` marker lines; per-sheet `R{excelRow}` ids keep real workbook rows and stay unique in the pool.
- Raw values only: numbers use the underlying double (`29805151201234` never becomes `2.98E+13`),
  date cells become `YYYY-MM-DD` via UTC getters (SheetJS constructs dates in UTC; verified by fixture
  round-trip).
- Header = first row with ≥ 3 label-like cells; title rows above it are counted, not sent. Merged header
  cells propagate the top-left value across the range for the header row only; columns filled that way are
  remembered so a repeated header row (common in printed exports) still matches even though it does not
  repeat the merge.
- Fully empty rows and serial-only rows are dropped and counted; repeated headers are dropped and counted.
- Hidden sheets are skipped with `HIDDEN_SHEETS_SKIPPED`; `includeHiddenSheets` opts specific sheets in
  (the preview asks the user).
- **Shared job budget**: `maxRows` (default `MAX_ROWS`) is consumed across sheets; a sheet stops mid-way
  with `ROW_BUDGET`, and sheets that never got a turn add `SHEETS_NOT_READ`.

### Text-like files

- Encoding: BOM (utf-8/utf-16le/utf-16be) → strict UTF-8 → **Windows-1256 fallback** with the
  `CSV_ENCODING` warning naming the encoding actually used.
- Delimiter sniffs `,` `;` tab: a candidate wins when ≥ 80% of rows agree on a column count above one;
  ties prefer the delimiter with more columns.
- The parser is ours (not SheetJS) so record numbers are physical file lines: quoted fields, escaped
  quotes and quoted newlines all advance the line counter correctly — `R{fileLine}` finds the real line.
- `.csv`/`.tsv` without a delimiter fall back to prose with `CSV_AS_TEXT`; `.txt` and pasted text always
  take the prose path (`L001…` ids).

### DOCX

- mammoth's `convertToHtml` with a `convertImage` hook: images are counted (`DOCX_IMAGES_IGNORED`) and
  never sent; mammoth messages become `DOCX_WARNINGS` (count only). Node needs `{buffer}`, browsers
  `{arrayBuffer}` — the input object matches the runtime.
- Our HTML→blocks parser turns headings/paragraphs into lines (a list item becomes `- name`, the normalizer
  already strips list markers), and paragraphs nested inside table cells stay in their cell.
- Each table is **its own rows source** (`report.docx › table 1`), text segments before/between/after are
  their own text sources (`report.docx › text 2`) — so table row ids (`R7`) and text line ids (`L004`)
  never collide in a pool.

### PDF (text layer only until M8)

- pdf.js legacy build (the only one that runs in both browsers and Node), lazy; in the browser the worker
  asset is emitted by Vite (`?url`) and wired to `GlobalWorkerOptions`; evaluation of embedded JS stays
  disabled.
- A page without a usable text layer (≥ 40 chars and < 5% replacement/private-use) is skipped with
  `PDF_PAGE_NO_TEXT`; scanned pages get their rasterize → image-reader fallback in M8.
- The reversed-Arabic sanity check folds and reverses tokens against a small dictionary of common clinic
  words; ≥ 2 hits mark the page `RTL_SUSPECT` (kept, flagged) for the vision re-read later.
- Lines get global `L###` ids across the document; pages are separated by one empty line, which the
  chunker treats as a record boundary. More than `MAX_PDF_PAGES` pages reject with a "split it" message.

### Images

- M3 records the file as an image stub (orientation/tiling/transcription is M8) with
  `IMAGE_READER_NOT_READY`, so adding a photo today is honest about what will happen to it.

## 4. Pooling and chunking (spec §6.2–6.4)

- `poolSources` assigns `S1…Sn` and composes every line as `<id> | <content>` (the header line too).
  A canonical copy is computed with `canonicalizeBlock` (Arabic-Indic digits, invisible characters,
  whitespace); when it differs, the pooled line carries `canonical` and **the payload uses it** — the wire
  format is what the grounding rules will later match. Blank lines keep a `blank` flag for boundary
  detection and never leak it into the payload.
- Text records split at the spec's boundaries — a blank line, a numbered item (`2- Mona`, `مريض 3: سارة`),
  or a 14-digit id immediately after another — evaluated on the canonical text.
- Text chunks accumulate whole records up to `TEXT_CHUNK_TARGET`; a record over `TEXT_CHUNK_MAX` alone is
  cut at line ends with `TEXT_CHUNK_OVERLAP_LINES` shared lines and `boundary_uncertain: true` from the
  second piece on (the first still starts at a known boundary).
- Sheet chunks hold `SHEET_CHUNK_ROWS` rows with the composed header repeated as the first string of
  `header`; `MAX_CHUNKS` caps the pool with the `CHUNK_CAP` warning.
- Payload per chunk: `{ chunk_id: 'c1…', source_id, kind, header, lines: [{ id, text }], boundary_uncertain,
  image_ref }` — ids only, text only, no HTML.

## 5. Messages (i18n)

35 keys per locale were added to `src/locales/en.json` and `ar.json`:
`importAgent.reject.*` (13), `importAgent.warn.*` (14) and `importAgent.preview.*` (8) — one key for every
`code` any reader or intake check can emit. Appendix D writes placeholders as `{name}`; the repo's `t()`
substitutes `:name`, so the keys follow the repo (the Appendix is a sketch). Rendering reaches the UI with
M5; until then the exit criterion "rejected types give clear messages" is proven by tests asserting the
exact `code`/`params` pairs against the key list.

## 6. Deliberate choices and deviations

- **Each sheet is a source** (§6.1) instead of `# Sheet:` marker lines inside one text stream: global
  `S{n}:R{row}` ids stay unique per sheet, row numbers stay real, and the preview can show/per-column-check
  each sheet. Table sources follow the same rule, which is also forced by the `SRC_REF` shape in
  `verify.js` (`prefix:letters digits` — one colon, no nested table ids).
- **Wire-truthful payload**: `text` in chunk lines is the canonical copy; pooled records keep the original
  plus an optional `canonical` field, so nothing is lost for the review UI.
- **Our CSV parser** instead of SheetJS for csv/tsv: `cellDates`/formatting heuristics would fight the
  "raw values, real line numbers" rules, and encoding/delimiter reporting is ours anyway.
- The **rows header detection is positional**: ≥ 3 label-like cells; the metadata field of question
  ("header row check") is handled here, not at intake.
- **Documented non-guarantee**: a PDF whose producer positioned words without spaces can still yield
  jammed words; the RTL suspect check and the review UI are the safety nets, the M8 vision path is the
  cure.
- Encoding names in messages are the `TextDecoder` labels (`utf-8`, `utf-16le`, `windows-1256`).
- The readers are not imported by the app UI yet (M5 does that); during M3 the production build was
  verified with a temporary import — xlsx, mammoth and pdf.js became separate lazy chunks (xlsx 500 kB,
  mammoth 304 kB, pdf.js 542 kB + its 2.4 MB worker asset) and the app entry stayed untouched.

## 7. Tests and fixtures

- Fixtures: `tests/fixtures/readers/` — `patients.xlsx` (500 data rows, merged `Paid` header, repeated
  header at row 150, empty row 151, serial-only row 152, hidden `Scratch`, second sheet `October`),
  `arabic.csv` (BOM, quoted newline), `legacy-1256.csv`, `single-column.csv`, `announcement.txt`,
  `report.docx` (heading, list, table, image), `notes.pdf` (3 pages, page 2 text-less), `long.pdf`
  (21 pages). Regenerate deterministically: `node scripts/generate-reader-fixtures.mjs`.
- `tests/helpers/zip-writer.mjs` builds real zips (also inside tests) and can declare inflated sizes, which
  is how the zip-bomb guard is tested without allocating bombs.
- Hostile inputs are synthesized in tests, never committed: declared-size bombs, broken zips, encrypted
  PDF probe, over-limit files.
- Suites: `sniff-intake`, `readers-text`, `readers-sheet`, `readers-docx`, `readers-pdf`, `chunker`,
  `preview` (73 tests). The M3 exit criterion — a 500-row sheet chunks correctly — asserts 34 sheet chunks
  with the header repeated and the batch of 5 in the last chunk, plus the `October` chunk (35) once the
  budget allows it; with the default 500-row budget the sheet alone fills it and `SHEETS_NOT_READ` says so.
