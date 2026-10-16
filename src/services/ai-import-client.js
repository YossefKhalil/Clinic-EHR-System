// Client bridge between the 3-step Import page and the ai-import Edge
// Function (issue #9 Phase 2).
//
// The OpenRouter key never lives in the browser. This side (1) preprocesses
// whatever the staff attached into small request chunks — spreadsheets get
// 15 data rows per request with a repeated header, images are downscaled and
// compressed, PDFs travel as file content parts, DOCX is read in the browser
// — and (2) runs the requests (up to 3 in parallel) with progress and cancel.

import * as XLSX from 'xlsx';
import yaml from 'js-yaml';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/heic', 'image/heif'];
const SHEET_TYPES = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/vnd.ms-excel', // xls
    'text/csv',
];
const DOC_TYPES = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];
const PDF_TYPES = ['application/pdf'];
const TEXT_TYPES = ['text/plain', 'text/markdown', 'application/json'];

export const PARALLEL_REQUESTS = 3;
const TEXT_CHUNK_CHARS = 4000;      // TXT/MD/paste chunk size
const SHEET_ROWS_PER_CHUNK = 15;    // data rows per extraction request
const IMAGE_MAX_EDGE = 1600;        // px, long side
const IMAGE_JPEG_QUALITY = 0.85;

export function isSupportedFile(file) {
    if (IMAGE_TYPES.includes(file.type) || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(file.name)) return { ok: true, kind: 'image' };
    if (PDF_TYPES.includes(file.type) || /\.pdf$/i.test(file.name)) return { ok: true, kind: 'pdf' };
    if (SHEET_TYPES.includes(file.type) || /\.(xlsx|xls|csv)$/i.test(file.name)) return { ok: true, kind: 'sheet' };
    if (DOC_TYPES.includes(file.type) || /\.(docx|doc)$/i.test(file.name)) return { ok: true, kind: 'doc' };
    if (TEXT_TYPES.includes(file.type) || /\.(txt|md|json)$/i.test(file.name)) return { ok: true, kind: 'text' };
    return { ok: false };
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the file'));
        reader.readAsArrayBuffer(file);
    });
}

// --- preprocessing -----------------------------------------------------------

/**
 * Downscale an image blob to at most IMAGE_MAX_EDGE on the long side and
 * re-encode as JPEG q0.85 so model calls stay small. GIFs are sent as-is
 * (canvas would flatten animation, which is fine for a document scan anyway).
 */
async function imageToDataUrl(file) {
    if (/gif$/i.test(file.name) || file.type === 'image/gif') {
        return readerDataUrl(file);
    }
    const rawUrl = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('Could not read the image'));
            el.src = rawUrl;
        });
        const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
    } finally {
        URL.revokeObjectURL(rawUrl);
    }
}

function readerDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the file'));
        reader.readAsDataURL(file);
    });
}

/** Excel serial dates → ISO strings; cellDates:true gives real Date objects. */
function excelCell(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, '0');
        const d = String(value.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

/** Spread sheet → { header, rows } with every cell as plain display text. */
function sheetToRows(file) {
    return readFileAsArrayBuffer(file).then((buffer) => {
        const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
        const rows = [];
        let header = null;
        workbook.SheetNames.forEach((sheetName) => {
            const records = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
                header: 1,
                blankrows: false,
                defval: '',
                raw: false,
            });
            records.forEach((record, index) => {
                const cells = record.map(excelCell);
                const first = workbook.SheetNames.length > 1 && index === 0 ? `# Sheet: ${sheetName}` : null;
                if (first) rows.push([first]);
                if (!header && cells.some((c) => c !== '')) {
                    header = cells;
                    rows.push(cells);
                } else if (cells.some((c) => c !== '')) {
                    rows.push(cells);
                }
            });
        });
        return { header, rows };
    });
}

/** DOCX → flat lines: table rows become pipe-separated fields, paragraphs one line each. */
async function docxToLines(file) {
    const mod = await import('mammoth');
    const mammoth = mod.default ?? mod;
    let docEl;
    try {
        const result = await mammoth.convertToHtml({ arrayBuffer: await readFileAsArrayBuffer(file) });
        docEl = result.value;
    } catch {
        throw new Error('Could not read the Word document');
    }
    const dom = new DOMParser().parseFromString(docEl, 'text/html');
    const lines = [];
    dom.body.querySelectorAll('table').forEach((table) => {
        table.querySelectorAll('tr').forEach((tr) => {
            const cells = [...tr.querySelectorAll('th,td')].map((td) => td.textContent.trim());
            if (cells.some((c) => c !== '')) lines.push(cells.join(' | '));
        });
        table.remove(); // don't double-count the paragraphs inside
    });
    dom.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,div,pre,blockquote').forEach((el) => {
        const text = el.textContent.trim();
        if (text) lines.push(text);
    });
    if (!lines.length && dom.body.textContent.trim()) lines.push(dom.body.textContent.trim());
    return lines;
}

