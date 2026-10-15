// Shared client engine for the AI-powered bulk import (issue #9 rebuild).
//
// Flow: the browser preprocesses attached files into small request chunks →
// each chunk goes to the ai-import Edge Function (the OpenRouter key stays
// server-side) → each response is parsed safely with js-yaml → every patient
// is normalized deterministically HERE (never by the model) → the user
// reviews/edits rows in the review table → Import persists them under one
// batch id. Nothing is written to the database before the Import button.
//
// Display text never lives in this module: flags/warnings/errors are emitted
// as { key, params } so src/main.js can run them through t() for either
// locale. RTL/LTR safe by construction.

import yaml from 'js-yaml';
import { FOLLOWERS_AR } from './patients.js';
import { supabase } from './supabase.js';

// Canonical field order for the extraction contract / review grid.
export const AI_PATIENT_FIELDS = [
    'name', 'national_id', 'mobile', 'date_of_birth', 'age', 'marital_status',
    'children_count', 'governorate', 'address', 'problem', 'solution',
    'price', 'visit_date', 'source_of_money', 'follower', 'notes', 'uncertain', 'source',
];

const GOVERNORATES = new Set([
    'Cairo', 'Giza', 'Alexandria', 'Dakahlia', 'Red Sea', 'Beheira', 'Faiyum',
    'Gharbia', 'Ismailia', 'Monufia', 'Minya', 'Qalyubia', 'New Valley', 'Suez',
    'Aswan', 'Asyut', 'Beni Suef', 'Port Said', 'Damietta', 'South Sinai',
    'North Sinai', 'Sharqia', 'Kafr El Sheikh', 'Qena', 'Luxor', 'Sohag', 'Matrouh',
]);

const MARITAL = new Set(['single', 'married', 'divorced', 'widowed']);
const MONEY = new Set(['charity', 'country']);
const FOLLOWER_KEYS = new Set(Object.values(FOLLOWERS_AR));

// Run limits from the issue (enforced in the browser preprocessing step).
export const RUN_LIMITS = {
    maxFileBytes: 8 * 1024 * 1024,  // 8 MB per file
    maxFiles: 10,
    maxRows: 500,
    maxPdfBytes: 6 * 1024 * 1024,   // PDFs inflate ~4/3 when base64-encoded;
                                    // stay inside the 8 MiB edge body cap.
};

// --- YAML parsing -----------------------------------------------------------

