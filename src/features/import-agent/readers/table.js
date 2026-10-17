// Shared table logic for "rows" sources (spec §5.4): spreadsheet sheets,
// delimited text (csv/tsv) and DOCX tables all reduce to a grid of cells and
// become one source with a header line plus data lines that keep the file's
// own row numbers. Pure module — no DOM, no libraries.

import { foldForMatch } from '@import-core/canonicalize.js';

// ---------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------

/**
 * Format a date cell (SheetJS `cellDates: true`) as `YYYY-MM-DD`. UTC getters
 * are used because SheetJS constructs its dates in UTC; verified by the
 * fixture round-trip test.
 */
export function formatDate(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Raw cell value to text (spec §5.4). Numeric cells use the underlying double,
 * never the formatted display text, and integers are stringified exactly —
 * `29805151201234` never becomes `2.98E+13`.
 */
export function cellToText(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return formatDate(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        if (Number.isInteger(value)) {
            // Beyond 1e21 String() switches to exponent notation; BigInt keeps
            // every digit (values this large cannot appear in real xlsx cells,
            // but the guard keeps the promise absolute).
            return Math.abs(value) < 1e21 ? String(value) : BigInt(value).toString();
        }
        return String(value);
    }
    return String(value);
}

// ---------------------------------------------------------------------------
// Row classification
// ---------------------------------------------------------------------------

const NUMERIC_TEXT = /^[+-]?\d+(?:[.,]\d+)?$/;
const SERIAL_ONLY = /^\d{1,6}[.)]?$/;

/** Numeric-looking text (not a label). */
export function isNumericText(text) {
    return NUMERIC_TEXT.test(String(text ?? '').trim());
}

/** A cell that looks like a label: non-empty and not a number. */
export function isLabelCell(text) {
    const trimmed = String(text ?? '').trim();
    return trimmed !== '' && !NUMERIC_TEXT.test(trimmed) && /\p{L}/u.test(trimmed);
}

/** Header detection (spec §5.4): first row with ≥ 3 label-like cells. */
export function looksLikeHeaderRow(cells) {
    return cells.filter(isLabelCell).length >= 3;
}

/** A row whose only non-empty cell is a serial number is dropped. */
export function isSerialOnlyRow(cells) {
    const filled = cells.map((c) => String(c ?? '').trim()).filter(Boolean);
    return filled.length === 1 && SERIAL_ONLY.test(filled[0]);
}

/** Drop trailing empty cells; internal empties keep column alignment. */
export function trimTrailingEmpties(cells) {
    const out = cells.slice();
    while (out.length > 0 && String(out[out.length - 1] ?? '').trim() === '') out.pop();
    return out;
}

/**
 * Does a candidate row repeat the header (a common pattern in printed
 * exports)? Comparison is folded and positional, so alignment is kept even
 * when either side has internal empty cells. Columns the header only filled
 * through a merged range (`mergeFilled`) may be empty in the repeat, because
 * a repeated header does not repeat the merge itself.
 */
