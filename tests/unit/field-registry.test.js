import { describe, expect, it } from 'vitest';
import {
    BULK_FILL_FIELDS,
    EXTRACT_FIELDS,
    EXTRACT_OUTPUT_KEYS,
    FIELDS,
    FIELD_KEYS,
    GRID_COLUMN_KEYS,
    META_KEYS,
    fieldByColumn,
    fieldByKey,
} from '@import-core/field-registry.js';

const CONTROLS = ['text', 'date', 'number', 'select', 'textarea', 'notes'];
const TYPES = ['text', 'date', 'integer', 'number', 'enum', 'list'];

describe('field registry', () => {
    it('covers the 17 importable patients columns in form order', () => {
        expect(FIELD_KEYS).toEqual([
            'name', 'national_id', 'mobile', 'date_of_birth', 'age',
            'marital_status', 'children_count', 'governorate', 'address',
            'problem', 'solution', 'visit_date', 'price', 'follower',
            'section', 'source_of_money', 'notes',
        ]);
    });

    it('uses the column name as the key (decision D15)', () => {
        for (const field of FIELDS) {
            expect(field.key).toBe(field.column);
        }
    });

    it('has unique keys and columns', () => {
        expect(new Set(FIELD_KEYS).size).toBe(FIELDS.length);
        expect(new Set(FIELDS.map((f) => f.column)).size).toBe(FIELDS.length);
    });

    it('labels every field in both languages', () => {
        for (const field of FIELDS) {
            expect(field.label.en, field.key).toBeTruthy();
            expect(field.label.ar, field.key).toBeTruthy();
        }
    });

    it('uses known controls and types', () => {
        for (const field of FIELDS) {
            expect(CONTROLS, field.key).toContain(field.control);
            expect(TYPES, field.key).toContain(field.type);
            expect(field.normalize, field.key).toBeTruthy();
            expect(Array.isArray(field.validate), field.key).toBe(true);
        }
    });

    it('never extracts the section (decision D9)', () => {
        expect(FIELDS.filter((f) => !f.extract).map((f) => f.key)).toEqual(['section']);
        expect(EXTRACT_FIELDS.map((f) => f.key)).not.toContain('section');
        expect(EXTRACT_OUTPUT_KEYS).not.toContain('section');
    });

    it('lists extracted fields followed by the meta keys', () => {
        expect(EXTRACT_OUTPUT_KEYS).toEqual([...EXTRACT_FIELDS.map((f) => f.key), ...META_KEYS]);
        expect(META_KEYS).toEqual(['unmapped', '_uncertain', '_src']);
    });

    it('gives every extracted field an llm hint and section none', () => {
        for (const field of FIELDS) {
            if (field.extract) expect(field.llmHint, field.key).toBeTruthy();
        }
        expect(fieldByKey('section').llmHint).toBeNull();
    });

    it('marks required fields exactly: name, national_id (form) and section (at save)', () => {
        expect(FIELDS.filter((f) => f.required).map((f) => f.key)).toEqual(['name', 'national_id', 'section']);
    });

    it('offers exactly the bulk-fill fields of spec 8.7', () => {
        expect(BULK_FILL_FIELDS.map((f) => f.key)).toEqual([
            'marital_status', 'children_count', 'governorate', 'visit_date',
            'price', 'follower', 'section', 'source_of_money',
        ]);
    });

    it('snaps digits only for national_id and mobile', () => {
        const snapping = FIELDS.filter((f) => f.snapToSource).map((f) => f.key);
        expect(snapping).toEqual(['national_id', 'mobile']);
        expect(fieldByKey('national_id').snapToSource.maxEditDistance).toBe(2);
        expect(fieldByKey('mobile').snapToSource.maxEditDistance).toBe(1);
    });

    it('resolves fields by key and column', () => {
        expect(fieldByColumn('solution').label.en).toBe('Diagnosis & Treatment Plan');
        expect(fieldByKey('date_of_birth').column).toBe('date_of_birth');
        expect(fieldByKey('nope')).toBeNull();
    });

    it('puts status first in the grid columns', () => {
        expect(GRID_COLUMN_KEYS[0]).toBe('status');
        expect(GRID_COLUMN_KEYS.slice(1)).toEqual(FIELD_KEYS);
    });
});
