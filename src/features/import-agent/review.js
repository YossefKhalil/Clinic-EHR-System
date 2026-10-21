// Review model (spec §10) — the pure half of the review screen.
//
// The screen itself is the Alpine component in `ui.js`; everything here is
// plain ESM with no DOM and no network so it runs in Vitest unchanged. The
// central rule is §10.10's: every edit re-runs the SHARED import-core
// pipeline, so a row's status, issues and cells on screen are exactly what
// the functions would compute. Nothing in this module reads a clock: the
// caller passes `today`.
//
// Row identity: rows come from `import_rows` (uuid `id`, `chunk_id`, `seq`).
// A row's review fields (cells, issues, acknowledged, dup, removed, status)
// are the only things the browser may change (schema guard trigger) and every
// persisted change bumps `version` by one.

import { BULK_FILL_FIELDS, FIELDS, fieldByKey } from '@import-core/field-registry.js';
import { runPipeline } from '@import-core/pipeline.js';
import { deriveStatus, issueAckKey } from '@import-core/status.js';
import { GOVERNORATES, enumCandidates } from '@import-core/enums.js';

/** Filter pills on the review header (spec §10.2). */
export const REVIEW_FILTERS = Object.freeze(['all', 'attention', 'errors', 'duplicates', 'edited', 'removed']);

/** Group key for manual rows (no chunk): they revalidate as one group. */
export const MANUAL_GROUP = '__manual__';

/** The review-state object the functions below operate on. */
export function createReviewState({
    rows = [], chunks = [], config = {}, defaults = {},
    today, existing = new Map(), nameDobMatches = new Set(),
} = {}) {
    if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(String(today))) {
        throw new Error('createReviewState: `today` (ISO date) is required — the review never reads the clock');
    }
    const chunksById = new Map();
    for (const chunk of chunks) chunksById.set(chunk.id, chunk);
    return {
        rows,
        chunksById,
        config,
        defaults: { ...(defaults ?? {}) },
        today,
        existing,
        nameDobMatches,
    };
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

export function rowById(state, rowId) {
    return state.rows.find((row) => row.id === rowId) || null;
}

/** Field → value map, used by acknowledgement keys and the pipeline. */
export function cellValues(row) {
    const values = {};
    for (const [key, cell] of Object.entries(row.cells ?? {})) values[key] = cell?.value;
    return values;
}

export function isBlankCell(cell) {
    const value = cell?.value;
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    return String(value).trim() === '';
}

/** True when the reviewer changed any cell of the row. */
export function isEdited(row) {
    return Object.values(row.cells ?? {}).some((cell) => cell?.origin === 'user');
}

/** Warns that are not acknowledged yet (spec §10.6). */
export function unacknowledgedWarns(row) {
    const acked = new Set(row.acknowledged ?? []);
    return (row.issues ?? []).filter((entry) => entry.severity === 'warn'
        && !acked.has(issueAckKey(entry, entry.field ? row.cells?.[entry.field]?.value : undefined)));
}

export function unackWarnCount(row) {
    return unacknowledgedWarns(row).length;
}

/** Issues touching one cell (field-bound issues only). */
export function cellIssues(row, fieldKey) {
    return (row.issues ?? []).filter((entry) => entry.field === fieldKey);
}

/**
 * The cell's visual state (spec §10.4) — severity plus one icon name. Colour
 * is never the only signal, so the UI renders the icon beside every state and
 * resolves tooltips through the issue messages.
 */
export function cellState(row, fieldKey) {
    const issues = cellIssues(row, fieldKey);
    const error = issues.find((entry) => entry.severity === 'error');
    const uncertain = issues.find((entry) => entry.code === 'MODEL_UNCERTAIN');
    const warn = issues.find((entry) => entry.severity === 'warn');
    const cell = row.cells?.[fieldKey] ?? {};
    let icon = null;
    if (error) icon = 'error';
    else if (uncertain) icon = 'question';
    else if (warn) icon = 'warn';
    else if (cell.origin === 'snapped') icon = 'snap';
    else if (cell.origin === 'derived') icon = 'derived';
    else if (cell.origin === 'default') icon = 'default';
    else if (cell.origin === 'user') icon = 'edited';
    return { severity: error ? 'error' : warn ? 'warn' : null, icon, issues, origin: cell.origin ?? null };
}

