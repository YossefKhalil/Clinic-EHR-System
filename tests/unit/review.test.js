// Review model tests (spec 10): revalidation through the shared pipeline,
// edits and reverts, acknowledgement lifecycle, filters, bulk operations,
// duplicates, the source panel helpers and the grid window.

import { describe, expect, it } from 'vitest';
import { runPipeline } from '@import-core/pipeline.js';
import { ENUM_SNAPSHOT, FIXTURE_TODAY, LINES } from '../fixtures/golden/fixture-01.js';
import { CANNED_RECORDS } from '../fixtures/golden/fixture-01-canned.js';
import {
    buildRecord, cellState, confirmationCounts, createReviewState, duplicatePartner,
    defaultsFromRows, editCell, effectiveStatus, enumOptions, filterCounts, filterRows,
    highlightLine, isEdited, isImportable, markReviewed, revalidate, revertCell,
    riskSort, setDefaults, setDupAction, setRemoved, setValueForRows, snapshotRow,
    sourceModel, unacknowledgedWarns, virtualWindow,
} from '../../src/features/import-agent/review.js';

const CHUNK_ID = 'chunk-1';

// Mirrors the pump: the pipeline sees pooled lines reduced to id + text.
const payloadLines = LINES.map((line) => ({ id: `S1:${line.id}`, text: line.text }));

function run(records) {
    return runPipeline({
        records,
        sourceId: 'S1',
        kind: 'text',
        lines: payloadLines,
        chunkLineIds: payloadLines.map((line) => line.id),
        snapshot: ENUM_SNAPSHOT,
        today: FIXTURE_TODAY,
    });
}

function dbRows(outcome, records) {
    return outcome.rows.map((row, index) => ({
        id: `row-${index + 1}`,
        job_id: 'job-1',
        chunk_id: CHUNK_ID,
        seq: index + 1,
        src: row.src,
        extracted: records[index],
        cells: row.cells,
        issues: row.issues,
        acknowledged: [],
        dup: row.dup ?? null,
        collapsed: row.collapsed === true,
        removed: false,
        status: row.status,
        version: 1,
    }));
}

function makeState(records = CANNED_RECORDS) {
    const outcome = run(records);
    const rows = dbRows(outcome, records);
    const state = createReviewState({
        rows,
        chunks: [{ id: CHUNK_ID, payload: { source_id: 'S1', kind: 'text', header: null, lines: payloadLines } }],
        config: { enum_snapshot: ENUM_SNAPSHOT },
        today: FIXTURE_TODAY,
    });
    return { state, rows, outcome };
}

const firstNamedRow = (rows) => rows.find((row) => row.cells.name.value);

describe('review revalidation', () => {
    it('changes nothing when nothing changed (same code, same inputs)', () => {
        const { state } = makeState();
        expect(revalidate(state)).toEqual([]);
    });

    it('a typed value becomes the raw input, normalized with the user origin', () => {
        const { state, rows } = makeState();
        const row = firstNamedRow(rows);
        const changes = editCell(state, row.id, 'mobile', '0109 999 8888');
        expect(changes).toHaveLength(1);
        expect(changes[0].id).toBe(row.id);
        expect(row.cells.mobile.value).toBe('01099998888');
        expect(row.cells.mobile.origin).toBe('user');
        expect(buildRecord(row)._cells.mobile.raw).toBe('0109 999 8888');
        expect(isEdited(row)).toBe(true);
    });

    it('clearing a required field raises the error and keeps the empty user cell', () => {
        const { state, rows } = makeState();
        const row = firstNamedRow(rows);
        editCell(state, row.id, 'name', '');
        expect(row.cells.name.value).toBe('');
        expect(row.cells.name.origin).toBe('user');
        expect(row.status).toBe('error');
        expect(row.issues.some((entry) => entry.code === 'NAME_REQUIRED')).toBe(true);
        // The pipeline still sees it as a user prefill, not an extraction.
        expect(buildRecord(row)._cells.name).toEqual({ raw: '', origin: 'user' });
    });

    it('revert restores the extracted value', () => {
        const { state, rows } = makeState();
        const row = firstNamedRow(rows);
        const original = row.cells.name.value;
        editCell(state, row.id, 'name', 'اسم يدوي مؤقت');
        expect(row.cells.name.value).toBe('اسم يدوي مؤقت');
        revertCell(state, row.id, 'name');
        expect(row.cells.name.value).toBe(original);
        expect(row.cells.name.origin).not.toBe('user');
        expect(buildRecord(row)._cells?.name).toBeUndefined();
    });

    it('editing one row leaves its siblings untouched', () => {
        const { state, rows } = makeState();
        const row = firstNamedRow(rows);
        const others = rows.filter((entry) => entry.id !== row.id).map((entry) => JSON.stringify(snapshotRow(entry)));
        editCell(state, row.id, 'address', 'شارع جديد 12');
        const after = rows.filter((entry) => entry.id !== row.id).map((entry) => JSON.stringify(snapshotRow(entry)));
        expect(after).toEqual(others);
    });
});