function matchesHeader(cells, headerCells, mergeFilled) {
    const width = Math.max(cells.length, headerCells.length);
    for (let i = 0; i < width; i += 1) {
        const rowCell = String(cells[i] ?? '').trim();
        const headCell = String(headerCells[i] ?? '').trim();
        if (rowCell === '') {
            if (headCell === '' || mergeFilled.has(i)) continue;
            return false;
        }
        if (foldForMatch(rowCell) !== foldForMatch(headCell)) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Grid → source
// ---------------------------------------------------------------------------

/**
 * Build a rows source from a grid of cells.
 *
 * @param {{
 *   grid: string[][],                 // one array of cell texts per row
 *   rowNumbers: number[],             // the file's own row number per grid row
 *   name: string,                     // source name for the preview
 *   kind: 'sheet'|'docx',             // what the file was
 *   merges?: {s:{r:number,c:number}, e:{r:number,c:number}}[],
 *                                     // merged ranges (0-based grid coords)
 *   maxRows?: number,                 // remaining job row budget
 *   meta?: object,
 * }} input
 * @returns {{ source: object, warnings: object[] }}
 */
export function buildTableSource({
    grid,
    rowNumbers,
    name,
    kind,
    merges = [],
    maxRows = Infinity,
    meta = {},
}) {
    const warnings = [];
    const stats = {
        headerRow: null,
        titleRows: 0,
        dataRows: 0,
        repeatedHeaders: 0,
        emptyRows: 0,
        serialRows: 0,
        capped: false,
    };

    // Header: the first row with ≥ 3 label-like cells (spec §5.4).
    let headerIndex = grid.findIndex((cells) => looksLikeHeaderRow(cells));
    if (headerIndex === -1) {
        warnings.push({ code: 'NO_HEADER', params: {} });
        headerIndex = -1;
    }
    stats.headerRow = headerIndex >= 0 ? rowNumbers[headerIndex] : null;
    stats.titleRows = headerIndex > 0 ? headerIndex : 0;

    let header = null;
    const mergeFilled = new Set();
    if (headerIndex >= 0) {
        // Merged cells: propagate the top-left value across the merged range
        // for the header row only (spec §5.4). Data rows keep the value in the
        // first cell only, which is exactly what the grid already holds.
        const headerCells = grid[headerIndex].slice();
        for (const merge of merges) {
            if (merge.s.r !== headerIndex) continue;
            const value = String(headerCells[merge.s.c] ?? '');
            for (let c = merge.s.c + 1; c <= merge.e.c; c += 1) {
                headerCells[c] = value;
                mergeFilled.add(c);
            }
        }
        const cells = trimTrailingEmpties(headerCells);
        header = { id: `R${rowNumbers[headerIndex]}`, cells, text: cells.join(' | ') };
    }

    const lines = [];
    const start = headerIndex >= 0 ? headerIndex + 1 : 0;

    for (let i = start; i < grid.length; i += 1) {
        const cells = grid[i].map((c) => String(c ?? '').trim());
        if (cells.every((c) => c === '')) {
            stats.emptyRows += 1;
            continue;
        }
        if (isSerialOnlyRow(cells)) {
            stats.serialRows += 1;
            continue;
        }
        if (header && matchesHeader(cells, header.cells, mergeFilled)) {
            // Header rows repeated mid-sheet (common in printed exports).
            stats.repeatedHeaders += 1;
            continue;
        }
        if (lines.length >= maxRows) {
            stats.capped = true;
            break;
        }
        const kept = trimTrailingEmpties(cells);
        lines.push({ id: `R${rowNumbers[i]}`, cells: kept, text: kept.join(' | ') });
    }

    if (stats.capped) {
        warnings.push({ code: 'ROW_BUDGET', params: { limit: maxRows } });
    }
    stats.dataRows = lines.length;

    return {
        source: { kind, name, layout: 'rows', header, lines, meta, warnings, stats },
        warnings,
    };
}

/** Highest column count of a rows source (for the column checkboxes). */
export function columnCount(source) {
    let width = source.header ? source.header.cells.length : 0;
    for (const line of source.lines) width = Math.max(width, line.cells.length);
    return width;
}

/**
 * Apply the preview's column selection (spec §5.3): unchecking a column
 * removes it from what will be sent. `selected` is a boolean per column index
 * (missing entries default to true) — cells of deselected columns are dropped
 * and the row is re-composed.
 */
export function applyColumnSelection(source, selected) {
    if (source.layout !== 'rows') return source;
    const keep = (cells) => trimTrailingEmpties(cells.filter((cell, i) => selected[i] !== false));
    const header = source.header
        ? { id: source.header.id, cells: keep(source.header.cells), text: '' }
        : null;
    if (header) header.text = header.cells.join(' | ');
    const lines = source.lines.map((line) => {
        const cells = keep(line.cells);
        return { id: line.id, cells, text: cells.join(' | ') };
    });
    return { ...source, header, lines };
}
