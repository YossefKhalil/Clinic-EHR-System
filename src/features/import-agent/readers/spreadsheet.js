// Spreadsheet reader (spec §5.4): xlsx / xlsm / xls via SheetJS, lazy-loaded
// (§14.5) so the library only reaches the browser when such a file is added.
//
// Every visible sheet becomes one source (spec §6.1: `Source S1 (file:
// patients_oct.xlsx, sheet "Cairo")`), so line ids stay unique per sheet and
// the row numbers reference the real workbook rows.

import { LIMITS } from '@import-core/limits.js';
import { readerReject } from './reader-error.js';
import { buildTableSource, cellToText } from './table.js';

let xlsxPromise = null;

/** Lazy-load SheetJS. */
function loadXlsx() {
    xlsxPromise ||= import('xlsx');
    return xlsxPromise;
}

function isPasswordError(error) {
    return /password|encrypt/i.test(String(error?.message || error || ''));
}

/**
 * Read a workbook into one source per sheet.
 *
 * @param {Uint8Array} bytes
 * @param {{
 *   name: string,
 *   limits?: typeof LIMITS,
 *   maxRows?: number,                      // remaining job row budget
 *   includeHiddenSheets?: string[],        // hidden sheets the user opted in
 * }} options
 * @returns {Promise<{ sources: object[], warnings: object[] }>}
 */
export async function readWorkbook(bytes, {
    name,
    limits = LIMITS,
    maxRows = limits.MAX_ROWS,
    includeHiddenSheets = [],
} = {}) {
    const XLSX = await loadXlsx();

    let workbook;
    try {
        workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
    } catch (error) {
        if (isPasswordError(error)) throw readerReject('SPREADSHEET_ENCRYPTED', { name });
        throw readerReject('SPREADSHEET_UNREADABLE', { name });
    }

    const warnings = [];
    const sources = [];
    const hiddenSkipped = [];
    let remaining = maxRows;
    let unreadSheets = 0;

    const sheetNames = workbook.SheetNames || [];
    for (let index = 0; index < sheetNames.length; index += 1) {
        const sheetName = sheetNames[index];
        const hidden = (workbook.Workbook?.Sheets?.[index]?.Hidden ?? 0) !== 0;
        if (hidden && !includeHiddenSheets.includes(sheetName)) {
            hiddenSkipped.push(sheetName);
            continue;
        }
        if (remaining <= 0) {
            unreadSheets += 1;
            continue;
        }

        const sheet = workbook.Sheets[sheetName];
        if (!sheet || !sheet['!ref']) continue; // empty sheet — nothing to send

        const range = XLSX.utils.decode_range(sheet['!ref']);
        const grid = [];
        const rowNumbers = [];
        for (let r = range.s.r; r <= range.e.r; r += 1) {
            const row = [];
            for (let c = range.s.c; c <= range.e.c; c += 1) {
                const cell = sheet[XLSX.utils.encode_cell({ r, c })];
                row.push(cellToText(cell?.v));
            }
            grid.push(row);
            rowNumbers.push(r + 1); // real workbook row (1-based, spec §5.4)
        }

        const merges = (sheet['!merges'] || []).map((m) => ({
            s: { r: m.s.r, c: m.s.c },
            e: { r: m.e.r, c: m.e.c },
        }));

        const { source } = buildTableSource({
            grid,
            rowNumbers,
            name: `${name} › ${sheetName}`,
            kind: 'sheet',
            merges,
            maxRows: remaining,
            meta: { file: name, sheet: sheetName, hidden },
        });
        sources.push(source);
        remaining -= source.stats.dataRows;
    }

    if (hiddenSkipped.length > 0) {
        warnings.push({ code: 'HIDDEN_SHEETS_SKIPPED', params: { sheets: hiddenSkipped.join(', ') } });
    }
    if (unreadSheets > 0) {
        warnings.push({ code: 'SHEETS_NOT_READ', params: { limit: maxRows, count: unreadSheets } });
    }

    return { sources, warnings };
}