describe('acknowledgements (spec 10.6)', () => {
    it('mark reviewed acknowledges, and editing the value invalidates', () => {
        const { state, rows } = makeState();
        const row = rows.find((entry) => entry.cells.national_id.value === '29805151201234');
        editCell(state, row.id, 'visit_date', '01/01/2015');
        expect(row.status).toBe('review');
        expect(unacknowledgedWarns(row).some((entry) => entry.code === 'DATE_RANGE')).toBe(true);

        const changes = markReviewed(state, [row.id]);
        expect(changes.length).toBeGreaterThan(0);
        expect(row.acknowledged.some((key) => key.startsWith('DATE_RANGE\u0000visit_date\u0000'))).toBe(true);
        expect(unacknowledgedWarns(row).some((entry) => entry.code === 'DATE_RANGE')).toBe(false);

        editCell(state, row.id, 'visit_date', '02/02/2015');
        expect(unacknowledgedWarns(row).some((entry) => entry.code === 'DATE_RANGE')).toBe(true);
        expect(row.status).toBe('review');
    });
});

describe('filters, counts and the footer', () => {
    it('pills follow effective status and the removed tray', () => {
        const { state, rows } = makeState();
        const row = firstNamedRow(rows);
        editCell(state, row.id, 'name', '');

        const counts = filterCounts(rows);
        expect(counts.errors).toBeGreaterThanOrEqual(1);
        expect(counts.edited).toBeGreaterThanOrEqual(1);
        expect(filterRows(rows, 'errors')).toContain(row);
        expect(filterRows(rows, 'attention')).toContain(row);
        expect(filterRows(rows, 'edited')).toContain(row);

        setRemoved(state, [row.id], true);
        expect(filterCounts(rows).removed).toBe(1);
        expect(filterRows(rows, 'all')).not.toContain(row);
        expect(filterRows(rows, 'removed')).toContain(row);
        expect(filterRows(rows, 'attention')).not.toContain(row);

        setRemoved(state, [row.id], false);
        expect(filterCounts(rows).removed).toBe(0);
        expect(filterRows(rows, 'all')).toContain(row);
    });

    it('risk sort: errors, then most warnings, then ready', () => {
        const rows = [
            { id: 'a', status: 'ready', seq: 1, issues: [], acknowledged: [] },
            { id: 'b', status: 'error', seq: 2, issues: [{ code: 'NAME_REQUIRED', severity: 'error', field: 'name' }], acknowledged: [] },
            { id: 'c', status: 'review', seq: 3, issues: [{ code: 'MOBILE_FORMAT', severity: 'warn', field: 'mobile' }], acknowledged: [] },
        ];
        expect(riskSort(rows).map((row) => row.id)).toEqual(['b', 'c', 'a']);
    });

    it('confirmation counts partition the rows exactly', () => {
        const { rows } = makeState();
        const counts = confirmationCounts(rows);
        const removed = rows.filter((row) => row.removed).length;
        expect(counts.importable + counts.skippedErrors + counts.skippedDups).toBe(rows.length - removed);
        expect(counts.fresh + counts.fill).toBe(counts.importable);
    });
});

describe('bulk operations (spec 10.7)', () => {
    it('set value, fill-blanks mode, touches only blank cells with the default origin', () => {
        const { state, rows } = makeState();
        const before = rows.slice(0, 4).map((row) => ({
            row,
            value: row.cells.children_count?.value ?? '',
            blank: (row.cells.children_count?.value ?? '') === '',
        }));
        const ids = before.map((entry) => entry.row.id);
        const changes = setValueForRows(state, { ids, fieldKey: 'children_count', raw: '4', mode: 'blanks' });
        expect(changes.length).toBe(before.filter((entry) => entry.blank).length);
        for (const { row, value, blank } of before) {
            if (blank) {
                expect(row.cells.children_count.value).toBe(4);
                expect(row.cells.children_count.origin).toBe('default');
            } else {
                expect(row.cells.children_count.value).toBe(value);
            }
        }
    });

    it('overwrite mode writes even filled cells with the user origin', () => {
        const { state, rows } = makeState();
        const row = rows[0];
        editCell(state, row.id, 'children_count', '3');
        expect(row.cells.children_count.value).toBe(3);
        setValueForRows(state, { ids: [row.id], fieldKey: 'children_count', raw: '7', mode: 'overwrite' });
        expect(row.cells.children_count.value).toBe(7);
        expect(row.cells.children_count.origin).toBe('user');
    });

    it('the defaults panel fills blanks everywhere and survives reconstruction', () => {
        const { state, rows } = makeState();
        const blankRows = rows.filter((row) => (row.cells.children_count?.value ?? '') === '');
        const changes = setDefaults(state, { children_count: '2' });
        expect(changes.length).toBe(blankRows.length);
        for (const row of blankRows) {
            expect(row.cells.children_count.value).toBe(2);
            expect(row.cells.children_count.origin).toBe('default');
        }
        expect(defaultsFromRows(rows, {})).toMatchObject({ children_count: '2' });
        expect(defaultsFromRows(rows, { children_count: '9' })).toMatchObject({ children_count: '9' });
    });
});

