import { describe, expect, it } from 'vitest';
import { buildPatientPayload, toNullableNumber } from '../../src/services/patient-payload.js';

function form(overrides = {}) {
    return {
        name: 'Mona Ali',
        national_id: '29001011234567',
        mobile: '',
        date_of_birth: '',
        age: '',
        marital_status: '',
        children_count: '',
        governorate: 'Cairo',
        address: '',
        problem: '',
        solution: '',
        visit_date: '',
        price: '',
        follower: '',
        section: '',
        source_of_money: '',
        ...overrides,
    };
}

describe('toNullableNumber', () => {
    it('turns empty values into null and every other value into a number', () => {
        expect(toNullableNumber('')).toBeNull();
        expect(toNullableNumber(null)).toBeNull();
        expect(toNullableNumber(undefined)).toBeNull();
        expect(toNullableNumber('3')).toBe(3);
        expect(toNullableNumber('12.50')).toBe(12.5);
        expect(toNullableNumber(0)).toBe(0);
    });
});

describe('buildPatientPayload', () => {
    it('sends null for unset typed and enum fields', () => {
        const payload = buildPatientPayload(form(), { userId: 'user-1' });

        expect(payload.section).toBeNull();
        expect(payload.source_of_money).toBeNull();
        expect(payload.marital_status).toBeNull();
        expect(payload.age).toBeNull();
        expect(payload.children_count).toBeNull();
        expect(payload.price).toBeNull();
        expect(payload.date_of_birth).toBeNull();
        expect(payload.visit_date).toBeNull();
        expect(payload.user_id).toBe('user-1');
        expect(payload.is_completed).toBe(false);
    });

    it('coerces numeric inputs and trims date values', () => {
        const payload = buildPatientPayload(form({
            age: '42',
            children_count: '3',
            price: '150.25',
            date_of_birth: '1984-05-02T00:00:00Z',
            visit_date: '2026-10-20',
            section: 'agamy',
            source_of_money: 'charity',
            marital_status: 'married',
        }));

        expect(payload.age).toBe(42);
        expect(payload.children_count).toBe(3);
        expect(payload.price).toBe(150.25);
        expect(payload.date_of_birth).toBe('1984-05-02');
        expect(payload.visit_date).toBe('2026-10-20');
        expect(payload.section).toBe('agamy');
        expect(payload.source_of_money).toBe('charity');
        expect(payload.marital_status).toBe('married');
    });

    it('drops blank notes and trims the rest', () => {
        const payload = buildPatientPayload(form(), {
            notes: ['  first note  ', '', '   ', 'second'],
        });

        expect(payload.notes).toEqual(['first note', 'second']);
    });

    it('keeps only the persisted attachment fields', () => {
        const payload = buildPatientPayload(form(), {
            attachments: [{
                public_id: 'clinic-ehr/patients/id/file',
                url: 'https://example.test/file',
                name: 'file.pdf',
                size: 2048,
                mime: 'application/pdf',
                uploaded_at: '2026-10-20T10:00:00Z',
                authenticated: true,
                resource_type: 'raw',
                format: 'pdf',
                uploading: false,
                progress: 100,
                error: null,
            }],
        });

        expect(payload.attachments).toEqual([{
            public_id: 'clinic-ehr/patients/id/file',
            url: 'https://example.test/file',
            name: 'file.pdf',
            size: 2048,
            mime: 'application/pdf',
            uploaded_at: '2026-10-20T10:00:00Z',
            authenticated: true,
            resource_type: 'raw',
            format: 'pdf',
        }]);
    });

    it('keeps the completed flag on an edit and does not reassign the owner', () => {
        const payload = buildPatientPayload(form(), {
            editingPatient: { id: 'patient-1', is_completed: true },
            userId: 'someone-else',
        });

        expect(payload.is_completed).toBe(true);
        expect(payload).not.toHaveProperty('user_id');
    });
});