// ---------------------------------------------------------------------------
// Sorting, filters and counts (§10.2, §10.6)
// ---------------------------------------------------------------------------

/** Codes dedupe owns; a resolved duplicate stops blocking (see effectiveStatus). */
export const DUP_CODES = Object.freeze(new Set([
    'DUP_IN_BATCH', 'DUP_POSSIBLE', 'DUP_NAME_DOB_POSSIBLE', 'DUP_OVERLAP_COLLAPSED',
    'DUP_EXISTING_VISIBLE', 'DUP_EXISTING_HIDDEN',
]));

/** True when the reviewer decided how to handle this duplicate. */
export function resolvedDup(row) {
    return Boolean(row.dup && row.dup.action && row.dup.action !== 'skip');
}

/**
 * The status the review screen shows. Same rules as `deriveStatus`, except
 * dedupe's own codes stop counting once the row's duplicate is resolved
 * (action fill/keep) — the kept row imports even though dedupe flagged it.
 * The stored `status` column keeps the pipeline's verdict.
 */
export function effectiveStatus(row) {
    const dupResolved = resolvedDup(row);
    const blocking = (row.issues ?? []).some((entry) => entry.severity === 'error'
        && !(dupResolved && DUP_CODES.has(entry.code)));
    if (blocking) return 'error';
    const warnings = unacknowledgedWarns(row).some((entry) => !(dupResolved && DUP_CODES.has(entry.code)));
    return warnings ? 'review' : 'ready';
}

/** A row can be imported (spec §10.9). */
export function isImportable(row) {
    if (row.removed) return false;
    if (effectiveStatus(row) === 'error') return false;
    if (row.dup && row.dup.action === 'skip') return false;
    return true;
}

function riskRank(row) {
    const status = effectiveStatus(row);
    if (status === 'error') return 0;
    if (status === 'review') return 1;
    return 2;
}

/** Risk sort (default): errors, then most warnings, then ready (§10.6). */
export function riskSort(rows) {
    return [...rows].sort((a, b) => {
        const rank = riskRank(a) - riskRank(b);
        if (rank !== 0) return rank;
        const warns = unackWarnCount(b) - unackWarnCount(a);
        if (warns !== 0) return warns;
        return (a.seq ?? 0) - (b.seq ?? 0);
    });
}

export function filterRows(rows, filter = 'all') {
    switch (filter) {
        case 'attention':
            return rows.filter((row) => !row.removed && effectiveStatus(row) !== 'ready');
        case 'errors':
            return rows.filter((row) => !row.removed && effectiveStatus(row) === 'error');
        case 'duplicates':
            return rows.filter((row) => !row.removed && row.dup && !row.collapsed);
        case 'ready':
            return rows.filter((row) => !row.removed && isImportable(row));
        case 'edited':
            return rows.filter((row) => !row.removed && isEdited(row));
        case 'removed':
            return rows.filter((row) => row.removed);
        default:
            return rows.filter((row) => !row.removed);
    }
}

export function filterCounts(rows) {
    const counts = { all: 0, attention: 0, errors: 0, duplicates: 0, ready: 0, edited: 0, removed: 0 };
    for (const row of rows) {
        if (row.removed) {
            counts.removed += 1;
            continue;
        }
        const status = effectiveStatus(row);
        counts.all += 1;
        if (status !== 'ready') counts.attention += 1;
        if (status === 'error') counts.errors += 1;
        if (row.dup && !row.collapsed) counts.duplicates += 1;
        if (isImportable(row)) counts.ready += 1;
        if (isEdited(row)) counts.edited += 1;
    }
    return counts;
}

/** Footer and confirmation counts (spec §10.9). */
export function confirmationCounts(rows) {
    const counts = {
        total: rows.length, importable: 0, fresh: 0, fill: 0,
        skippedErrors: 0, skippedDups: 0, unreviewed: 0,
    };
    for (const row of rows) {
        if (row.removed) continue;
        if (effectiveStatus(row) === 'error') {
            counts.skippedErrors += 1;
            continue;
        }
        if (row.dup && row.dup.action === 'skip') {
            counts.skippedDups += 1;
            continue;
        }
        counts.importable += 1;
        if (row.dup?.action === 'fill') counts.fill += 1;
        else counts.fresh += 1;
        if (unackWarnCount(row) > 0) counts.unreviewed += 1;
    }
    return counts;
}