/** Strip markdown fences and drop any text before the `patients:` root. */
export function cleanYamlText(text) {
    let stripped = String(text ?? '').replace(/```[a-z]*\n?/gi, '').replace(/\r/g, '');
    const at = stripped.search(/^\s*patients\s*:/m);
    if (at > 0) stripped = stripped.slice(at);
    return stripped;
}

/**
 * Parse the model's YAML safely with js-yaml (never eval/regex). Accepts a
 * `patients:` root or — tolerantly — a bare top-level list. Tolerant in
 * SHAPE only: every value is re-normalized downstream, so a badly written
 * value shows up as a review-table warning, not silent garbage.
 */
export function parsePatientYaml(text) {
    if (!text || typeof text !== 'string') return { rows: [], errors: [{ key: 'Empty AI response.' }] };
    let doc;
    try {
        doc = yaml.load(cleanYamlText(text));
    } catch (err) {
        return { rows: [], errors: [{ key: 'Could not parse the AI response: :error', params: { error: String(err?.message ?? 'YAML parse error') } }] };
    }
    const rawRows = Array.isArray(doc)
        ? doc
        : (doc && typeof doc === 'object' && Array.isArray(doc.patients) ? doc.patients : null);
    if (!rawRows) {
        return { rows: [], errors: [{ key: 'The AI response did not contain a patients list.' }] };
    }
    // Only mapping rows count; the model sometimes echoes stray scalars.
    const rows = rawRows.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
    const errors = rows.length ? [] : [{ key: 'The AI response listed no patient rows.' }];
    return { rows, errors };
}

// --- deterministic post-processing ------------------------------------------

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/** Arabic-Indic → Western digits (ID/mobile/date/number fields only). */
export function toWesternDigits(value) {
    return String(value ?? '').replace(/[٠-٩]/g, (ch) => String(ARABIC_INDIC.indexOf(ch)));
}

function digitsOnly(value) {
    return toWesternDigits(value).replace(/\D+/g, '');
}

/** Egyptian national ID: digits only, exactly 14. */
export function normalizeNationalId(value) {
    return digitsOnly(value).slice(0, 14);
}

/**
 * Egyptian mobile normalization: strip separators/+, map +20/0020 → leading
 * 0, restore a dropped leading zero on a 10-digit number starting with 1.
 * An 11-digit number starting 01 is valid; anything else is flagged Check.
 */
export function normalizeMobile(value) {
    let text = toWesternDigits(String(value ?? '')).replace(/[\s\-()[\].]/g, '');
    const hadCountry = /^\+20/.test(text) || /^0020/.test(text);
    text = text.replace(/^\+/, '');
    if (/^0020/.test(text)) text = '0' + text.slice(4);
    else if (/^20\d/.test(text)) text = '0' + text.slice(2);
    else if (hadCountry && !text.startsWith('0')) text = '0' + text;
    if (/^1\d{9}$/.test(text)) text = '0' + text;
    return text;
}

/**
 * Derive date of birth from a valid Egyptian national ID (century digit 2 →
 * 19xx, 3 → 20xx; positions 2–7 hold YYMMDD). We deliberately do NOT infer
 * gender or governorate from the ID: the registry records residence
 * independently of where the ID was issued.
 */
export function dobFromNationalId(nationalId) {
    const nid = String(nationalId ?? '');
    if (!/^[23]\d{13}$/.test(nid)) return null;
    const year = (nid.startsWith('2') ? '19' : '20') + nid.slice(1, 3);
    const mm = nid.slice(3, 5);
    const dd = nid.slice(5, 7);
    const month = Number(mm), day = Number(dd);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(`${year}-${mm}-${dd}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== Number(year)) return null;
    return `${year}-${mm}-${dd}`;
}

