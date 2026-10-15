// Shared client logic for the AI-powered bulk import.
//
// Flow: staff writes instructions (and attaches images/CSV/spreadsheet text)
// → the ai-import Edge Function calls OpenRouter and returns a strict YAML
// document → this module parses the YAML into patient rows, normalizes them
// against the patients table schema, lets the user review and edit them, then
// creates each patient through the normal createPatient() path so RLS and
// constraints stay authoritative.

import { createPatient } from './patients.js';

// The exact columns the YAML contract defines. Reordered to the same order as
// the review grid for readability.
export const AI_PATIENT_FIELDS = [
    'name', 'national_id', 'mobile', 'date_of_birth', 'age', 'marital_status',
    'children_count', 'governorate', 'address', 'problem', 'solution',
    'price', 'visit_date', 'source_of_money', 'is_completed', 'notes',
];

const GOVERNORATES = new Set([
    'Cairo', 'Giza', 'Alexandria', 'Dakahlia', 'Red Sea', 'Beheira', 'Faiyum',
    'Gharbia', 'Ismailia', 'Monufia', 'Minya', 'Qalyubia', 'New Valley', 'Suez',
    'Aswan', 'Asyut', 'Beni Suef', 'Port Said', 'Damietta', 'South Sinai',
    'North Sinai', 'Sharqia', 'Kafr El Sheikh', 'Qena', 'Luxor', 'Sohag', 'Matrouh',
]);

const MARITAL = new Set(['single', 'married', 'divorced', 'widowed']);
const MONEY = new Set(['charity', 'country']);

// Sources of money are an editable list (issue #1). main.js pushes the
// active keys in after loading app_options so the review grid validates
// against the admin's current list instead of the seed values.
export function setSourceOptions(keys) {
    if (!Array.isArray(keys) || !keys.length) return;
    MONEY.clear();
    keys.forEach((key) => MONEY.add(key));
}

// --- parsing ---------------------------------------------------------------

