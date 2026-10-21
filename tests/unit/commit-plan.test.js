// The commit plan (spec §11): what the reviewed rows become in `patients`.
//
// The browser previews the plan, the Edge Function rebuilds it and the SQL
// writes it - all three use this module, so they cannot disagree.

import { describe, expect, it } from 'vitest';
import {
    buildRecord, effectiveStatus, FILLABLE_COLUMNS, patientValues, planCommit, planCounts, planRow,
} from '@import-core/commit-plan.js';

const cell = (value, origin = 'extracted') => ({ value, origin, raw: value === null ? '' : String(value) });

function row(over = {}) {
    return {
        id: 'row-1',
        seq: 1,
        chunk_id: 'chunk-1',
        extracted: { name: 'Fatma', national_id: '28811220501187' },
        cells: {
            name: cell('Fatma Ibrahim Ali'),
            national_id: cell('28811220501187'),
            mobile: cell('01012345678'),
            date_of_birth: cell('1988-11-05'),
            age: cell(37, 'derived'),
            governorate: cell('Alexandria'),
            section: cell('agamy'),
            notes: cell(['allergic to penicillin']),
        },
        issues: [],
        acknowledged: [],
        dup: null,
        removed: false,
        status: 'ready',
        ...over,
    };
}

describe('patientValues', () => {
    it('writes the registry columns and skips the empty ones', () => {
        const values = patientValues(row());
        expect(values.name).toBe('Fatma Ibrahim Ali');
        expect(values.national_id).toBe('28811220501187');
        expect(values.notes).toEqual(['allergic to penicillin']);
        expect(values.problem).toBeUndefined();
        expect(values.price).toBeUndefined();
    });
});

describe('planRow', () => {
    it('creates a normal row', () => {
        const plan = planRow(row());
        expect(plan.action).toBe('create');
        expect(plan.values.national_id).toBe('28811220501187');
    });

    it('skips a removed row', () => {
        const plan = planRow(row({ removed: true }));
        expect(plan.action).toBe('skip');
        expect(plan.code).toBe('REMOVED');
    });

    it('skips a row with an error', () => {
        const plan = planRow(row({
            issues: [{ code: 'NAME_REQUIRED', severity: 'error', field: 'name' }],
        }));
        expect(plan.action).toBe('skip');
        expect(plan.code).toBe('ERROR');
    });

    it('skips a duplicate the reviewer left alone', () => {
        const plan = planRow(row({ dup: { kind: 'in_batch', action: 'skip', duplicateOf: 1 } }));
        expect(plan.action).toBe('skip');
        expect(plan.code).toBe('DUPLICATE');
    });

    it('fills the missing fields of the patient with the same national id', () => {
        const plan = planRow(row({ dup: { kind: 'existing_visible', action: 'fill', existing_id: '28811220501187' } }));
        expect(plan.action).toBe('fill');
        expect(plan.target_national_id).toBe('28811220501187');
        expect(plan.fill.mobile).toBe('01012345678');
        // The identity and the clinic's own classification are never filled.
        expect(plan.fill.name).toBeUndefined();
        expect(plan.fill.national_id).toBeUndefined();
        expect(plan.fill.section).toBeUndefined();
        expect(Object.keys(plan.fill).every((key) => FILLABLE_COLUMNS.includes(key))).toBe(true);
    });

    it('keeps a duplicate the reviewer decided to keep', () => {
        const plan = planRow(row({ dup: { kind: 'in_batch', action: 'keep', duplicateOf: 1 } }));
        expect(plan.action).toBe('create');
    });

    it('cannot keep a row whose national id already exists in the clinic', () => {
        const plan = planRow(row({ dup: { kind: 'existing_hidden', action: 'keep', existing_id: '28811220501187' } }));
        expect(plan.action).toBe('skip');
        expect(plan.code).toBe('NID_TAKEN');
    });
});

describe('effectiveStatus (the rule the commit shares with the review)', () => {
    it('a resolved duplicate does not block the row', () => {
        const issues = [{ code: 'DUP_IN_BATCH', severity: 'error', field: 'national_id' }];
        expect(effectiveStatus(row({ issues, dup: { kind: 'in_batch', action: 'keep' } }))).toBe('ready');
        expect(effectiveStatus(row({ issues, dup: { kind: 'in_batch', action: 'skip' } }))).toBe('error');
    });

    it('an acknowledged warning does not block the row', () => {
        const issues = [{ code: 'MOBILE_FORMAT', severity: 'warn', field: 'mobile' }];
        expect(effectiveStatus(row({ issues }))).toBe('review');
    });
});

describe('planCommit', () => {
    it('orders the rows and counts what happens', () => {
        const plan = planCommit([
            row({ id: 'b', seq: 2, removed: true }),
            row({ id: 'a', seq: 1 }),
            row({ id: 'c', seq: 3, dup: { kind: 'in_batch', action: 'skip' } }),
        ]);
        expect(plan.map((entry) => entry.row_id)).toEqual(['a', 'b', 'c']);
        expect(planCounts(plan)).toEqual({ create: 1, fill: 0, skip: 2 });
    });
});

describe('buildRecord', () => {
    it('feeds the reviewer edits back into the rules engine', () => {
        const built = buildRecord(row({
            cells: {
                ...row().cells,
                name: cell('Fatma Ali', 'user'),
            },
        }));
        expect(built.name).toBe('Fatma');
        expect(built._cells.name).toEqual({ raw: 'Fatma Ali', origin: 'user' });
    });
});