/** Arabic script normalization for fuzzy label matching (followers etc). */
export function normalizeText(value) {
    return String(value ?? '')
        .replace(/[\u064B-\u0652\u0640]/g, '')
        .replace(/[إأآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Map an arbitrary follower label to an allowed key, or null. */
export function normalizeFollower(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (FOLLOWER_KEYS.has(raw)) return raw;
    if (FOLLOWERS_AR[raw]) return FOLLOWERS_AR[raw];
    const normalized = normalizeText(raw);
    for (const [arabic, key] of Object.entries(FOLLOWERS_AR)) {
        if (normalizeText(arabic) === normalized) return key;
    }
    return null;
}

function cleanString(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text === '' ? null : text;
}

function pickEnum(value, set) {
    const text = cleanString(value);
    return text && set.has(text) ? text : null;
}

function coerceNumber(field, value) {
    if (value === null || value === undefined || value === '') return { value: null };
    const text = String(toWesternDigits(value)).replace(/[^\d.\-]/g, '');
    if (text === '' || !Number.isFinite(Number(text))) {
        return { value: null, warning: { field, key: '":value" is not a plain number.', params: { value: String(value) } } };
    }
    return { value: Number(text) };
}

/**
 * Dates: accept ISO and the day-first shapes this clinic's paperwork uses
 * (dd/mm/yyyy). Anything the model should have converted but didn't becomes
 * a warning, never silent garbage.
 */
function normalizeDate(field, value) {
    let text = cleanString(value);
    if (!text) return { value: null };
    text = toWesternDigits(text).trim();

    const m = text.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/);
    if (m) {
        const [a, b, c] = [m[1], m[2], m[3]];
        if (a.length === 4) {
            text = `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
        } else if (Number(c) > 1900) {
            // dd/mm/yyyy (Egyptian norm) — but tolerate mm/dd/yyyy order as
            // long as one of them can only be a day.
            if (Number(a) <= 12 && Number(b) <= 12) {
                text = `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
            } else {
                text = `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
            }
        }
    } else if (/^[12]\d{7}$/.test(text)) {
        // bare digits like 19750204
        text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return { value: null, warning: { field, key: '":value" is not a recognized date.', params: { value: String(value) } } };
    }
    const date = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
        return { value: null, warning: { field, key: '":value" is not a recognized date.', params: { value: String(value) } } };
    }
    return { value: text };
}

/**
 * Turn one raw model row into a normalized review row.
 *
 * `defaults` come from the "Apply to every patient" card, applied ONLY to
 * fields the extraction left blank — never overwriting a real value.
 * `section` never comes from the model. `sourceLabel` feeds the info icon.
 */
export function postProcessPatient(raw, defaults = {}, sourceLabel = '') {
    const flags = []; // { field, when, key, params }
    const errors = [];
    const unknown = Object.keys(raw ?? {}).filter((k) => !AI_PATIENT_FIELDS.includes(k));

    const name = cleanString(raw?.name) ?? '';
    const address = cleanString(raw?.address);
    const problem = cleanString(raw?.problem);
    const solution = cleanString(raw?.solution);

    // --- national ID: digits only, 14 expected ---
    const national_id = normalizeNationalId(raw?.national_id);
    if (national_id && national_id.length !== 14) {
        flags.push({
            field: 'national_id', when: national_id,
            key: 'National ID has :count digits — needs exactly 14. Correct it before this row can be imported.',
            params: { count: national_id.length },
        });
        errors.push({ key: 'National ID must be 14 digits' });
    }

    // --- mobile ---
    const mobile = normalizeMobile(raw?.mobile);

    // --- numbers ---
    const age = coerceNumber('age', raw?.age);
    const price = coerceNumber('price', raw?.price);
    const children_count = coerceNumber('children_count', raw?.children_count);
    [age, price, children_count].forEach((result) => { if (result.warning) flags.push(result.warning); });

    // --- dates ---
    const date_of_birth = normalizeDate('date_of_birth', raw?.date_of_birth);
    const visit_date = normalizeDate('visit_date', raw?.visit_date);
    [date_of_birth, visit_date].forEach((result) => { if (result.warning) flags.push(result.warning); });

    // --- enums: invalid → null + Check, never Error ---
    const marital_status = pickEnum(raw?.marital_status, MARITAL);
    if (raw?.marital_status && !marital_status && String(raw.marital_status).trim()) {
        flags.push({
            field: 'marital_status', when: String(raw.marital_status ?? ''),
            key: '":value" is not a marital status — pick one of single/married/divorced/widowed.',
            params: { value: String(raw.marital_status ?? '') },
        });
    }

    let governorate = cleanString(raw?.governorate);
    if (governorate) {
        const match = [...GOVERNORATES].find((g) => g.toLowerCase() === governorate.toLowerCase());
        if (match) {
            governorate = match;
        } else {
            flags.push({
                field: 'governorate', when: '',
                key: '":value" is not one of the 27 governorates.',
                params: { value: governorate },
            });
            governorate = null;
        }
    } else {
        governorate = null;
    }

    const source_of_money = pickEnum(raw?.source_of_money, MONEY);
    if (raw?.source_of_money && !source_of_money && String(raw.source_of_money).trim()) {
        flags.push({
            field: 'source_of_money', when: '',
            key: '":value" is not a source of money (charity or country).',
            params: { value: String(raw.source_of_money ?? '') },
        });
    }

    // --- follower: Arabic → key, or null + Check ---
    const follower = normalizeFollower(raw?.follower);
    if (raw?.follower && !follower && String(raw.follower).trim()) {
        flags.push({
            field: 'follower', when: '',
            key: '":value" did not match a follower — pick one from the list.',
            params: { value: String(raw.follower ?? '') },
        });
    }

    // --- DOB ↔ national ID cross-check (never infer governorate from the ID) ---
    const derived = dobFromNationalId(national_id);
    if (!date_of_birth.value && derived) {
        date_of_birth.value = derived;
        flags.push({
            field: 'date_of_birth', when: derived,
            key: 'Born date derived from the national ID — verify the year matches this patient.',
        });
    } else if (date_of_birth.value && derived && derived !== date_of_birth.value) {
        flags.push({
            field: 'date_of_birth', when: date_of_birth.value,
            key: 'This DOB disagrees with the national ID date (:derived) — check which is right.',
            params: { derived },
        });
    }

    // --- notes: a real list (stored as JSONB), never one ';' string ---
    let notes = [];
    if (Array.isArray(raw?.notes)) {
        notes = raw.notes.map((n) => cleanString(n)).filter(Boolean);
    } else if (raw?.notes !== null && raw?.notes !== undefined && String(raw.notes).trim() !== '') {
        notes = String(raw.notes).split(/\s*[;\n]\s*/).map((s) => s.trim()).filter(Boolean);
    }

    // --- model-reported uncertainty: surfaced in the review table ---
    if (Array.isArray(raw?.uncertain)) {
        raw.uncertain.forEach((entry) => {
            const text = cleanString(entry);
            if (!text) return;
            const field = (text.match(/^([\w_]+)\s*:/) || [])[1];
            if (field && AI_PATIENT_FIELDS.includes(field)) {
                flags.push({
                    field, when: String(field === 'name' ? name : raw?.[field] ?? ''),
                    key: 'The AI was unsure about this value: ":detail" — verify it.',
                    params: { detail: text },
                });
            } else {
                flags.push({
                    field: null, when: null,
                    key: 'The AI reported an uncertain value: ":detail" — verify it in the source.',
                    params: { detail: text },
                });
            }
        });
    } else if (raw?.uncertain && String(raw.uncertain).trim() !== '') {
        flags.push({
            field: null, when: null,
            key: 'The AI reported an uncertain value: ":detail" — verify it in the source.',
            params: { detail: String(raw.uncertain) },
        });
    }

    // --- hard errors: missing name / missing ID prevent import entirely ---
    if (!name) errors.push({ key: 'Name is required' });
    if (!national_id) errors.push({ key: 'National ID is required' });

    // --- assemble the stored row ---
    const data = {
        name,
        national_id,
        mobile: mobile || null,
        date_of_birth: date_of_birth.value,
        age: age.value,
        marital_status,
        children_count: children_count.value,
        governorate,
        address: address ?? null,
        problem: problem ?? null,
        solution: solution ?? null,
        price: price.value,
        visit_date: visit_date.value,
        source_of_money,
        follower,
        notes,
    };

    // "Apply to every patient": fill ONLY fields the extraction left blank.
    for (const [field, value] of Object.entries(defaults ?? {})) {
        if (value === undefined || value === '' || value === null) continue;
        const blank = data[field] === null || data[field] === undefined || data[field] === ''
            || (field === 'notes' && Array.isArray(data.notes) && !data.notes.length);
        if (blank) data[field] = field === 'notes' ? [value] : value;
    }

    return {
        id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        data,
        flags,
        errors,
        unknown,
        source: sourceLabel,
        duplicate: null,          // set later by the duplicate check
        duplicateMode: 'skip',
        selected: false,
        expanded: false,
    };
}

// --- review-table status -----------------------------------------------------

const NID_RE = /^\d{14}$/;
const MOBILE_RE = /^01\d{9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Re-evaluate one row on every edit so statuses stay honest. Errors → the
 * row is skipped at Import; warnings → "Check" (amber) but importable.
 * Extraction-time flags (a derived DOB, an AI uncertainty, a bad original
 * value) stay visible only while the field value they were raised for has
 * not been edited — once staff repairs the cell, its flag is considered
 * addressed.
 */
export function evaluateRow(data, flags = [], followerKeys = FOLLOWER_KEYS) {
    const errors = [];
    const warnings = {};

    const name = String(data.name ?? '').trim();
    const nid = String(data.national_id ?? '').trim();
    const mobile = String(data.mobile ?? '').trim();

    if (!name) errors.push({ key: 'Name is required' });
    if (!nid) errors.push({ key: 'National ID is required' });
    else if (!NID_RE.test(nid)) errors.push({ key: 'National ID must be 14 digits' });

    const warn = (field, key, params = {}) => {
        if (!warnings[field]) warnings[field] = [];
        warnings[field].push({ key, params });
    };

    if (!mobile || !MOBILE_RE.test(mobile)) {
        warn('mobile', mobile ? 'needs 11 digits starting with 01' : 'mobile is missing');
    }
    if (data.date_of_birth && !DATE_RE.test(String(data.date_of_birth))) {
        warn('date_of_birth', 'not a valid YYYY-MM-DD date');
    }
    if (data.visit_date && !DATE_RE.test(String(data.visit_date))) {
        warn('visit_date', 'not a valid YYYY-MM-DD date');
    }
    for (const field of ['age', 'price', 'children_count']) {
        const value = data[field];
        if (value !== null && value !== undefined && value !== '' && !Number.isFinite(Number(value))) {
            warn(field, 'not a number');
        }
    }
    if (data.marital_status && !MARITAL.has(data.marital_status)) warn('marital_status', 'not one of single/married/divorced/widowed');
    if (data.governorate && !GOVERNORATES.has(data.governorate)) warn('governorate', 'not in the governorate list');
    if (data.source_of_money && !MONEY.has(data.source_of_money)) warn('source_of_money', 'must be charity or country');
    if (data.follower && !followerKeys?.has?.(data.follower)) warn('follower', 'not one of the recognized follower names');

    // Extraction-time flags, only while the value is untouched.
    for (const flag of flags) {
        if (flag.field) {
            const when = String(flag.when ?? '');
            if (String(data[flag.field] ?? '') !== when) continue;
        }
        if (!warnings[flag.field ?? '_row']) warnings[flag.field ?? '_row'] = [];
        warnings[flag.field ?? '_row'].push({ key: flag.key, params: flag.params ?? {} });
    }

    if (errors.length) return { status: 'error', errors, warnings };
    if (Object.keys(warnings).length) return { status: 'check', errors, warnings };
    return { status: 'ready', errors, warnings: {} };
}

// --- persistence (Phase 3) ---------------------------------------------------

/** Handle care for a saved patient: name/nid/mobile for the skipped report. */
function mkFailed(row, error) {
    const data = row.data ?? row;
    return {
        row,
        name: data.name ?? '',
        national_id: data.national_id ?? '',
        reason: describeDbError(error),
    };
}

/**
 * One Import click = one batch id (import_batch_id) stamped on every inserted
 * row together with user_id and section. Rows go in chunks of 50; a failed
 * chunk is retried one-by-one so a single bad row (e.g. a unique national ID
 * inserted by someone else between review and Import) cannot abort the rest.
 * Rows marked duplicateMode 'fill' become narrow UPDATEs that fill only
 * null/empty fields on the existing, user-visible patient.
 */
export async function importBatch(rows, { userId, section, batchSize = 50 } = {}) {
    const batchId = crypto.randomUUID();
    const saved = [];
    const failed = [];

    const insertPayloadFor = (row) => {
        const data = row.data;
        return {
            name: String(data.name ?? '').trim(),
            national_id: String(data.national_id ?? '').trim(),
            mobile: data.mobile || null,
            date_of_birth: data.date_of_birth || null,
            age: data.age ?? null,
            marital_status: data.marital_status || null,
            children_count: data.children_count ?? 0,
            governorate: data.governorate || null,
            address: data.address || null,
            problem: data.problem || null,
            solution: data.solution || null,
            price: data.price ?? null,
            visit_date: data.visit_date || null,
            source_of_money: data.source_of_money || null,
            follower: data.follower || null,
            notes: Array.isArray(data.notes) ? data.notes.filter(Boolean) : [],
            is_completed: false,
            user_id: userId,
            // A per-row section (only admins can set it in the review grid)
            // wins; otherwise the run-level section the staff chose.
            section: data.section || section || null,
            import_batch_id: batchId,
        };
    };

    /** Only null/empty fields are filled; existing values are never overwritten. */
    const fillPayloadFor = (data) => {
        const valueOrNull = (value) => (value === null || value === undefined || value === '') ? null : value;
        return {
            mobile: valueOrNull(data.mobile),
            date_of_birth: valueOrNull(data.date_of_birth),
            age: valueOrNull(data.age),
            marital_status: valueOrNull(data.marital_status),
            governorate: valueOrNull(data.governorate),
            address: valueOrNull(data.address),
            problem: valueOrNull(data.problem),
            solution: valueOrNull(data.solution),
            price: valueOrNull(data.price),
            visit_date: valueOrNull(data.visit_date),
            source_of_money: valueOrNull(data.source_of_money),
            follower: valueOrNull(data.follower),
            notes: Array.isArray(data.notes) && data.notes.length ? data.notes : null,
        };
    };

    for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const inserts = chunk.filter((row) => row.duplicateMode !== 'fill');
        const fills = chunk.filter((row) => row.duplicateMode === 'fill');

        if (inserts.length) {
            let bulkOk = false;
            try {
                const { data, error } = await supabase()
                    .from('patients')
                    .insert(inserts.map(insertPayloadFor))
                    .select();
                if (error) throw error;
                saved.push(...data);
                bulkOk = true;
            } catch {
                bulkOk = false;
            }
            if (!bulkOk) {
                for (const row of inserts) {
                    try {
                        const { data, error } = await supabase()
                            .from('patients')
                            .insert(insertPayloadFor(row))
                            .select()
                            .single();
                        if (error) throw error;
                        saved.push(data);
                    } catch (e) {
                        failed.push(mkFailed(row, e));
                    }
                }
            }
        }

        for (const row of fills) {
            try {
                const { data, error } = await supabase()
                    .from('patients')
                    .update(fillPayloadFor(row.data))
                    .eq('id', row.duplicate.existingId)
                    .select()
                    .single();
                if (error) throw error;
                saved.push(data);
            } catch (e) {
                failed.push(mkFailed(row, e));
            }
        }
    }

    return { batchId, saved, failed };
}

/**
 * Undo: hard-delete exactly the rows this Import created. Refreshes the
 * caller's view of "edits made since import will be lost" — after undo the
 * batch no longer exists, so a second undo is refused by the empty result.
 */
export async function undoImportBatch(batchId) {
    const { data, error } = await supabase()
        .from('patients')
        .delete()
        .eq('import_batch_id', batchId)
        .select();
    if (error) throw error;
    return data ?? [];
}

/** Database errors in words, not SQL codes. */
export function describeDbError(error) {
    const message = String(error?.message ?? '');
    if (error?.code === '23505' || /duplicate key|unique constraint/i.test(message)) {
        return { key: 'A patient with this National ID already exists.' };
    }
    if (error?.code === '23514' || /check constraint/i.test(message)) {
        return { key: 'A value is not on the allowed list — check Section, Source of Money, or Marital Status.' };
    }
    if (error?.code === '23503' || /foreign key/i.test(message)) {
        return { key: 'Reference problem — sign in again or check the assigned section.' };
    }
    if (error?.code === '42501' || /row-level security/i.test(message)) {
        return { key: 'Your account is not allowed to save a patient here — check the selected section.' };
    }
    return { key: message || 'Save failed for an unknown reason.' };
}
