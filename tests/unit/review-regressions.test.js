// Regression tests for the defects found in the October 2026 audit of the AI
// import system (see docs/import-agent/audit-2026-10-21.md):
//   - the import never wrote a patient (no commit path) - still open, tracked
//     as M6 in the audit;
//   - a repair call renumbered its documents and overwrote another patient;
//   - an unresolved duplicate was counted as importable while the UI promised
//     it would be skipped;
//   - undo restored a stale version and made every later save conflict;
//   - a chunk whose payload was purged blanked the row and wrote the
//     destruction back to the database.

import { describe, expect, it } from 'vitest';
import { runPipeline } from '@import-core/pipeline.js';
import { ENUM_SNAPSHOT, FIXTURE_TODAY, LINES } from '../fixtures/golden/fixture-01.js';
import { CANNED_RECORDS } from '../fixtures/golden/fixture-01-canned.js';
import {
    applySnapshot, confirmationCounts, createReviewState, duplicatePartner,
    effectiveStatus, isImportable, markReviewed, revalidate, snapshotRow, unackWarnCount,
} from '../../src/features/import-agent/review.js';

const CHUNK_ID = 'chunk-1';
const payloadLines = LINES.map((line) => ({ id: `S1:${line.id}`, text: line.text }));

function makeState(records = CANNED_RECORDS, chunk = {}) {
    const outcome = runPipeline({
        records,
        sourceId: 'S1',
        kind: 'text',
        lines: payloadLines,
        chunkLineIds: payloadLines.map((line) => line.id),
        snapshot: ENUM_SNAPSHOT,
        today: FIXTURE_TODAY,
    });
    const rows = outcome.rows.map((row, index) => ({
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
        collapsed: false,
        removed: false,
        status: row.status,
        version: 1,
    }));
    return createReviewState({
        rows,
        chunks: [{
            id: CHUNK_ID,
            payload: { source_id: 'S1', kind: 'text', header: null, lines: payloadLines },
            ...chunk,
        }],
        config: { enum_snapshot: ENUM_SNAPSHOT },
        today: FIXTURE_TODAY,
    });
}

describe('duplicate rows are skipped until the reviewer decides', () => {
    it('counts an unresolved duplicate as skipped, not importable', () => {
        const state = makeState();
        const row = state.rows[0];
        row.dup = { kind: 'in_batch', action: 'skip', duplicateOf: 1 };
        const counts = confirmationCounts(state.rows);
        expect(counts.importable + counts.skippedErrors + counts.skippedDups).toBe(state.rows.length);
        expect(isImportable(row)).toBe(false);
    });

    it('imports a duplicate the reviewer explicitly kept', () => {
        const state = makeState();
        const row = state.rows[0];
        row.dup = { kind: 'in_batch', action: 'keep', duplicateOf: 1 };
        expect(isImportable(row)).toBe(true);
        // The duplicate codes stop blocking, but the row's own warnings still
        // keep it in "needs attention" until the reviewer acknowledges them.
        expect(effectiveStatus(row)).not.toBe('error');
    });
});

describe('undo keeps the optimistic-concurrency version', () => {
    it('does not restore the stale version of the snapshot', () => {
        const state = makeState();
        const row = state.rows[0];
        const before = snapshotRow(row);
        row.version = 7;
        applySnapshot(row, before);
        // A stale version would make the next save fail with SAVE_CONFLICT.
        expect(row.version).toBe(7);
    });
});

describe('a purged chunk payload never blanks a reviewed row', () => {
    it('leaves the rows untouched when the chunk payload is gone', () => {
        const state = makeState();
        const before = snapshotRow(state.rows[0]);
        state.chunksById.get(CHUNK_ID).payload = null;
        const changes = revalidate(state);
        expect(changes).toHaveLength(0);
        expect(state.rows[0].cells.national_id.value).toBe(before.cells.national_id.value);
        expect(state.rows[0].status).toBe(before.status);
    });
});

describe('the duplicate partner is found even when the record space shifted', () => {
    it('falls back to the first row of the duplicate group', () => {
        const state = makeState();
        const [first, second] = state.rows;
        const key = {
            name: first.cells.name.value,
            national_id: first.cells.national_id.value,
        };
        first.cells.national_id = { value: key.national_id, origin: 'extracted' };
        second.cells.national_id = { value: key.national_id, origin: 'extracted' };
        first.cells.name = { value: key.name, origin: 'extracted' };
        second.cells.name = { value: key.name, origin: 'extracted' };
        // The pipeline's record index counts rejected records, so the stored
        // row space and the index do not have to agree.
        second.dup = { kind: 'in_batch', action: 'skip', duplicateOf: 7 };
        const partner = duplicatePartner(state.rows, second);
        expect(partner).toBe(first);
    });
});

describe('acknowledging a row clears its warnings', () => {
    it('marks a field-level warning as reviewed', () => {
        const state = makeState();
        const row = state.rows.find((entry) => (entry.issues ?? []).some((issue) => issue.severity === 'warn'));
        expect(row).toBeTruthy();
        expect(unackWarnCount(row)).toBeGreaterThan(0);
        const changes = markReviewed(state, [row.id]);
        expect(changes.length).toBeGreaterThan(0);
        expect(unackWarnCount(row)).toBe(0);
    });
});
