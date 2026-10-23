import { describe, expect, it } from 'vitest';
import {
    emptyPatientFilters,
    activeFilterKeys,
    filterValueIsSet,
    PATIENT_FILTER_KEYS,
    SCOPE_FILTER_KEYS,
} from '../../src/services/patient-filters.js';

describe('emptyPatientFilters', () => {
    it('returns the full filter state, nothing active', () => {
        const keys = Object.keys(emptyPatientFilters());
        expect(keys).toContain('filter_by');
        for (const key of PATIENT_FILTER_KEYS) {
            expect(keys).toContain(key);
        }
        expect(activeFilterKeys(emptyPatientFilters())).toHaveLength(0);
    });

    it('keeps the same keys on every call', () => {
        expect(emptyPatientFilters()).toEqual(emptyPatientFilters());
    });
});

describe('filterValueIsSet', () => {
    it('treats blank, null and undefined as unset', () => {
        expect(filterValueIsSet('')).toBe(false);
        expect(filterValueIsSet('   ')).toBe(false);
        expect(filterValueIsSet(null)).toBe(false);
        expect(filterValueIsSet(undefined)).toBe(false);
    });

    it('treats any real value as set, including falsey strings', () => {
        expect(filterValueIsSet(false)).toBe(true);
        expect(filterValueIsSet(0)).toBe(true);
        expect(filterValueIsSet('false')).toBe(true);
        expect(filterValueIsSet('pending')).toBe(true);
    });
});

describe('activeFilterKeys', () => {
    it('lists every set key in display order', () => {
        const filters = { ...emptyPatientFilters(), date_to: '2026-01-31', search: 'ahmed' };
        expect(activeFilterKeys(filters)).toEqual(['search', 'date_to']);
    });

    it('counts "Pending" (is_completed = "false") as an active filter', () => {
        const filters = { ...emptyPatientFilters(), is_completed: 'false' };
        expect(activeFilterKeys(filters)).toHaveLength(1);
    });

    it('hides the admin-scope keys for section users', () => {
        const filters = {
            ...emptyPatientFilters(),
            search: 'a',
            follower: 'sara',
            section: 'agamy',
            source_of_money: 'cash',
        };
        expect(activeFilterKeys(filters, { admin: false })).toEqual(['search']);
        expect(activeFilterKeys(filters, { admin: true })).toEqual(['search', 'follower', 'section', 'source_of_money']);
        expect(activeFilterKeys(filters)).toEqual(['search', 'follower', 'section', 'source_of_money']);
    });

    it('ignores filters that are null or whitespace only', () => {
        const filters = { ...emptyPatientFilters(), search: '  ', date_from: null };
        expect(activeFilterKeys(filters)).toHaveLength(0);
    });

    it('never reports keys that are not part of the known set', () => {
        const filters = { ...emptyPatientFilters(), rogueField: 'x' };
        expect(activeFilterKeys(filters)).toHaveLength(0);
    });

    it('covers every panel field in SCOPE_FILTER_KEYS', () => {
        for (const key of SCOPE_FILTER_KEYS) {
            expect(PATIENT_FILTER_KEYS).toContain(key);
        }
    });
});
