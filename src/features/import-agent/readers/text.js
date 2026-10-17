// Text-like readers (spec §5.4): csv / tsv / txt / md / pasted text.
//
// Encoding (spec §5.4 "CSV specifics"): BOM first, strict UTF-8 second,
// Windows-1256 as the fallback for older Arabic exports — and the encoding
// used is always reported. Delimited files get their delimiter sniffed among
// `,` `;` tab; everything else is read as typed text.
//
// Delimited text is parsed here (not through SheetJS) so every record keeps
// its real starting line number, which is what ids and the source panel use.

import { LIMITS } from '@import-core/limits.js';
import { buildTableSource } from './table.js';

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** BOM, strict UTF-8, then Windows-1256 (spec §5.4). */
export function decodeBytes(bytes) {
    if (bytes.length >= 3 && UTF8_BOM.every((b, i) => bytes[i] === b)) {
        return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    }
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { text: text.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
    } catch {
        // Not valid UTF-8 — the common legacy Arabic case (spec §5.4, §15).
        const text = new TextDecoder('windows-1256').decode(bytes);
        return { text: text.replace(/^\uFEFF/, ''), encoding: 'windows-1256', fallback: true };
    }
}

/**
 * Parse delimited text with quoted fields and quoted newlines. Returns the
 * grid plus, for every record, the line number it starts on (1-based), so a
 * record that spans lines is still findable by staff.
 */
export function parseDelimited(text, delimiter) {
    const rows = [];
    const rowNumbers = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let line = 1;
    let recordStart = 1;
    let started = false;

    const pushField = () => {
        row.push(field);
        field = '';
    };
    const pushRow = () => {
        pushField();
        rows.push(row);
        rowNumbers.push(recordStart);
        row = [];
        started = false;
    };

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                if (ch === '\n') line += 1;
                field += ch;
            }
            continue;
        }
        if (!started) {
            recordStart = line;
            started = true;
        }
        if (ch === '"' && field === '') {
            inQuotes = true;
        } else if (ch === delimiter) {
            pushField();
        } else if (ch === '\n') {
            pushRow();
            line += 1;
        } else if (ch === '\r') {
            // \r\n counts as one line break; a lone \r is a break too.
            if (text[i + 1] === '\n') {
                pushRow();
                line += 1;
                i += 1;
            } else {
                pushRow();
                line += 1;
            }
        } else {
            field += ch;
        }
    }
    if (started || field !== '' || row.length > 0) pushRow();

    return { rows, rowNumbers };
}

/**
 * Sniff the delimiter among `,` `;` and tab (spec §5.4). A candidate is valid
 * when the rows agree on a column count ≥ 2; the candidate with the most
 * columns wins (then the most consistent one).
 */
export function sniffDelimiter(text) {
    let best = null;
    for (const delimiter of [',', ';', '\t']) {
        const { rows } = parseDelimited(text, delimiter);
        const counts = new Map();
        let records = 0;
        for (const row of rows) {
            if (row.every((cell) => cell.trim() === '')) continue;
            records += 1;
            counts.set(row.length, (counts.get(row.length) || 0) + 1);
        }
        if (records < 2) continue;
        let modal = 0;
        let modalCount = 0;
        for (const [columns, count] of counts) {
            if (count > modalCount || (count === modalCount && columns > modal)) {
                modal = columns;
                modalCount = count;
            }
        }
        if (modal < 2) continue;
        const consistency = modalCount / records;
        if (consistency < 0.8) continue;
        if (!best || modal > best.columns || (modal === best.columns && consistency > best.consistency)) {
            best = { delimiter, columns: modal, consistency };
        }
    }
    return best ? best.delimiter : null;
}

/** Split text into typed-text lines with stable `L###` ids. */
export function textToLines(text) {
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
    const raw = normalized.split('\n');
    // A trailing newline is an artifact of the split, not an empty last line.
    if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    return raw.map((line, i) => ({ id: `L${String(i + 1).padStart(3, '0')}`, text: line }));
}

/** Source object for typed text (also used for pasted text and `.txt`/`.md`). */
export function readTypedText(text, { name, kind = 'text', meta = {} } = {}) {
    const lines = textToLines(text);
    return {
        kind,
        name,
        layout: 'text',
        header: null,
        lines,
        meta,
        warnings: [],
        stats: { lines: lines.length },
    };
}

/** Read a `.csv`/`.tsv` file. Falls back to prose when no delimiter fits. */
export function readDelimitedFile(bytes, { name, limits = LIMITS, maxRows = limits.MAX_ROWS } = {}) {
    const { text, encoding, fallback } = decodeBytes(bytes);
    const warnings = [];
    if (fallback) warnings.push({ code: 'CSV_ENCODING', params: { encoding } });

    const delimiter = sniffDelimiter(text);
    if (!delimiter) {
        const source = readTypedText(text, {
            name,
            kind: 'text',
            meta: { file: name, encoding },
        });
        source.warnings.push({ code: 'CSV_AS_TEXT', params: {} });
        return { sources: [source], warnings };
    }

    const { rows, rowNumbers } = parseDelimited(text, delimiter);
    const { source } = buildTableSource({
        grid: rows,
        rowNumbers,
        name,
        kind: 'sheet',
        maxRows,
        meta: { file: name, encoding, delimiter },
    });
    return { sources: [source], warnings };
}

/** Read a plain text file (`.txt`, `.md`, unknown text-like bytes). */
export function readTextFile(bytes, { name, limits = LIMITS } = {}) {
    const { text, encoding, fallback } = decodeBytes(bytes);
    const warnings = [];
    if (fallback) warnings.push({ code: 'CSV_ENCODING', params: { encoding } });
    const source = readTypedText(text, { name, kind: 'text', meta: { file: name, encoding } });
    return { sources: [source], warnings };
}
