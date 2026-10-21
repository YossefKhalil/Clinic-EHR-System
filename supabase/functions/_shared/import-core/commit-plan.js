// The commit plan (spec §11): what the reviewed rows become in `patients`.
//
// One implementation for the browser and the Edge Function: the browser
// previews the plan, the function rebuilds it server-side and writes it. The
// client's verdict is never trusted - the function re-runs the shared rules
// engine over the stored rows and decides again.

import { FIELDS } from './field-registry.js';
import { deriveStatus, issueAckKey } from './status.js';

/** The codes the review owns; a duplicate decision stops them from blocking. */
export const DUP_CODES = Object.freeze(new Set([
    'DUP_IN_BATCH', 'DUP_POSSIBLE', 'DUP_NAME_DOB_POSSIBLE', 'DUP_OVERLAP_COLLAPSED',
    'DUP_EXISTING_VISIBLE', 'DUP_EXISTING_HIDDEN',
]));

/**
 * The row's status as the reviewer sees it: a duplicate the reviewer
 * resolved (fill | keep) no longer blocks the row.
 */
export function effectiveStatus(row) {
    const dupResolved = Boolean(row.dup && row.dup.action && row.dup.action !== 'skip');
    const issues = row.issues ?? [];
    const blocking = issues.some((entry) => entry.severity === 'error'
        && !(dupResolved && DUP_CODES.has(entry.code)));
    if (blocking) return 'error';
    const acknowledged = new Set(row.acknowledged ?? []);
    const warns = issues.some((entry) => entry.severity === 'warn'
        && !acknowledged.has(issueAckKey(entry, entry.field ? row.cells?.[entry.field]?.value : undefined)));
    return warns ? 'review' : 'ready';
}

/**
 * The record the rules engine re-runs: the extracted one plus what the
 * reviewer typed (or the bulk defaults filled in).
 */
export function buildRecord(row) {
    const base = row.extracted && typeof row.extracted === 'object' ? { ...row.extracted } : {};
    const prefills = {};
    for (const field of FIELDS) {
        const cell = row.cells?.[field.key];
        if (!cell) continue;
        if (cell.origin === 'user' || cell.origin === 'default') {
            prefills[field.key] = { raw: cell.raw ?? '', origin: cell.origin };
        }
    }
    if (Object.keys(prefills).length > 0) base._cells = prefills;
    return base;
}

/** The patient columns a row writes (the registry's importable columns). */
export function patientValues(row) {
    const values = {};
    for (const field of FIELDS) {
        if (!field.column) continue;
        const cell = row.cells?.[field.key];
        if (!cell) continue;
        const value = cell.value;
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) {
            if (value.length > 0) values[field.column] = value;
            continue;
        }
        if (String(value).trim() === '') continue;
        values[field.column] = value;
    }
    return values;
}

/** The columns a "fill the missing fields" decision may write. */
export const FILLABLE_COLUMNS = Object.freeze([
    'mobile', 'date_of_birth', 'marital_status', 'children_count', 'governorate',
    'address', 'problem', 'solution', 'visit_date', 'price', 'follower',
]);

/**
 * What happens to one reviewed row.
 *
 * - `create`: a new patient.
 * - `fill`: the missing fields of the patient with the same national id.
 * - `skip`: nothing is written (removed, a problem row, or a duplicate the
 *   reviewer left alone).
 */
export function planRow(row) {
    const values = patientValues(row);
    const base = {
        row_id: row.id,
        seq: row.seq,
        name: values.name ?? '',
        national_id: values.national_id ?? '',
        values,
    };
    if (row.removed) return { ...base, action: 'skip', code: 'REMOVED' };
    if (effectiveStatus(row) === 'error') return { ...base, action: 'skip', code: 'ERROR' };

    const dupAction = row.dup?.action ?? null;
    const dupKind = row.dup?.kind ?? null;
    if (dupAction === 'skip') return { ...base, action: 'skip', code: 'DUPLICATE' };
    if (dupAction === 'fill') {
        return {
            ...base,
            action: 'fill',
            code: null,
            // The partner is found by the national id: the row the reviewer
            // filled into (an earlier row of this import or a patient that
            // already exists).
            target_national_id: values.national_id ?? '',
            fill: Object.fromEntries(
                FILLABLE_COLUMNS
                    .filter((column) => values[column] !== undefined)
                    .map((column) => [column, values[column]]),
            ),
        };
    }
    if (dupKind === 'existing_visible' || dupKind === 'existing_hidden') {
        // The national id is taken by a patient that already exists: a new
        // patient with the same id is impossible, so the row is skipped.
        if (dupAction === 'keep') return { ...base, action: 'skip', code: 'NID_TAKEN' };
    }
    return { ...base, action: 'create', code: null };
}

/**
 * The whole plan, in the order the rows are written (the sequence order:
 * a "fill" may target a patient that an earlier row of the same import
 * creates).
 */
export function planCommit(rows) {
    return [...rows]
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .map(planRow);
}

/** The counts the bar and the result message show. */
export function planCounts(plan) {
    const counts = { create: 0, fill: 0, skip: 0 };
    for (const entry of plan) counts[entry.action] += 1;
    return counts;
}

export { deriveStatus };
