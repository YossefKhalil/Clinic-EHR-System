import { describe, expect, it } from 'vitest';
import { FIELDS, fieldByKey } from '@import-core/field-registry.js';
import { LIMITS } from '@import-core/limits.js';
import { VALIDATORS, VALIDATOR_NAMES, validateField } from '@import-core/validate.js';

const TODAY = '2026-10-17';
const codes = (issues) => issues.map((entry) => entry.code);
const run = (key, value, context = {}) => validateField(fieldByKey(key), value, { today: TODAY, ...context });

describe('required validators', () => {
    it('nameRequired and nidRequired fire on empty values only', () => {
        expect(codes(run('name', ''))).toEqual(['NAME_REQUIRED']);
        expect(codes(run('name', null))).toEqual(['NAME_REQUIRED']);
        expect(codes(run('name', 'أحمد زكي'))).toEqual([]);
        expect(codes(run('national_id', ''))).toEqual(['NID_REQUIRED']);
        expect(codes(run('national_id', '29805151201234'))).toEqual([]);
    });

    it('sectionRequired only fires on the save paths (requireSection)', () => {
        expect(codes(run('section', ''))).toEqual([]);
        expect(codes(run('section', '', { requireSection: true }))).toEqual(['SECTION_REQUIRED']);
        expect(codes(run('section', 'Cairo', { requireSection: true }))).toEqual([]);
    });
});

describe('nidDateRange', () => {
    it('rejects an ID whose birth date is in the future', () => {
        // 32705151201234 decodes to 2027-05-15, after TODAY.
        const found = run('national_id', '32705151201234');
        expect(codes(found)).toEqual(['NID_DATE_INVALID']);
        expect(found[0].detail).toEqual({ date: '2027-05-15', reason: 'future' });
    });

    it('accepts today and the past, and skips empty or unsent today', () => {
        expect(codes(run('national_id', '32610171201234'))).toEqual([]); // == TODAY
        expect(codes(run('national_id', '29805151201234'))).toEqual([]);
        expect(codes(run('national_id', ''))).toEqual(['NID_REQUIRED']); // nidDateRange itself stays quiet
        expect(codes(validateField(fieldByKey('national_id'), '32705151201234', {}))).toEqual([]);
    });
});

describe('dateOfBirthRange', () => {
    it('rejects future dates and ages above the maximum', () => {
        expect(run('date_of_birth', '2027-01-01')[0]).toMatchObject({
            code: 'DATE_RANGE', detail: { value: '2027-01-01', reason: 'future' },
        });
        const tooOld = run('date_of_birth', '1900-01-01');
        expect(tooOld[0]).toMatchObject({ code: 'DATE_RANGE', detail: { reason: 'too_old' } });
    });

    it('accepts the boundaries: today and exactly 120 years', () => {
        expect(codes(run('date_of_birth', TODAY))).toEqual([]);
        const exactly120 = `${Number(TODAY.slice(0, 4)) - 120}${TODAY.slice(4)}`;
        expect(run('date_of_birth', exactly120)).toEqual([]);
        expect(codes(run('date_of_birth', ''))).toEqual([]);
    });
});

describe('visitDateRange', () => {
    it('allows up to one day in the future', () => {
        expect(codes(run('visit_date', '2026-10-17'))).toEqual([]);
        expect(codes(run('visit_date', '2026-10-18'))).toEqual([]);
        expect(codes(run('visit_date', '2026-10-19'))).toEqual(['DATE_RANGE']);
        expect(run('visit_date', '2026-10-19')[0].detail.reason).toBe('future');
    });

    it('rejects visits older than the maximum window', () => {
        const tooOld = run('visit_date', '2015-01-01');
        expect(tooOld[0]).toMatchObject({ code: 'DATE_RANGE', detail: { reason: 'too_old' } });
        expect(codes(run('visit_date', ''))).toEqual([]);
    });
});