// ---------------------------------------------------------------------------
// Pipeline revalidation (§10.3, §10.10)
// ---------------------------------------------------------------------------

/**
 * The record the pipeline re-runs for one row: the untouched extraction plus
 * the reviewer's own raw input. Only `user` and `default` cells are fed back —
 * snapped and derived values reproduce themselves deterministically from the
 * same record (their raw inputs did not change).
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

/** Keep the reviewer's duplicate decision (skip | fill | keep) when it still applies. */
export function preserveDup(prev, next) {
    if (!prev || !next) return next ?? null;
    if (prev.kind !== next.kind) return next;
    return { ...next, action: prev.action ?? next.action };
}

/** Acknowledgements are pruned to the warns that still exist at current values. */
export function pruneAcks(acknowledged, issues, cells) {
    const current = new Set();
    for (const entry of issues) {
        if (entry.severity !== 'warn') continue;
        current.add(issueAckKey(entry, entry.field ? cells?.[entry.field]?.value : undefined));
    }
    return (acknowledged ?? []).filter((key) => current.has(key));
}

/** A stale "model unsure" note disappears once the reviewer edits that field. */
function cleanUncertainty(issues, cells) {
    return issues.filter((entry) => !(entry.code === 'MODEL_UNCERTAIN'
        && entry.field
        && cells?.[entry.field]?.origin === 'user'));
}

function groupKeyOf(row) {
    return row.chunk_id ?? MANUAL_GROUP;
}