function chunkText(text, size = TEXT_CHUNK_CHARS) {
    const chunks = [];
    let current = [];
    let length = 0;
    String(text ?? '').split('\n').forEach((line) => {
        if (length + line.length + 1 > size && current.length) {
            chunks.push(current.join('\n'));
            current = [];
            length = 0;
        }
        current.push(line);
        length += line.length + 1;
    });
    if (current.length) chunks.push(current.join('\n'));
    return chunks;
}

function pipeRow(cells) { return cells.join(' | '); }

/**
 * Turn a list of files (+ optional pasted text) into a list of extraction
 * requests. Each request = { label, contents: [...contentParts...] } ready
 * for the edge function. One content part shape throughout:
 *   { type: 'text', text } | { type: 'image_url', image_url: { url } }
 *   | { type: 'file', file: { filename, file_data } }   (PDF)
 */
export async function buildExtractionRequests(files, pastedText, { onNote = () => {} } = {}) {
    // 500-row budget across the whole run.
    let rowsBudget = 500;
    const requests = [];

    for (const file of files) {
        const { kind } = isSupportedFile(file);
        let lineLabel = file.name;

        if (kind === 'image') {
            const url = await imageToDataUrl(file);
            requests.push({
                label: lineLabel,
                contents: [
                    { type: 'text', text: `Extract every patient recorded in this photo/document image ("${file.name}"). Transcribe exactly what is visible.` },
                    { type: 'image_url', image_url: { url } },
                ],
            });
            continue;
        }

        if (kind === 'pdf') {
            // Base64 inflates ~4/3; keep the encoded size inside the 8 MiB
            // edge-function body cap with headroom.
            const base64Length = Math.ceil(file.size * 4 / 3);
            if (base64Length > 8 * 1024 * 1024) {
                throw new Error(`"${file.name}" is too large as a PDF (${Math.ceil(file.size / 1024)} KB raw → ${(base64Length / 1024 / 1024).toFixed(1)} MB base64). Scan or export it in parts under 8 MB.`);
            }
            const dataUrl = await readerDataUrl(file);
            requests.push({
                label: lineLabel,
                contents: [
                    { type: 'text', text: `Extract every patient recorded in this PDF ("${file.name}").` },
                    { type: 'file', file: { filename: file.name, file_data: dataUrl } },
                ],
            });
            continue;
        }

        if (kind === 'sheet') {
            const { header, rows } = await sheetToRows(file);
            if (!rows.length) continue;
            if (rows.length > rowsBudget) {
                onNote(`Only the first ${rowsBudget} rows of "${file.name}" are used — the run limit is 500 rows.`);
                rows.length = Math.max(rowsBudget, 1);
            }
            rowsBudget -= Math.min(rows.length, rowsBudget);
            const display = rows.map(pipeRow);
            const headerLine = header ? pipeRow(header) : '';
            for (let i = 1; i < display.length; i += SHEET_ROWS_PER_CHUNK) {
                const slice = display.slice(i, i + SHEET_ROWS_PER_CHUNK);
                const text = [
                    headerLine ? `Header: ${headerLine}` : '',
                    ...slice,
                ].filter(Boolean).join('\n');
                const part = Math.floor(i / SHEET_ROWS_PER_CHUNK) + 1;
                const parts = Math.ceil((display.length - 1) / SHEET_ROWS_PER_CHUNK);
                requests.push({
                    label: `${file.name} · part ${part}/${parts}`,
                    contents: [{ type: 'text', text: `Spreadsheet "${file.name}" (pipe-separated, header repeated):\n\n${text}` }],
                });
            }
            continue;
        }

        if (kind === 'doc') {
            const lines = await docxToLines(file);
            const chunks = chunkText(lines.join('\n'), 8000).filter((chunk) => chunk.trim());
            chunks.forEach((chunk, index) => {
                requests.push({
                    label: `${file.name} · part ${index + 1}/${chunks.length}`,
                    contents: [{ type: 'text', text: `Word document "${file.name}" (table rows are pipe-separated):\n\n${chunk}` }],
                });
            });
            continue;
        }

        // txt / md / json
        const buffer = await readFileAsArrayBuffer(file);
        const text = new TextDecoder().decode(buffer);
        chunkText(text).forEach((chunk, index, all) => {
            requests.push({
                label: `${file.name} · part ${index + 1}/${all.length}`,
                contents: [{ type: 'text', text: `Text file "${file.name}":\n\n${chunk}` }],
            });
        });
    }

    const pasted = String(pastedText ?? '').trim();
    if (pasted) {
        chunkText(pasted).forEach((chunk, index, all) => {
            requests.push({
                label: all.length > 1 ? `Typed text · part ${index + 1}/${all.length}` : 'Typed text',
                contents: [{ type: 'text', text: `Typed / pasted patient details:\n\n${chunk}` }],
            });
        });
    }

    return requests;
}

