// Pipeline orchestration (spec §8.1): parsed model documents → review rows.
//
// Per record: normalize → ground/snap → repair swaps → derive and
// cross-check → apply defaults → validate. Then, for the whole batch:
// dedupe → status; reconciliation runs per chunk over the resolved citations.
//
// Everything is pure and deterministic: the caller passes `today`, the enum
// snapshot, the defaults and the database-match results. Nothing here reads
// the clock, the DOM, the network or storage — the browser and the Edge
// Functions run this same code (invariant I3).

import { FIELDS, fieldByKey } from './field-registry.js';
import { decodeNationalId, normalizeField, valueIsEmpty } from './normalizers.js';
import { validateField } from './validate.js';
import { issue } from './issues.js';
import {
    containsInjectionPhrase, deriveFields, groundRecord,
    reconcileChunk, repairMisplacedValues,
} from './verify.js';
import { dedupeBatch } from './dedupe.js';
import { deriveStatus } from './status.js';

function emptyCell(field) {
    return { value: field.type === 'list' ? [] : '', origin: null, raw: '' };
}

function asList(value) {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

function hasContent(value) {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    return String(value).trim() !== '';
}

/**
 * Run the full rules engine.
 *
 * @param {{
 *   records: object[],                    // parsed model output, source order
 *   sourceId?: string,                    // pooled source id (default `S1`)
 *   kind?: 'sheet'|'text'|'image',
 *   lines: {id: string, text: string, canonical?: string}[], // pooled ids (`S1:L001`)
 *   chunkLineIds?: string[]|null,         // lines of this chunk (default: all)
 *   dataLineIds?: string[]|null,          // sheet data rows for reconciliation
 *   snapshot?: object,                    // app_options lists frozen in the job
 *   today: string,                        // ISO date — required, never the clock
 *   defaults?: object,                    // bulk values (fill-blanks semantics)
 *   existing?: Map<string, {visible?: boolean}>, // DB matches by national ID
 *   nameDobMatches?: Set<string>,         // keys from dedupe.nameDobKey()
 *   collapseOverlaps?: ((a: object, b: object) => boolean) | null,
 *   requireSection?: boolean,             // true on the commit/save paths
 *   ground?: boolean,                     // false for manual rows (§10.7)
 *   keepPhantoms?: boolean,               // true on review edits (§10.10)
 * }} input
 */
export function runPipeline({
    records = [],
    sourceId = 'S1',
    kind = 'text',
    lines = [],
    chunkLineIds = null,
    dataLineIds = null,
    snapshot = {},
    today,
    defaults = {},
    existing = new Map(),
    nameDobMatches = new Set(),
    collapseOverlaps = null,
    requireSection = false,
    ground = true,
    keepPhantoms = false,
} = {}) {
    if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(String(today))) {
        throw new Error('runPipeline: `today` (ISO date) is required — the pipeline never reads the clock');
    }

    // Grounding reads the canonical text — the copy the model actually saw.
    const linesById = new Map();
    for (const line of lines) {
        linesById.set(line.id, { id: line.id, text: line.canonical ?? line.text });
    }
    const chunkIds = chunkLineIds || [...linesById.keys()];

    const rows = [];
    const rejected = [];
    records.forEach((record, offset) => {
        const row = runRecord(record, {
            index: offset + 1, sourceId, kind, linesById, chunkIds, snapshot,
            today, defaults, requireSection, groundEnabled: ground, keepPhantoms,
        });
        (row.rejected ? rejected : rows).push(row);
    });

    // Batch stages: dedupe, then status (spec §8.1 steps 9–10).
    dedupeBatch(rows, { existing, nameDobMatches, collapseOverlaps });
    for (const row of rows) {
        const values = {};
        for (const [key, cell] of Object.entries(row.cells)) values[key] = cell.value;
        row.status = deriveStatus(row.issues, { acknowledged: row.acknowledged, values });
    }

    // Reconciliation (spec §8.2.4) over accepted and rejected citations.
    const citedIds = new Set();
    for (const row of [...rows, ...rejected]) {
        for (const id of row.citedIds || []) citedIds.add(id);
    }
    const reconcile = reconcileChunk({
        kind,
        lines: chunkIds.map((id) => linesById.get(id)).filter(Boolean),
        dataLineIds: kind === 'sheet' ? (dataLineIds || chunkIds) : [],
        citedIds,
    });

    const counts = { rows: rows.length, rejected: rejected.length, ready: 0, review: 0, error: 0, collapsed: 0 };
    for (const row of rows) {
        if (counts[row.status] !== undefined) counts[row.status] += 1;
        if (row.collapsed) counts.collapsed += 1;
    }

    return {
        rows,
        rejected,
        issues: reconcile.issues,
        requeueSplit: reconcile.requeueSplit,
        counts,
    };
}

