import { describe, expect, it } from 'vitest';
import { dedupeBatch, nameDobKey, validNationalId } from '@import-core/dedupe.js';

const ID = '29805151201234';
const cell = (value) => ({ value, origin: 'extracted', raw: String(value) });
const row = (index, cells = {}, extra = {}) => ({
    index, cells, issues: [], rejected: false, dup: null, collapsed: false, ...extra,
});
const codes = (entry) => entry.issues.map((issue) => issue.code);

describe('validNationalId', () => {
    it('accepts only a clean 14-digit value', () => {
        expect(validNationalId(ID)).toBe(ID);
        expect(validNationalId('2980515120123')).toBeNull(); // 13 digits
        expect(validNationalId('298051512012345')).toBeNull(); // 15 digits
        expect(validNationalId('2980-5151-201234')).toBeNull(); // not normalized
        expect(validNationalId(null)).toBeNull();
    });
});

describe('nameDobKey', () => {
    it('folds the name and binds it to the ISO dob', () => {
        expect(nameDobKey(' أحمد   زكي ', '1998-05-15'))
            .toBe(nameDobKey('أحمد زكي', '1998-05-15'));
        expect(nameDobKey('أحمد زكي', '1998-05-16'))
            .not.toBe(nameDobKey('أحمد زكي', '1998-05-15'));
    });

    it('returns null when either half is missing', () => {
        expect(nameDobKey('أحمد زكي', '')).toBeNull();
        expect(nameDobKey('', '1998-05-15')).toBeNull();
    });
});

describe('dedupeBatch — in batch by national ID', () => {
    it('keeps the first row and flags every later one', () => {
        const first = row(1, { national_id: cell(ID) });
        const second = row(2, { national_id: cell(ID) });
        const third = row(3, { national_id: cell(ID) });
        dedupeBatch([first, second, third]);

        expect(first.dup).toBeNull();
        expect(second.dup).toEqual({ kind: 'in_batch', action: 'skip', duplicateOf: 1 });
        expect(third.dup).toEqual({ kind: 'in_batch', action: 'skip', duplicateOf: 1 });
        expect(codes(second)).toEqual(['DUP_IN_BATCH']);
        expect(codes(third)).toEqual(['DUP_IN_BATCH']);
    });
});

describe('dedupeBatch — against the database', () => {
    it('skips a visible existing patient with DUP_EXISTING_VISIBLE', () => {
        const existing = new Map([[ID, { visible: true }]]);
        const entry = row(1, { national_id: cell(ID) });
        dedupeBatch([entry], { existing });
        expect(entry.dup).toEqual({ kind: 'existing_visible', action: 'skip', existing_id: ID });
        expect(codes(entry)).toEqual(['DUP_EXISTING_VISIBLE']);
    });

    it('treats a hidden existing patient as an error (no silent overwrite)', () => {
        const existing = new Map([[ID, { visible: false }]]);
        const entry = row(1, { national_id: cell(ID) });
        dedupeBatch([entry], { existing });
        expect(entry.dup).toEqual({ kind: 'existing_hidden', action: 'skip', existing_id: ID });
        expect(codes(entry)).toEqual(['DUP_EXISTING_HIDDEN']);
    });

    it('lets the database match take precedence over the in-batch one', () => {
        const existing = new Map([[ID, { visible: true }]]);
        const first = row(1, { national_id: cell(ID) });
        const second = row(2, { national_id: cell(ID) });
        dedupeBatch([first, second], { existing });
        expect(first.dup.kind).toBe('existing_visible');
        expect(second.dup.kind).toBe('existing_visible');
        expect(second.issues.map((issue) => issue.code)).toEqual(['DUP_EXISTING_VISIBLE']);
    });
});

describe('dedupeBatch — overlap collapse', () => {
    it('collapses tile/chunk overlap copies into the earlier row', () => {
        const first = row(1, { national_id: cell(ID) });
        const copy = row(2, { national_id: cell(ID) });
        dedupeBatch([first, copy], { collapseOverlaps: (a, b) => a.index === 1 && b.index === 2 });

        expect(copy.collapsed).toBe(true);
        expect(copy.dup).toEqual({ kind: 'overlap', action: 'skip', duplicateOf: 1 });
        expect(codes(first)).toEqual(['DUP_OVERLAP_COLLAPSED']);
        expect(codes(copy)).toEqual(['DUP_OVERLAP_COLLAPSED']);
    });

    it('falls back to DUP_IN_BATCH when the callback says no', () => {
        const first = row(1, { national_id: cell(ID) });
        const second = row(2, { national_id: cell(ID) });
        dedupeBatch([first, second], { collapseOverlaps: () => false });
        expect(second.collapsed).toBe(false);
        expect(second.dup.kind).toBe('in_batch');
        expect(codes(second)).toEqual(['DUP_IN_BATCH']);
    });
});

describe('dedupeBatch — rows without a valid ID', () => {
    it('flags an exact folded name + mobile pair as DUP_POSSIBLE', () => {
        const first = row(1, { name: cell('أحمد زكي'), mobile: cell('01012345679') });
        const second = row(2, { name: cell(' أحمد  زكى '), mobile: cell('01012345679') });
        const other = row(3, { name: cell('أحمد زكي'), mobile: cell('01111111111') });
        dedupeBatch([first, second, other]);

        expect(first.dup).toBeNull();
        expect(second.dup).toEqual({ kind: 'possible', action: 'skip', duplicateOf: 1 });
        expect(codes(second)).toEqual(['DUP_POSSIBLE']);
        expect(other.dup).toBeNull();
    });

    it('does not flag a lone name or a lone mobile', () => {
        const first = row(1, { name: cell('أحمد زكي') });
        const second = row(2, { name: cell('أحمد زكي') });
        dedupeBatch([first, second]);
        expect(first.dup).toBeNull();
        expect(second.dup).toBeNull();
    });

    it('catches a mistyped ID through the visible name + DOB set', () => {
        const matches = new Set([nameDobKey('أحمد زكي', '1998-05-15')]);
        const entry = row(1, {
            national_id: cell(ID), // not in `existing` — the ID was mistyped on the other side
            name: cell('أحمد زكي'),
            date_of_birth: cell('1998-05-15'),
        });
        dedupeBatch([entry], { nameDobMatches: matches });
        expect(entry.dup).toEqual({ kind: 'name_dob', action: 'skip' });
        expect(codes(entry)).toEqual(['DUP_NAME_DOB_POSSIBLE']);
    });
});

describe('dedupeBatch — rejected rows', () => {
    it('ignores rows already rejected and never dedupes against them', () => {
        const rejected = row(1, { national_id: cell(ID) }, { rejected: true });
        const kept = row(2, { national_id: cell(ID) });
        dedupeBatch([rejected, kept]);
        expect(rejected.dup).toBeNull();
        expect(kept.dup).toBeNull();
    });
});
