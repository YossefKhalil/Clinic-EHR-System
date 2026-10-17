// M3: the "what will be sent" preview — counts, columns, privacy parameters
// and duplicate-hash warnings (spec §5.3).
import { describe, expect, it } from 'vitest';
import { buildPreview } from '../../src/features/import-agent/preview.js';
import { applyColumnSelection } from '../../src/features/import-agent/readers/table.js';

const sheetSource = () => ({
    kind: 'sheet',
    layout: 'rows',
    name: 'patients.xlsx › Patients',
    header: { id: 'R1', cells: ['Name', 'National ID', 'Mobile'], text: 'Name | National ID | Mobile' },
    lines: [
        { id: 'R2', cells: ['Ahmed', '29805151201234', '01012345678'], text: 'Ahmed | 29805151201234 | 01012345678' },
        { id: 'R3', cells: ['Mona', '29903220201567', '01112345678'], text: 'Mona | 29903220201567 | 01112345678' },
    ],
    meta: { file: 'patients.xlsx', sheet: 'Patients' },
    warnings: [],
    stats: { dataRows: 2 },
});

const textSource = () => ({
    kind: 'text',
    layout: 'text',
    name: 'Typed text',
    header: null,
    lines: [
        { id: 'L001', text: 'مريض 1: احمد' },
        { id: 'L002', text: '' },
        { id: 'L003', text: 'مريض 2: منى' },
    ],
    meta: {},
    warnings: [{ code: 'NO_HEADER', params: {} }],
    stats: { lines: 3 },
});

const imageSource = () => ({
    kind: 'image',
    layout: 'image',
    name: 'photo.jpg',
    header: null,
    lines: [],
    meta: {},
    warnings: [{ code: 'IMAGE_READER_NOT_READY', params: {} }],
    stats: { images: 1 },
});

describe('buildPreview', () => {
    const files = () => [
        {
            name: 'patients.xlsx',
            size: 1234,
            kind: 'xlsx',
            sha256: 'a'.repeat(64),
            sources: [sheetSource()],
            warnings: [{ code: 'HIDDEN_SHEETS_SKIPPED', params: { sheets: 'Scratch' } }],
        },
        {
            name: 'notes.txt',
            size: 20,
            kind: 'text',
            sources: [textSource(), imageSource()],
        },
    ];

    it('summarizes every source with the exact characters that would be sent', () => {
        const preview = buildPreview({ files: files(), provider: 'openrouter' });

        expect(preview.files[0].hashWarning).toBeNull();
        expect(preview.files[0].warnings).toEqual([{ code: 'HIDDEN_SHEETS_SKIPPED', params: { sheets: 'Scratch' } }]);

        const [sheet, text, image] = preview.entries;
        expect(sheet).toMatchObject({
            fileIndex: 0,
            sourceId: 'S1',
            kind: 'sheet',
            layout: 'rows',
            rows: 2,
            lines: null,
            images: 0,
        });
        expect(sheet.columns).toEqual({ headers: ['Name', 'National ID', 'Mobile'], width: 3 });
        // Prefixes count: header "S1:R1 | Name | National ID | Mobile" + 2 rows + newlines.
        const expectedChars = ['S1:R1 | Name | National ID | Mobile',
            'S1:R2 | Ahmed | 29805151201234 | 01012345678',
            'S1:R3 | Mona | 29903220201567 | 01112345678',
        ].reduce((sum, line) => sum + line.length + 1, 0);
        expect(sheet.chars).toBe(expectedChars);

        expect(text).toMatchObject({ sourceId: 'S2', layout: 'text', rows: null, lines: 2, images: 0 });
        expect(text.warnings).toEqual([{ code: 'NO_HEADER', params: {} }]);
        expect(text.columns).toBeNull();
        expect(image).toMatchObject({ images: 1, rows: null, lines: 0 });

        expect(preview.totals).toEqual({
            files: 2,
            sources: 3,
            chars: preview.entries.reduce((sum, entry) => sum + entry.chars, 0),
            images: 1,
            rows: 2,
        });
        expect(preview.privacy).toEqual({ provider: 'openrouter', retentionDays: 7 });
    });

    it('reports duplicate hashes with the earlier date', () => {
        const hash = 'b'.repeat(64);
        const preview = buildPreview({
            files: [{ name: 'x.csv', sha256: hash, sources: [textSource()] }],
            seenHashes: new Map([[hash, '2026-10-01T10:00:00Z']]),
        });
        expect(preview.files[0].hashWarning).toEqual({
            code: 'FILE_SEEN_BEFORE',
            params: { date: '2026-10-01' },
        });
    });

    it('shows fewer characters after columns are unchecked', () => {
        const before = buildPreview({ files: [{ name: 'x.xlsx', sources: [sheetSource()] }] });
        const masked = applyColumnSelection(sheetSource(), [true, true, false]);
        const after = buildPreview({ files: [{ name: 'x.xlsx', sources: [masked] }] });
        expect(after.entries[0].chars).toBeLessThan(before.entries[0].chars);
        expect(after.entries[0].columns.headers).toEqual(['Name', 'National ID']);
    });
});