/**
 * One parsed record → one pipeline row. Returns a rejected row (tray entry)
 * when the record is a phantom (spec §8.2.2).
 */
function runRecord(record, context) {
    const {
        index, sourceId, kind, linesById, chunkIds, snapshot, today, defaults, requireSection,
        groundEnabled, keepPhantoms,
    } = context;

    const issues = [];
    const parseBuckets = new Map();

    // Parse-time issues (normalizers) are droppable: when grounding or a
    // repair replaces the cell value, its old flags no longer apply.
    const addParse = (entry) => {
        issues.push(entry);
        if (entry.field) {
            if (!parseBuckets.has(entry.field)) parseBuckets.set(entry.field, []);
            parseBuckets.get(entry.field).push(entry);
        }
    };
    const dropParse = (fieldKey) => {
        const bucket = parseBuckets.get(fieldKey);
        if (!bucket) return;
        for (const entry of bucket) {
            const at = issues.indexOf(entry);
            if (at >= 0) issues.splice(at, 1);
        }
        parseBuckets.delete(fieldKey);
    };

    const cells = {};
    for (const field of FIELDS) cells[field.key] = emptyCell(field);

    // Review edits (spec 10.10): `_cells` carries the reviewer's own raw input
    // per field together with its origin (`user` from an edit, `default` from
    // the bulk panel). A prefilled field replaces the extracted raw — its text
    // is normalized exactly like model output — and keeps its origin, so
    // grounding skips it: it is not a claim about the source.
    const prefills = record._cells && typeof record._cells === 'object' ? record._cells : null;

    // Step 4 (per-field normalization; 8.1 lists grounding before it, but
    // grounding compares normalized values, and the DOB disambiguation needs
    // the already-normalized national ID).
    for (const field of FIELDS) {
        const prefill = prefills && prefills[field.key] ? prefills[field.key] : null;
        const edited = Boolean(prefill) && (prefill.origin === 'user' || prefill.origin === 'default');
        let value;
        let origin;
        if (edited) {
            value = prefill.raw !== undefined ? prefill.raw : prefill.value;
            origin = prefill.origin;
        } else {
            if (!field.extract) continue;
            value = record[field.key];
            origin = 'extracted';
        }
        if (!hasContent(value)) {
            if (!edited) continue;
            // The reviewer cleared the cell: it stays an empty `user` cell so
            // reload and revalidation both keep it clear.
            cells[field.key] = {
                value: field.type === 'list' ? [] : '',
                origin,
                raw: value === null || value === undefined ? '' : String(value),
            };
            continue;
        }
        let idDate = null;
        if (field.key === 'date_of_birth') {
            idDate = decodeNationalId(cells.national_id?.value)?.date ?? null;
        }
        const result = normalizeField(field, value, { today, snapshot, idDate });
        cells[field.key] = {
            value: result.value,
            // A cleared cell keeps its `user` origin — the reviewer's empty
            // value must survive revalidation and reload like any edit.
            origin: valueIsEmpty(result.value) ? (edited ? origin : null) : origin,
            raw: result.raw !== undefined ? result.raw : String(value ?? ''),
        };
        for (const entry of result.issues) addParse(entry);
    }

    // Meta: unmapped tray (UNMAPPED_TEXT) and per-field uncertainty notes.
    const unmapped = [];
    for (const entry of asList(record.unmapped)) {
        const text = String(entry ?? '').trim();
        if (text) unmapped.push(text);
    }
    for (const [key, value] of Object.entries(record)) {
        // `unmapped` is explicit; every other underscore-prefixed key is
        // pipeline meta (`_src`, `_uncertain`, `_chunkIndex`, `_cells`).
        if (key === 'unmapped' || key.startsWith('_')) continue;
        if (fieldByKey(key)) continue;
        const text = Array.isArray(value) ? value.join(' ') : String(value ?? '');
        if (!text.trim()) continue;
        unmapped.push(`${key}: ${text.trim()}`);
    }
    if (unmapped.length) issues.push(issue('UNMAPPED_TEXT', { detail: { entries: unmapped.length } }));

    const uncertain = [];
    for (const entry of asList(record._uncertain)) {
        const note = String(entry ?? '').trim();
        if (!note) continue;
        const sep = note.indexOf(':');
        const key = (sep >= 0 ? note.slice(0, sep) : note).trim();
        const field = fieldByKey(key);
        uncertain.push({ field: field ? key : null, note });
        issues.push(issue('MODEL_UNCERTAIN', {
            field: field ? key : null,
            detail: { note, reason: sep >= 0 ? note.slice(sep + 1).trim() : null },
        }));
    }

    // Step 3: ground and snap (§8.2). Manual rows are typed by the reviewer,
    // so there is no source to ground against; review edits keep phantom rows
    // on screen (`lenient`) and let the per-field checks flag them.
    const grounding = groundEnabled
        ? groundRecord({
            cells, srcValue: record._src, sourceId, linesById, chunkLineIds: chunkIds,
            lenient: keepPhantoms,
        })
        : {
            cells, issues: [], changedFields: [], phantom: false,
            citedIds: [], srcValid: true, foundInChunkOnly: false,
        };
    for (const fieldKey of grounding.changedFields) dropParse(fieldKey);
    issues.push(...grounding.issues);

    if (grounding.phantom && !keepPhantoms) {
        return {
            index,
            rejected: true,
            reason: 'PHANTOM_RECORD',
            raw: JSON.stringify(record),
            srcRaw: record._src ?? null,
            citedIds: grounding.citedIds,
            cells,
            issues,
        };
    }

    // Prompt-injection and image-legibility signals (§7.6, §8.4).
    const citedTexts = grounding.citedIds.map((id) => linesById.get(id)?.text ?? '');
    if (citedTexts.some((text) => containsInjectionPhrase(text))) {
        issues.push(issue('POSSIBLE_INJECTION', { detail: { lineIds: grounding.citedIds } }));
    }
    if (kind === 'image' && citedTexts.some((text) => text.includes('[?]'))) {
        issues.push(issue('LOW_CONFIDENCE_IMAGE', { detail: { lineIds: grounding.citedIds } }));
    }

    // Step 5: repair swaps.
    const repair = repairMisplacedValues(cells);
    for (const fieldKey of repair.changedFields) dropParse(fieldKey);
    issues.push(...repair.issues);

    // Step 6: derivations and cross-checks.
    const derive = deriveFields(cells, { today });
    issues.push(...derive.issues);

    // Step 7: bulk defaults — fill blanks only (spec §8.7). A cell the
    // reviewer edited is never overwritten, even when they cleared it.
    for (const [key, value] of Object.entries(defaults || {})) {
        const field = fieldByKey(key);
        if (!field || !field.bulkFill || !hasContent(value)) continue;
        const cell = cells[key];
        if (!cell || cell.origin === 'user' || !valueIsEmpty(cell.value)) continue;
        const result = normalizeField(field, value, { today, snapshot });
        if (valueIsEmpty(result.value)) continue;
        cells[key] = { value: result.value, origin: 'default', raw: String(value ?? '') };
    }

    // Step 8: validate.
    for (const field of FIELDS) {
        const found = validateField(field, cells[field.key]?.value, { today, requireSection, snapshot });
        issues.push(...found);
    }

    return {
        index,
        rejected: false,
        src: grounding.citedIds,
        citedIds: grounding.citedIds,
        srcRaw: record._src ?? null,
        srcValid: grounding.srcValid,
        phantom: grounding.phantom,
        chunkIndex: Number.isInteger(record._chunkIndex) ? record._chunkIndex : null,
        cells,
        issues,
        unmapped,
        uncertain,
        idHint: derive.decoded
            ? { date: derive.decoded.date, governorateCode: derive.decoded.governorateCode }
            : null,
        acknowledged: [],
        dup: null,
        collapsed: false,
        status: null,
    };
}