describe('numeric range validators', () => {
    it('ageRange accepts 0..120 and rejects anything else', () => {
        expect(codes(run('age', 0))).toEqual([]);
        expect(codes(run('age', LIMITS.AGE_MAX))).toEqual([]);
        expect(codes(run('age', LIMITS.AGE_MAX + 1))).toEqual(['AGE_RANGE']);
        expect(codes(run('age', -1))).toEqual(['AGE_RANGE']);
        expect(codes(run('age', Number.NaN))).toEqual(['AGE_RANGE']);
        expect(codes(run('age', ''))).toEqual([]);
    });

    it('childrenRange warns above the expected count and rejects above the max', () => {
        expect(codes(run('children_count', 0))).toEqual([]);
        expect(codes(run('children_count', LIMITS.CHILDREN_WARN_ABOVE))).toEqual([]);
        const high = run('children_count', LIMITS.CHILDREN_WARN_ABOVE + 1);
        expect(high[0]).toMatchObject({ code: 'CHILDREN_RANGE', detail: { reason: 'above_expected' } });
        expect(codes(run('children_count', LIMITS.CHILDREN_MAX + 1))).toEqual(['CHILDREN_RANGE']);
        expect(codes(run('children_count', -1))).toEqual(['CHILDREN_RANGE']);
        expect(codes(run('children_count', ''))).toEqual([]);
    });

    it('priceRange warns above the threshold and rejects negatives', () => {
        expect(codes(run('price', 0))).toEqual([]);
        expect(codes(run('price', LIMITS.PRICE_WARN_ABOVE))).toEqual([]);
        const high = run('price', LIMITS.PRICE_WARN_ABOVE + 1);
        expect(high[0]).toMatchObject({ code: 'PRICE_RANGE', detail: { threshold: LIMITS.PRICE_WARN_ABOVE } });
        expect(codes(run('price', -1))).toEqual(['PRICE_RANGE']);
        expect(codes(run('price', ''))).toEqual([]);
    });
});

describe('length validators', () => {
    it('textLength flags free text above the maximum, bound to its field', () => {
        expect(codes(run('address', 'ط'.repeat(LIMITS.TEXT_MAX_CHARS)))).toEqual([]);
        const long = run('address', 'ط'.repeat(LIMITS.TEXT_MAX_CHARS + 1));
        expect(long[0]).toMatchObject({ code: 'TEXT_TOO_LONG', field: 'address' });
        expect(codes(run('address', ''))).toEqual([]);
    });

    it('notesLimits checks entry count and entry length', () => {
        const entry = 'ملاحظة';
        expect(codes(run('notes', new Array(LIMITS.NOTES_MAX_ENTRIES).fill(entry)))).toEqual([]);
        const many = run('notes', new Array(LIMITS.NOTES_MAX_ENTRIES + 1).fill(entry));
        expect(many[0]).toMatchObject({ code: 'TEXT_TOO_LONG', detail: { count: LIMITS.NOTES_MAX_ENTRIES + 1 } });
        const long = run('notes', ['x'.repeat(LIMITS.NOTES_MAX_CHARS + 1)]);
        expect(long[0]).toMatchObject({ code: 'TEXT_TOO_LONG', detail: { max: LIMITS.NOTES_MAX_CHARS } });
        expect(codes(run('notes', []))).toEqual([]);
        expect(codes(run('notes', 'not-a-list'))).toEqual([]);
    });
});

describe('validateField (dispatcher)', () => {
    it('throws when a registry field points at an unknown validator', () => {
        expect(() => validateField({ key: 'x', validate: ['nope'] }, 'a', {}))
            .toThrow(/nope/);
    });

    it('every registry validator name exists, with no orphans', () => {
        const used = new Set(FIELDS.flatMap((field) => field.validate));
        expect([...VALIDATOR_NAMES].sort()).toEqual([...used].sort());
        for (const name of used) expect(VALIDATORS[name]).toBeTypeOf('function');
    });
});