/**
 * Run every extraction request, up to PARALLEL_REQUESTS at a time, reporting
 * progress ("Running part 2 of 7") and honoring an AbortController signal.
 * Returns [{ label, yaml, truncated, error }] in submission order.
 */
export async function runExtractionRequests(requests, { signal = null, onProgress = () => {} } = {}) {
    const results = new Array(requests.length).fill(null);
    let done = 0;

    async function worker(queue) {
        while (queue.length) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const index = queue.shift();
            try {
                results[index] = await extractChunk(requests[index].contents);
            } catch (error) {
                results[index] = { error: error?.name === 'AbortError' ? 'cancelled' : (error.message ?? 'Request failed') };
            }
            done += 1;
            const next = queue[0];
            onProgress({
                done,
                total: requests.length,
                label: next ? requests[next].label : null,
            });
        }
    }

    const queue = requests.map((_, i) => i);
    // Announce the first request immediately: without this the UI keeps
    // showing "Preparing files…" until the FIRST part finishes, which looks
    // frozen for minutes on slow providers.
    if (requests.length) onProgress({ done: 0, total: requests.length, label: requests[0].label });
    const workers = Array.from({ length: Math.min(PARALLEL_REQUESTS, requests.length) }, () => worker(queue));
    await Promise.all(workers);
    return results.map((result, i) => ({ label: requests[i].label, ...result }));
}

async function callAiImport(contents, extra = {}) {
    const fnUrl = import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/ai-import';
    const token = (await import('./supabase.js')).supabase()
        ? (await (await import('./supabase.js')).supabase().auth.getSession()).data.session?.access_token
        : null;

    let res;
    try {
        res = await fetch(fnUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ contents, ...extra }),
        });
    } catch (e) {
        console.error('ai-import request failed:', e);
        throw new Error('Could not reach the AI service. Check your connection and try again.');
    }

    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        if (res.status === 401) msg = 'Your session was rejected. Please sign in again.';
        if (res.status === 403) msg = 'Only staff with an assigned section or administrators can import with AI.';
        throw new Error(msg);
    }

    const data = await res.json();
    if (!data.yaml) throw new Error('The AI returned nothing usable.');
    return { yaml: data.yaml, truncated: !!data.truncated };
}

/**
 * One chunk, with the one-retry-on-parse-failure rule: if safe YAML parsing
 * fails, re-send the chunk with the parser's error attached so the model can
 * repair its own output. A second failure fails only this chunk.
 */
export async function extractChunk(contents) {
    let result = await callAiImport(contents);
    let parsed = parseModelYaml(result.yaml);
    if (!parsed.ok) {
        result = await callAiImport(contents, { parse_error: parsed.error, previous_output: result.yaml });
        parsed = parseModelYaml(result.yaml);
        if (!parsed.ok) throw new Error('Could not parse the AI response for this part: ' + parsed.error);
    }
    return { yaml: yaml.dump({ patients: parsed.rows }, { quotingType: '"' }), truncated: result.truncated };
}

/** Mirrors ai-import.js's parser: this module also owns the retry path. */
function parseModelYaml(text) {
    let cleaned = String(text ?? '').replace(/```[a-z]*\n?/gi, '');
    const at = cleaned.search(/^\s*patients\s*:/m);
    if (at > 0) cleaned = cleaned.slice(at);
    let doc;
    try {
        doc = yaml.load(cleaned);
    } catch (err) {
        return { ok: false, error: err?.message ?? 'YAML parse error' };
    }
    const rows = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.patients) ? doc.patients : null);
    if (!rows) return { ok: false, error: 'the response did not contain a patients: list' };
    return { ok: true, rows: rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)) };
}
