// Review-time pipeline inputs (spec 10.10): `_cells` prefills, `ground: false`
// for manual rows, `keepPhantoms` for whatever the reviewer left behind, and
// the promise that pipeline meta keys never leak into the unmapped tray.

import { describe, expect, it } from 'vitest';
import { runPipeline } from '@import-core/pipeline.js';

const TODAY = '2026-10-17';
const LINES = [
    { id: 'S1:L001', text: 'مريض 1: منى حسن علي - 29805151201234 - 01012345678 - متزوج - الدقهلية - طنطا' },
];

function run(records, extra = {}) {
    return runPipeline({
        records,
        sourceId: 'S1',
        kind: 'text',
        lines: LINES,
        chunkLineIds: LINES.map((line) => line.id),
        today: TODAY,
        ...extra,
    });
}

const groundable = {
    _src: 'S1:L001',
    name: 'منى حسن علي',
    national_id: '29805151201234',
    mobile: '01012345678',
    address: 'طنطا',
};

const codes = (row) => row.issues.map((entry) => entry.code);

describe('review-time pipeline inputs', () => {
    it('re-runs a grounded record identically when nothing changed', () => {
        const result = run([{ ...groundable }]);
        expect(result.rejected).toEqual([]);
        expect(result.rows[0].phantom).toBe(false);
    });

    it('applies `_cells` prefills with the user origin and skips grounding', () => {
        const result = run([{
            ...groundable,
            _cells: { mobile: { raw: '0109 999 8888', origin: 'user' } },
        }]);
        const row = result.rows[0];
        expect(row.cells.mobile.value).toBe('01099998888');
        expect(row.cells.mobile.origin).toBe('user');
        // Not in the source, yet no grounding complaint for that field.
        expect(row.issues.filter((entry) => entry.code === 'VALUE_NOT_IN_SOURCE' && entry.field === 'mobile')).toEqual([]);
        expect(row.status).not.toBe('error');
    });

    it('prefills a non-extracted field (section) like any other value', () => {
        const snapshot = { section: [{ key: 'agamy', label_en: 'Agamy', label_ar: 'عجمي' }] };
        const result = run([{
            ...groundable,
            _cells: { section: { raw: 'agamy', origin: 'user' } },
        }], { snapshot });
        expect(result.rows[0].cells.section.value).toBe('agamy');
        expect(result.rows[0].cells.section.origin).toBe('user');
    });

    it('keeps a cleared user cell empty and user-owned', () => {
        const result = run([{
            ...groundable,
            _cells: { address: { raw: '', origin: 'user' } },
        }]);
        const row = result.rows[0];
        expect(row.cells.address.value).toBe('');
        expect(row.cells.address.origin).toBe('user');
    });

    it('defaults fill blank cells with the default origin', () => {
        const result = run([{ ...groundable }], { defaults: { marital_status: 'married' } });
        expect(result.rows[0].cells.marital_status.value).toBe('married');
        expect(result.rows[0].cells.marital_status.origin).toBe('default');
    });

    it('defaults never overwrite what the reviewer decided, even a clear', () => {
        const result = run([{
            ...groundable,
            _cells: { marital_status: { raw: '', origin: 'user' } },
        }], { defaults: { marital_status: 'married' } });
        expect(result.rows[0].cells.marital_status.value).toBe('');
        expect(result.rows[0].cells.marital_status.origin).toBe('user');
    });

    it('rejects a phantom by default but keeps it flagged in review mode', () => {
        const record = { _src: 'S1:L001', name: 'مريض مختلف تماما', national_id: '30001019999999' };
        const strict = run([{ ...record }]);
        expect(strict.rejected).toHaveLength(1);
        expect(strict.rejected[0].reason).toBe('PHANTOM_RECORD');
        expect(strict.rows).toEqual([]);

        const lenient = run([{ ...record }], { keepPhantoms: true });
        expect(lenient.rejected).toEqual([]);
        expect(lenient.rows[0].phantom).toBe(true);
        expect(codes(lenient.rows[0])).toContain('VALUE_NOT_IN_SOURCE');
    });

    it('ground:false makes a manual row source-less but still validated', () => {
        const result = run([{ name: 'مريض يدوي', national_id: '29901011234567' }], { ground: false });
        const row = result.rows[0];
        expect(result.rejected).toEqual([]);
        expect(row.phantom).toBe(false);
        expect(row.srcValid).toBe(true);
        expect(codes(row)).not.toContain('SRC_REF_INVALID');
        expect(codes(row)).not.toContain('VALUE_NOT_IN_SOURCE');
        expect(row.cells.national_id.value).toBe('29901011234567');
    });

    it('never turns pipeline meta keys into unmapped text', () => {
        const result = run([{
            ...groundable,
            _chunkIndex: 3,
            _cells: { mobile: { raw: '01012345678', origin: 'user' } },
            unmapped: ['ملاحظة حرة'],
            stray_key: 'قيمة إضافية',
        }]);
        const row = result.rows[0];
        expect(row.unmapped).toEqual(['ملاحظة حرة', 'stray_key: قيمة إضافية']);
        const entry = row.issues.find((issue) => issue.code === 'UNMAPPED_TEXT');
        expect(entry.detail.entries).toBe(2);
    });
});