function cleanScalar(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text || /^(null|~|-{0,2}-)$/i.test(text)) return null;
    if (/^["'](.*)["']$/.test(text)) return text.slice(1, -1).replace(/\\"/g, '"');
    return text;
}

/**
 * Parse the YAML the model returns into a flat { field: scalar } list.
 *
 * Deliberately tolerant: the model sometimes wraps the document in ```yaml
 * fences, adds leading commentary, uses a top-level list without the
 * `patients:` key, or nests rows a level deep. Every accepted shape must
 * still be a mapping whose keys (once trimmed) are recognized field names.
 */
export function parsePatientYaml(text) {
    if (!text || typeof text !== 'string') return { rows: [], errors: ['Empty AI response.'] };

    const lines = String(text)
        .replace(/^```(?:ya?ml)?\s*$/gim, '')
        .replace(/\r/g, '')
        .split('\n');

    // Find the block that looks like patient rows: either a top-level
    // "patients:" key or a list of "- name:" items.
    let startIndex = lines.findIndex((line) => /^\s*patients\s*:/.test(line));
    if (startIndex === -1) {
        startIndex = lines.findIndex((line) => /^\s*-\s*name\s*:/.test(line));
        if (startIndex !== -1) startIndex -= 0; // list starts at this line
    }
    if (startIndex === -1) return { rows: [], errors: ['The AI response contained no patient entries.'] };

    const rows = [];
    const errors = [];
    let current = null;
    for (let i = startIndex; i < lines.length; i += 1) {
        const line = lines[i];
        const recordMatch = line.match(/^\s*-\s*(.*)$/);
        if (recordMatch && current) {
            // New entry begins; flush the previous one.
            rows.push(current);
            current = null;
        }
        if (recordMatch) current = {};

        if (!current) {
            // Header lines ("patients:") and stray commentary are skipped.
            continue;
        }
        const content = (recordMatch ? recordMatch[1] : line).trim();
        const kv = content.match(/^(\w+)\s*:\s*(.*)$/);
        if (!kv) continue;
        const field = kv[1].trim();
        if (!AI_PATIENT_FIELDS.includes(field)) continue;
        current[field] = cleanScalar(kv[2]);
    }
    if (current) rows.push(current);

    if (!rows.length) errors.push('The AI response listed no patient rows.');
    return { rows, errors };
}

// --- normalization ---------------------------------------------------------

const KNOWN_FIELDS = new Set([
    ...AI_PATIENT_FIELDS, 'follower', 'section', 'governorate', 'notes',
]);

export function validateRow(row, index = 0) {
    const errors = [];
    if (!row.name || !String(row.name).trim()) errors.push('name is required');
    const nid = String(row.national_id ?? '').trim();
    if (!nid) errors.push('national_id is required');
    else if (!/^\d{14}$/.test(nid)) errors.push('national_id must be 14 digits');

    if (row.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(row.date_of_birth)) errors.push('date_of_birth must be YYYY-MM-DD');
    if (row.visit_date && !/^\d{4}-\d{2}-\d{2}$/.test(row.visit_date)) errors.push('visit_date must be YYYY-MM-DD');
    if (row.marital_status && !MARITAL.has(row.marital_status)) errors.push(`marital_status must be one of ${[...MARITAL].join('/')}`);
    if (row.source_of_money && !MONEY.has(row.source_of_money)) errors.push(`source_of_money must be one of: ${[...MONEY].join(', ')}`);
    if (row.governorate && !GOVERNORATES.has(row.governorate)) errors.push(`governorate "${row.governorate}" is not in the list`);
    // Optional: only reject a value when one was actually provided. The model
    // omits fields entirely (undefined) as well as sending null, so both count
    // as "not provided" — and both become correct SQL NULLs at insert time.
    if (row.age !== null && row.age !== undefined && row.age !== '' && !Number.isFinite(Number(row.age))) errors.push('age must be a number');
    if (row.price !== null && row.price !== undefined && row.price !== '' && !Number.isFinite(Number(row.price))) errors.push('price must be a number');

    const id = `row-${index}`;
    return { id, errors, tabindex: index };
}

/**
 * Turn a model row into a shape the review grid + createPatient() both accept.
 * Unknown fields are kept aside but not silently dropped from the report.
 */
export function normalizeRow(rawRow) {
    const row = {};
    const unknown = [];

    Object.entries(rawRow ?? {}).forEach(([field, value]) => {
        if (!KNOWN_FIELDS.has(field)) { unknown.push(field); return; }
        row[field] = value;
    });

    return { row, unknown };
}

export function sanitizeForInsert(row) {
    const numOrNull = (v) => (v === '' || v === null || v === undefined) ? null : Number(v);
    return {
        name: row.name?.trim() ?? '',
        national_id: row.national_id?.trim() ?? '',
        mobile: row.mobile?.trim() || null,
        date_of_birth: row.date_of_birth?.trim() || null,
        age: numOrNull(row.age),
        marital_status: row.marital_status?.trim() || null,
        children_count: numOrNull(row.children_count) ?? 0,
        governorate: row.governorate?.trim() || null,
        address: row.address?.trim() || null,
        problem: row.problem?.trim() || null,
        solution: row.solution?.trim() || null,
        price: numOrNull(row.price),
        visit_date: row.visit_date?.trim() || null,
        source_of_money: row.source_of_money?.trim() || null,
        is_completed: row.is_completed === true || row.is_completed === 'true',
        notes: row.notes?.trim() ? row.notes.trim().split(/\s*;\s*/).filter(Boolean) : [],
    };
}

/**
 * Run one YAML batch through validation, create each accepted row, and report
 * per-row outcome; row-level errors never abort the batch.
 */
export async function importValidatedRows(rows, ctx) {
    const accepted = [];
    const failed = [];

    for (let i = 0; i < rows.length; i += 1) {
        const { row, unknown } = normalizeRow(rows[i]);
        const { errors } = validateRow(row, i);
        if (errors.length) {
            failed.push({ index: i, name: row?.name ?? `row ${i + 1}`, reasons: errors, unknown });
            continue;
        }
        try {
            const created = await createPatient({ ...sanitizeForInsert(row), section: ctx?.section || null, user_id: ctx?.userId });
            accepted.push(created);
        } catch (e) {
            failed.push({ index: i, name: row?.name ?? `row ${i + 1}`, reasons: [e.message ?? 'insert failed'] });
        }
    }

    return { accepted, failed };
}
