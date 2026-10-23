import { describe, expect, it } from 'vitest';
import { buildExportTable } from '../../src/services/export-format.js';
import { EXPORT_FIELD_KEYS } from '../../src/services/export-fields.js';

const patient = {
    name: 'Ahmed Mohamed',
    national_id: '30101010101010',
    mobile: '01000000000',
    governorate: 'Cairo',
    age: 25,
    marital_status: 'married',
    children_count: 2,
    address: 'Some street',
    problem: 'Knee pain',
    solution: 'Physiotherapy',
    follower: 'hassan_hamam',
    section: 'agamy',
    source_of_money: 'charity',
    price: 150,
    visit_date: '2024-03-01',
    created_at: '2024-02-20T10:00:00Z',
    is_completed: true,
    notes: ['First note', '', 'Second note'],
};

describe('Excel export table', () => {
    it('writes every column in Arabic by default', () => {
        const table = buildExportTable({ rows: [patient] });

        expect(table.language).toBe('ar');
        expect(table.sheetName).toBe('المرضى');
        expect(table.columns.map((column) => column.key)).toEqual(EXPORT_FIELD_KEYS);
        expect(table.headers).toHaveLength(EXPORT_FIELD_KEYS.length);
        expect(table.headers).toContain('اسم المريض');
        // The currency of the price column is translated too.
        expect(table.headers).toContain('السعر (ج.م)');
    });

    it('translates the stored values, not only the headers', () => {
        const [row] = buildExportTable({ rows: [patient] }).body;

        expect(row).toContain('القاهرة');
        expect(row).toContain('متزوج');
        expect(row).toContain('مكتمل');
        expect(row).toContain('First note\nSecond note');
        // Arabic dates use Arabic digits, not the raw ISO day.
        expect(row).not.toContain('2024-03-01');
    });

    it('writes English when English is asked for', () => {
        const table = buildExportTable({ rows: [patient], language: 'en' });
        const [row] = table.body;

        expect(table.sheetName).toBe('Patients');
        expect(table.headers[0]).toBe('Patient Name');
        expect(row).toContain('Cairo');
        expect(row).toContain('Married');
        expect(row).toContain('Completed');
        expect(row).toContain('01 Mar 2024');
    });

    it('keeps the chosen columns in registry order, whatever order they arrive in', () => {
        const table = buildExportTable({
            rows: [patient],
            fields: ['price', 'name'],
            language: 'en',
        });

        expect(table.headers).toEqual(['Patient Name', 'Price (EGP)']);
        expect(table.body[0]).toEqual(['Ahmed Mohamed', 150]);
    });

    it('ignores keys that are not exportable columns', () => {
        const table = buildExportTable({ rows: [patient], fields: ['name', 'nope'], language: 'en' });
        expect(table.headers).toEqual(['Patient Name']);
    });

    it('refuses an export with no columns', () => {
        expect(() => buildExportTable({ rows: [patient], fields: [] })).toThrow('اختر عمودًا واحدًا على الأقل.');
        expect(() => buildExportTable({ rows: [patient], fields: [], language: 'en' })).toThrow('Choose at least one field.');
    });

    it('renders empty values as empty cells, never as undefined', () => {
        const table = buildExportTable({ rows: [{ name: 'Bare' }] });
        expect(table.body[0]).not.toContain(undefined);
        expect(table.body[0]).toContain('');
    });
});