describe('duplicates (spec 10.8)', () => {
    it('an in-batch pair points at its partner and keep resolves both ways', () => {
        const records = [{ ...CANNED_RECORDS[0] }, { ...CANNED_RECORDS[0] }];
        const { state, rows } = makeState(records);
        const later = rows[1];
        expect(later.dup?.kind).toBe('in_batch');
        expect(duplicatePartner(rows, later)).toBe(rows[0]);
        expect(effectiveStatus(later)).toBe('error');
        expect(isImportable(later)).toBe(false);

        const change = setDupAction(state, later.id, 'keep');
        expect(change?.after.dup.action).toBe('keep');
        expect(effectiveStatus(later)).not.toBe('error');
        expect(isImportable(later)).toBe(true);

        setDupAction(state, later.id, 'skip');
        expect(effectiveStatus(later)).toBe('error');
        expect(isImportable(later)).toBe(false);
    });
});

describe('source panel (spec 10.5)', () => {
    it('marks the cited lines and exposes sheet rows', () => {
        const { state, rows } = makeState();
        const row = firstNamedRow(rows);
        const model = sourceModel(state, row);
        expect(model.kind).toBe('text');
        const cited = model.lines.filter((line) => line.cited);
        expect(cited.length).toBeGreaterThan(0);
        expect(cited[0].id).toBe('S1:L001');

        const sheetState = createReviewState({
            rows: [],
            chunks: [{
                id: 'c2',
                payload: {
                    source_id: 'S2', kind: 'sheet', header: 'Name | ID',
                    lines: [{ id: 'S2:L001', text: 'منى | 29805151201234' }],
                },
            }],
            config: {}, today: FIXTURE_TODAY,
        });
        const sheet = sourceModel(sheetState, { chunk_id: 'c2', cells: {}, src: ['S2:L001'] }, 'name');
        expect(sheet.kind).toBe('sheet');
        expect(sheet.sheet.header).toEqual(['Name', 'ID']);
        expect(sheet.sheet.rows[0][1]).toBe('29805151201234');
    });

    it('highlightLine splits around every occurrence', () => {
        const segments = highlightLine('id 29901011234567 and 29901011234567 end', '29901011234567');
        expect(segments.filter((part) => part.match)).toHaveLength(2);
        expect(segments[0]).toEqual({ text: 'id ', match: false });
        expect(segments[1]).toEqual({ text: '29901011234567', match: true });
    });
});

describe('cells, enums and the grid window', () => {
    it('cellState reports severity plus origin icons', () => {
        const base = { cells: {}, issues: [], acknowledged: [] };
        expect(cellState({ ...base, cells: { name: { value: 'X', origin: 'user' } } }, 'name').icon).toBe('edited');
        expect(cellState({ ...base, cells: { name: { value: 'X', origin: 'snapped' } } }, 'name').icon).toBe('snap');
        expect(cellState({ ...base, cells: { name: { value: 'X', origin: 'derived' } } }, 'name').icon).toBe('derived');
        expect(cellState({ ...base, cells: { name: { value: 'X', origin: 'default' } } }, 'name').icon).toBe('default');
        expect(cellState({
            ...base,
            issues: [{ code: 'MODEL_UNCERTAIN', severity: 'warn', field: 'name', detail: { note: 'x' } }],
        }, 'name').icon).toBe('question');
        expect(cellState({
            ...base,
            issues: [{ code: 'NID_LENGTH', severity: 'error', field: 'national_id' }],
        }, 'national_id').severity).toBe('error');
    });

    it('enum options resolve built-ins and the job snapshot, bilingual', () => {
        expect(enumOptions('marital_status', {}, 'en')[0]).toEqual({ value: 'single', label: 'Single' });
        expect(enumOptions('governorate', {}, 'ar').find((option) => option.value === 'Dakahlia').label).toBe('الدقهلية');
        const snapshot = { follower: [{ key: 'amr', label_en: 'Dr Amr', label_ar: 'د. عمرو' }] };
        expect(enumOptions('follower', snapshot, 'ar')[0]).toEqual({ value: 'amr', label: 'د. عمرو' });
        expect(enumOptions('follower', snapshot, 'en')[0]).toEqual({ value: 'amr', label: 'Dr Amr' });
    });

    it('virtualWindow keeps the padding sums exact', () => {
        const win = virtualWindow({ scrollTop: 440, rowHeight: 44, viewportHeight: 500, total: 1000 });
        expect(win.start).toBe(2);
        expect(win.end - win.start).toBeGreaterThanOrEqual(12);
        expect(win.padTop).toBe(88);
        expect(win.end * 44 + win.padBottom).toBe(1000 * 44);
        expect(virtualWindow({ scrollTop: 0, rowHeight: 0, viewportHeight: 0, total: 0 }))
            .toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    });
});
