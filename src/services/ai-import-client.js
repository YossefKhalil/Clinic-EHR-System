// Client bridge between the Bulk Import page and the ai-import Edge Function.
//
// The OpenRouter key never lives in the browser: the Edge Function reads it
// from its environment (OPENROUTER_API_KEY secret), so this side only needs
// to (1) extract contents from whatever the staff attaches and (2) post them.

import * as XLSX from 'xlsx';

const FILE_LIMIT_BYTES = 8 * 1024 * 1024; // 8 MiB per attachment
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const SHEET_TYPES = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/vnd.ms-excel', // xls
    'text/csv',
];
const TEXT_TYPES = ['text/plain', 'text/markdown', 'application/json'];

export function isSupportedFile(file) {
    if (IMAGE_TYPES.includes(file.type)) return { ok: true, kind: 'image' };
    if (SHEET_TYPES.includes(file.type) || /\.(xlsx|xls|csv)$/i.test(file.name)) return { ok: true, kind: 'sheet' };
    if (TEXT_TYPES.includes(file.type) || /\.(txt|md|json)$/i.test(file.name)) return { ok: true, kind: 'text' };
    return { ok: false };
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the file'));
        reader.readAsDataURL(file);
    });
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the file'));
        reader.readAsText(file);
    });
}

// Spreadsheet → the exact rows the model should see, as pipe-separated
// records, one line each, with a header line. Compact and unambiguous for the
// model; also compact for the token budget.
function sheetToText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const workbook = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
                const lines = [];
                workbook.SheetNames.forEach((sheetName) => {
                    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, blankrows: false });
                    if (!rows.length) return;
                    lines.push(`# Sheet: ${sheetName}`);
                    rows.forEach((row) => lines.push(row.map((cell) => (cell ?? '')).join(' | ')));
                });
                resolve(lines.join('\n').slice(0, 60000));
            } catch (error) {
                reject(new Error('Could not read the spreadsheet'));
            }
        };
        reader.onerror = () => reject(new Error('Could not read the file'));
        reader.readAsArrayBuffer(file);
    });
}

export async function fileToContents(file) {
    if (file.size > FILE_LIMIT_BYTES) {
        throw new Error(`"${file.name}" is larger than 8 MB.`);
    }
    const { ok, kind } = isSupportedFile(file);
    if (!ok) {
        throw new Error(`"${file.name}" is not a supported type (images, xlsx/xls/csv, txt/md/json).`);
    }

    if (kind === 'image') {
        const dataUrl = await readFileAsDataUrl(file);
        return { kind, name: file.name, image_url: { url: dataUrl } };
    }
    if (kind === 'sheet') {
        const text = await sheetToText(file);
        return { kind, name: file.name, text: `Attached spreadsheet "${file.name}":\n\n${text}` };
    }
    const text = await readFileAsText(file);
    return { kind, name: file.name, text: `Attached text file "${file.name}":\n\n${text.slice(0, 60000)}` };
}

export async function generatePatientYaml({ contents, defaults = [] }) {
    const fnUrl = import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/ai-import';
    const token = (await import('./supabase.js')).supabase()
        ? (await (await import('./supabase.js')).supabase().auth.getSession()).data.session?.access_token
        : null;

    let res;
    try {
        res = await fetch(fnUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ contents, defaults }),
        });
    } catch (e) {
        console.error('ai-import request failed:', e);
        throw new Error('Could not reach the AI service. Check your connection and try again.');
    }

    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        if (res.status === 401) msg = 'Your session was rejected. Please sign in again.';
        if (res.status === 403) msg = 'Only administrators can import patients with AI.';
        throw new Error(msg);
    }

    const data = await res.json();
    if (!data.yaml) throw new Error('The AI returned nothing usable.');
    return data.yaml;
}