function groupRows(state, chunkId) {
    return state.rows
        .filter((row) => groupKeyOf(row) === chunkId)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

function pipelineInput(state, chunkId, group) {
    const manual = chunkId === MANUAL_GROUP;
    const chunk = manual ? null : state.chunksById.get(chunkId);
    const payload = chunk?.payload ?? {};
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    // Mirrors the pump exactly (lines reduced to id + text).
    const lineRecords = lines.map((line) => ({ id: line.id, text: line.text }));
    const lineIds = lineRecords.map((line) => line.id);
    // A photo of a note has no text lines: the model read the image, so
    // there is nothing to ground the values against.
    const isImage = payload.kind === 'image';
    return {
        records: group.map(buildRecord),
        sourceId: manual ? 'MANUAL' : (payload.source_id ?? 'S1'),
        kind: payload.kind === 'sheet' ? 'sheet' : isImage ? 'image' : 'text',
        lines: manual ? [] : lineRecords,
        chunkLineIds: manual ? [] : lineIds,
        dataLineIds: payload.kind === 'sheet' ? lineIds : null,
        snapshot: state.config?.enum_snapshot ?? {},
        today: state.today,
        defaults: state.defaults ?? {},
        existing: state.existing ?? new Map(),
        nameDobMatches: state.nameDobMatches ?? new Set(),
        requireSection: false,
        // Review-time rules: phantom rows stay on screen, manual rows and
        // image rows have no source text to ground against.
        keepPhantoms: true,
        ground: !manual && !isImage,
    };
}

function mergeGroup(group, outcome) {
    group.forEach((row, index) => {
        const fresh = outcome.rows[index];
        if (!fresh) return; // defensive: never drop a row from the screen
        const acknowledged = pruneAcks(row.acknowledged, fresh.issues, fresh.cells);
        const next = {
            cells: fresh.cells,
            issues: cleanUncertainty(fresh.issues, fresh.cells),
            acknowledged,
            dup: preserveDup(row.dup, fresh.dup),
        };
        next.status = deriveStatus(next.issues, { acknowledged, values: cellValues(next) });
        Object.assign(row, next);
    });
}

/** Row snapshot for change detection, history and persistence. */
export function snapshotRow(row) {
    return {
        id: row.id,
        cells: row.cells ?? {},
        issues: row.issues ?? [],
        acknowledged: row.acknowledged ?? [],
        dup: row.dup ?? null,
        removed: row.removed === true,
        status: row.status ?? null,
        version: row.version ?? 1,
    };
}

export function snapshotsDiffer(a, b) {
    return JSON.stringify(a.cells) !== JSON.stringify(b.cells)
        || a.status !== b.status
        || a.removed !== b.removed
        || JSON.stringify(a.issues) !== JSON.stringify(b.issues)
        || JSON.stringify(a.acknowledged) !== JSON.stringify(b.acknowledged)
        || JSON.stringify(a.dup ?? null) !== JSON.stringify(b.dup ?? null);
}

export function applySnapshot(row, snap) {
    Object.assign(row, {
        cells: snap.cells,
        issues: snap.issues,
        acknowledged: snap.acknowledged,
        dup: snap.dup,
        removed: snap.removed,
        status: snap.status,
        // The version is the database's optimistic-concurrency counter, not
        // part of the editable state: restoring the snapshot's (older)
        // version would make the next save fail with SAVE_CONFLICT forever.
        version: row.version ?? snap.version,
    });
}

/**
 * Re-run the shared pipeline over the affected chunk groups and merge the
 * results back into `state.rows` (in place). Returns the changed rows as
 * `{ id, before, after }` snapshots for persistence and undo.
 *
 * @param {object} state createReviewState() output
 * @param {{before?: Map<string, object>, touched?: Set<string>|null}} [options]
 *   `before` holds snapshots taken before the caller's mutation; `touched`
 *   limits the groups (null = every group).
 */
export function revalidate(state, { before = new Map(), touched = null } = {}) {
    const chunkIds = new Set();
    if (touched === null) {
        for (const row of state.rows) chunkIds.add(groupKeyOf(row));
    } else {
        for (const row of state.rows) {
            if (touched.has(row.id)) chunkIds.add(groupKeyOf(row));
        }
    }

    const changed = [];
    for (const chunkId of chunkIds) {
        // A chunk whose payload the reader cannot see is left untouched —
        // re-running without its lines would flag every value as ungrounded.
        if (chunkId !== MANUAL_GROUP && !state.chunksById.has(chunkId)) continue;
        // Same for a chunk whose payload was purged (retention): the rows keep
        // their extracted values instead of being blanked and flagged.
        const chunk = chunkId === MANUAL_GROUP ? null : state.chunksById.get(chunkId);
        if (chunk && chunk.payload == null) continue;
        const group = groupRows(state, chunkId);
        if (group.length === 0) continue;
        const pre = group.map((row) => before.get(row.id) ?? snapshotRow(row));
        const outcome = runPipeline(pipelineInput(state, chunkId, group));
        mergeGroup(group, outcome);
        group.forEach((row, index) => {
            const after = snapshotRow(row);
            if (snapshotsDiffer(pre[index], after)) changed.push({ id: row.id, before: pre[index], after });
        });
    }
    return changed;
}

// ---------------------------------------------------------------------------
// Edits and operations
// ---------------------------------------------------------------------------

/** Reviewer typed a value: it becomes this row's raw input for that field. */
export function editCell(state, rowId, fieldKey, raw) {
    const row = rowById(state, rowId);
    if (!row) return [];
    const before = new Map([[rowId, snapshotRow(row)]]);
    const cell = row.cells?.[fieldKey] ?? {};
    row.cells = { ...(row.cells ?? {}), [fieldKey]: { value: cell.value ?? '', origin: 'user', raw } };
    return revalidate(state, { before, touched: new Set([rowId]) });
}

/** Back to the extracted value: drop the override and re-run the pipeline. */
export function revertCell(state, rowId, fieldKey) {
    const row = rowById(state, rowId);
    const cell = row?.cells?.[fieldKey];
    if (!row || cell?.origin !== 'user') return [];
    const before = new Map([[rowId, snapshotRow(row)]]);
    row.cells = { ...(row.cells ?? {}), [fieldKey]: { value: '', origin: null, raw: '' } };
    return revalidate(state, { before, touched: new Set([rowId]) });
}

/** Bulk "set a value for the selected rows" (spec §10.7). */
export function setValueForRows(state, { ids, fieldKey, raw, mode = 'blanks' }) {
    if (!fieldByKey(fieldKey)) return [];
    const idSet = new Set(ids);
    const before = new Map();
    const touched = new Set();
    for (const row of state.rows) {
        if (!idSet.has(row.id) || row.removed) continue;
        const cell = row.cells?.[fieldKey] ?? {};
        if (mode === 'blanks' && !isBlankCell(cell)) continue;
        before.set(row.id, snapshotRow(row));
        touched.add(row.id);
        row.cells = {
            ...(row.cells ?? {}),
            [fieldKey]: {
                value: cell.value ?? '',
                origin: mode === 'blanks' ? 'default' : 'user',
                raw,
            },
        };
    }
    if (touched.size === 0) return [];
    return revalidate(state, { before, touched });
}

/** Change the bulk defaults panel: every group re-runs (fill blanks only). */
export function setDefaults(state, defaults) {
    state.defaults = { ...(defaults ?? {}) };
    return revalidate(state);
}

/**
 * On load, the effective defaults are the job's own plus any value already
 * applied to the rows (origin `default`), so a reload restores the panel and
 * the filled cells agree with it.
 */
export function defaultsFromRows(rows, base = {}) {
    const merged = { ...(base ?? {}) };
    for (const row of rows) {
        for (const field of BULK_FILL_FIELDS) {
            if (field.key in merged) continue;
            const cell = row.cells?.[field.key];
            if (cell?.origin === 'default' && cell.raw) merged[field.key] = cell.raw;
        }
    }
    return merged;
}

/** "Mark reviewed": acknowledge the row's current warnings (§10.6). */
export function markReviewed(state, ids) {
    const idSet = new Set(ids);
    const changed = [];
    for (const row of state.rows) {
        if (!idSet.has(row.id)) continue;
        const before = snapshotRow(row);
        const keys = new Set(row.acknowledged ?? []);
        for (const entry of row.issues ?? []) {
            if (entry.severity !== 'warn') continue;
            keys.add(issueAckKey(entry, entry.field ? row.cells?.[entry.field]?.value : undefined));
        }
        row.acknowledged = [...keys];
        row.status = deriveStatus(row.issues, { acknowledged: row.acknowledged, values: cellValues(row) });
        const after = snapshotRow(row);
        if (snapshotsDiffer(before, after)) changed.push({ id: row.id, before, after });
    }
    return changed;
}

/** Soft delete / restore (the Removed tray, §10.7). */
export function setRemoved(state, ids, removed) {
    const idSet = new Set(ids);
    const changed = [];
    for (const row of state.rows) {
        if (!idSet.has(row.id) || row.removed === removed) continue;
        const before = snapshotRow(row);
        row.removed = removed;
        const after = snapshotRow(row);
        if (snapshotsDiffer(before, after)) changed.push({ id: row.id, before, after });
    }
    return changed;
}

/** The reviewer's duplicate decision (skip | fill | keep). */
export function setDupAction(state, rowId, action) {
    const row = rowById(state, rowId);
    if (!row?.dup) return null;
    const before = snapshotRow(row);
    row.dup = { ...row.dup, action };
    const after = snapshotRow(row);
    return { id: row.id, before, after };
}

/**
 * The other row of an in-batch duplicate pair.
 *
 * `dup.duplicateOf` is an index in the *pipeline's* record space (which also
 * counts the records it rejected as phantoms), while the stored rows are
 * numbered again from 1. The two spaces only coincide when nothing was
 * rejected, so the index is used as a hint and the partner is confirmed by
 * the duplicate group: the earliest row of the same group.
 */
export function duplicatePartner(rows, row) {
    if (!row.dup || row.dup.duplicateOf == null) return null;
    const key = groupKeyOf(row);
    const group = rows
        .filter((entry) => groupKeyOf(entry) === key)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const hinted = group[row.dup.duplicateOf - 1] ?? null;
    if (hinted && hinted.id !== row.id) {
        // The hint only points at the right row when the record space and the
        // stored row space agree; otherwise fall back to the first row of the
        // group, which is the partner the pipeline flagged.
        const earlier = group.find((entry) => entry.id !== row.id);
        if (earlier && earlier.id !== hinted.id && (hinted.seq ?? 0) > (earlier.seq ?? 0)) {
            return earlier;
        }
        return hinted;
    }
    return group.find((entry) => entry.id !== row.id) ?? null;
}

// ---------------------------------------------------------------------------
// Source panel (§10.5)
// ---------------------------------------------------------------------------

/** Case-insensitive segment split for highlighting a value inside a line. */
export function highlightLine(text, needle) {
    const source = String(text ?? '');
    const value = String(needle ?? '');
    if (!value) return [{ text: source, match: false }];
    const segments = [];
    const haystack = source.toLowerCase();
    const target = value.toLowerCase();
    let at = 0;
    for (;;) {
        const found = haystack.indexOf(target, at);
        if (found < 0) break;
        if (found > at) segments.push({ text: source.slice(at, found), match: false });
        segments.push({ text: source.slice(found, found + target.length), match: true });
        at = found + target.length;
    }
    if (segments.length === 0) return [{ text: source, match: false }];
    if (at < source.length) segments.push({ text: source.slice(at), match: false });
    return segments;
}

/**
 * Everything the source drawer needs for one row: the cited lines with
 * context, and — for sheets — the same lines as mini-table rows.
 */
export function sourceModel(state, row, fieldKey = null) {
    const chunk = row.chunk_id ? state.chunksById.get(row.chunk_id) : null;
    const payload = chunk?.payload ?? null;
    if (!payload) return { kind: 'manual', header: null, lines: [], sheet: null, highlight: null };

    // A photo of a note: the source is the image itself.
    if (Array.isArray(payload.images) && payload.images.length > 0) {
        return {
            kind: 'image',
            header: null,
            lines: [],
            sheet: null,
            highlight: null,
            images: payload.images,
        };
    }

    const cited = new Set(Array.isArray(row.src) ? row.src : []);
    const lines = (Array.isArray(payload.lines) ? payload.lines : []).map((line) => ({
        id: line.id,
        text: line.text,
        blank: line.blank === true,
        cited: cited.has(line.id),
    }));
    const needle = fieldKey ? row.cells?.[fieldKey]?.value : null;
    const highlight = needle === null || needle === undefined || Array.isArray(needle)
        ? null
        : String(needle);
    return {
        kind: payload.kind === 'sheet' ? 'sheet' : 'text',
        header: typeof payload.header === 'string' ? payload.header : null,
        lines,
        sheet: payload.kind === 'sheet'
            ? { header: (payload.header ?? '').split(' | '), rows: lines.map((line) => String(line.text).split(' | ')) }
            : null,
        highlight,
    };
}

// ---------------------------------------------------------------------------
// Enum editors and grid layout helpers
// ---------------------------------------------------------------------------

/** Select options for an enum field: canonical value plus a display label. */
export function enumOptions(fieldKey, snapshot = {}, locale = 'en') {
    const field = fieldByKey(fieldKey);
    if (!field?.enum) return [];
    return enumCandidates(field.enum, snapshot).map((candidate) => {
        if (fieldKey === 'marital_status') {
            const label = candidate.value.charAt(0).toUpperCase() + candidate.value.slice(1);
            return { value: candidate.value, label };
        }
        if (fieldKey === 'governorate') {
            const entry = GOVERNORATES.find((gov) => gov.value === candidate.value);
            return { value: candidate.value, label: locale === 'ar' && entry ? entry.ar : candidate.value };
        }
        const labels = candidate.labels ?? [];
        const label = locale === 'ar' ? (labels[1] ?? labels[0]) : labels[0];
        return { value: candidate.value, label: label ?? candidate.value };
    });
}

/** Row window for the virtualized grid (§10.3: virtualized beyond ~200 rows). */
export function virtualWindow({ scrollTop, rowHeight, viewportHeight, total, overscan = 8 }) {
    if (total <= 0 || rowHeight <= 0 || viewportHeight <= 0) {
        return { start: 0, end: 0, padTop: 0, padBottom: 0 };
    }
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
    const end = Math.min(total, start + visible + 1);
    return {
        start,
        end,
        padTop: start * rowHeight,
        padBottom: Math.max(0, (total - end) * rowHeight),
    };
}
