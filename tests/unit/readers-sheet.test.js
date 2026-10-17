// M3: spreadsheet reader — raw values, header detection, merged headers,
// repeated headers, hidden sheets, the shared row budget and column masking
// (spec §5.4, §6.4, §15).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../../src/features/import-agent/readers/spreadsheet.js';
import { applyColumnSelection, columnCount } from '../../src/features/import-agent/readers/table.js';
import { prepareSources } from '../../src/features/import-agent/chunker.js';

const bytesOf = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/readers/${name}`, import.meta.url)));
const patients = () => readWorkbook(bytesOf('patients.xlsx'), { name: 'patients.xlsx' });
// The sheet holds exactly 500 data rows, so October needs a larger budget.
const patientsWithOctober = () => readWorkbook(bytesOf('patients.xlsx'), { name: 'patients.xlsx', maxRows: 600 });

describe('readWorkbook on patients.xlsx', () => {
    it('reads every visible sheet as its own source', async () => {
        const { sources, warnings } = await patientsWithOctober();
        expect(sources.map((s) => s.name)).toEqual(['patients.xlsx › Patients', 'patients.xlsx › October']);
        expect(warnings).toEqual([{ code: 'HIDDEN_SHEETS_SKIPPED', params: { sheets: 'Scratch' } }]);
        for (const source of sources) {
            expect(source.kind).toBe('sheet');
            expect(source.layout).toBe('rows');
        }
    });

    it('skips further sheets once the shared 500-row budget is used up', async () => {
        const { sources, warnings } = await patients();
        expect(sources.map((s) => s.name)).toEqual(['patients.xlsx › Patients']);
        expect(warnings).toEqual([
            { code: 'HIDDEN_SHEETS_SKIPPED', params: { sheets: 'Scratch' } },
            { code: 'SHEETS_NOT_READ', params: { limit: 500, count: 1 } },
        ]);
    });

    it('propagates merged header cells and keeps the real row ids', async () => {
        const { sources } = await patients();
        const sheet = sources[0];
        expect(sheet.header.id).toBe('R1');
        expect(sheet.header.cells).toEqual([
            'Serial No', 'Name', 'National ID', 'Mobile', 'DOB',
            'Visit Date', 'Governorate', 'Paid', 'Paid',
        ]);
        expect(sheet.lines).toHaveLength(500);
        expect(sheet.lines[0].id).toBe('R2');
        expect(sheet.lines.at(-1).id).toBe('R504');
    });

    it('reads raw values: numbers stringified exactly, dates as YYYY-MM-DD', async () => {
        const { sources } = await patients();
        const first = sources[0].lines[0];
        expect(first.cells).toEqual([
            '1', 'Ahmed Mohamed Ali', '29805151201234', '1012345678',
            '1990-05-15', '2026-10-12', 'Cairo', '300',
        ]);
        expect(first.text).toBe('1 | Ahmed Mohamed Ali | 29805151201234 | 1012345678 | 1990-05-15 | 2026-10-12 | Cairo | 300');
        // A generated row: date cell round-trips through the fixture writer.
        expect(sources[0].lines[1].cells[4]).toBe('1990-01-03');
    });

    it('drops repeated headers, empty rows and serial-only rows without losing data', async () => {
        const { sources } = await patients();
        const sheet = sources[0];
        expect(sheet.stats).toMatchObject({
            headerRow: 1,
            titleRows: 0,
            dataRows: 500,
            repeatedHeaders: 1,
            emptyRows: 1,
            serialRows: 1,
            capped: false,
        });
        // Junk rows occupied excel rows 150–152: the ids jump straight over them.
        const ids = new Set(sheet.lines.map((l) => l.id));
        expect(ids.has('R150')).toBe(false);
        expect(ids.has('R151')).toBe(false);
        expect(ids.has('R152')).toBe(false);
        expect(sheet.lines[147].id).toBe('R149');
        expect(sheet.lines[148].id).toBe('R153');
    });

    it('reads a second sheet with its own header and rows', async () => {
        const { sources } = await patientsWithOctober();
        const october = sources[1];
        expect(october.header.cells).toEqual(['Name', 'National ID', 'Mobile']);
        expect(october.lines.map((l) => l.id)).toEqual(['R2', 'R3']);
        expect(october.lines[0].cells).toEqual(['منى حسن على', '29903220201567', '01112345678']);
    });

    it('reads hidden sheets only when asked', async () => {
        const { sources, warnings } = await readWorkbook(bytesOf('patients.xlsx'), {
            name: 'patients.xlsx',
            maxRows: 600,
            includeHiddenSheets: ['Scratch'],
        });
        expect(warnings).toEqual([]);
        expect(sources.map((s) => s.name)).toEqual([
            'patients.xlsx › Patients',
            'patients.xlsx › October',
            'patients.xlsx › Scratch',
        ]);
        expect(sources[2].meta.hidden).toBe(true);
        expect(sources[2].lines[0].cells).toEqual(['Hidden Person', '29001010101010', '01098765432']);
    });

    it('stops at the shared row budget and says what was skipped', async () => {
        const { sources, warnings } = await readWorkbook(bytesOf('patients.xlsx'), {
            name: 'patients.xlsx',
            maxRows: 10,
        });
        expect(sources).toHaveLength(1);
        expect(sources[0].lines).toHaveLength(10);
        expect(sources[0].stats.capped).toBe(true);
        expect(sources[0].warnings).toEqual([{ code: 'ROW_BUDGET', params: { limit: 10 } }]);
        expect(warnings).toContainEqual({ code: 'SHEETS_NOT_READ', params: { limit: 10, count: 1 } });
    });
});

describe('column selection for the preview (spec §5.3)', () => {
    it('removes unchecked columns from what will be sent', async () => {
        const { sources } = await patients();
        const sheet = sources[0];
        expect(columnCount(sheet)).toBe(9);
        const selected = [true, true, true, false, true, true, true, true, true];
        const masked = applyColumnSelection(sheet, selected);
        expect(masked.header.cells).toEqual([
            'Serial No', 'Name', 'National ID', 'DOB',
            'Visit Date', 'Governorate', 'Paid', 'Paid',
        ]);
        expect(masked.lines[0].cells).toEqual([
            '1', 'Ahmed Mohamed Ali', '29805151201234',
            '1990-05-15', '2026-10-12', 'Cairo', '300',
        ]);
        expect(masked.lines[0].text).not.toContain('1012345678');
    });

    it('leaves text sources untouched', () => {
        const source = { kind: 'text', layout: 'text', lines: [{ id: 'L001', text: 'x' }] };
        expect(applyColumnSelection(source, [false])).toBe(source);
    });
});

describe('the 500-row sheet chunks correctly (M3 exit criterion)', () => {
    it('produces 15-row sheet chunks with the header repeated', async () => {
        const { sources } = await patients();
        const { chunks, warnings, stats } = prepareSources(sources);

        // 500 rows / 15 = 33 full chunks plus one of 5 rows.
        expect(chunks).toHaveLength(34);
        expect(warnings).toEqual([]);
        expect(stats).toMatchObject({ chunks: 34, sources: 1, rows: 500 });

        const first = chunks[0];
        expect(first).toMatchObject({
            chunk_id: 'c1',
            source_id: 'S1',
            kind: 'sheet',
            boundary_uncertain: false,
            image_ref: null,
        });
        expect(first.header).toBe('S1:R1 | Serial No | Name | National ID | Mobile | DOB | Visit Date | Governorate | Paid | Paid');
        expect(first.lines).toHaveLength(15);
        expect(first.lines[0]).toEqual({
            id: 'S1:R2',
            text: 'S1:R2 | 1 | Ahmed Mohamed Ali | 29805151201234 | 1012345678 | 1990-05-15 | 2026-10-12 | Cairo | 300',
        });

        // Last chunk of the sheet holds the remaining 5 rows.
        const last = chunks[33];
        expect(last.lines).toHaveLength(5);
        expect(last.lines.at(-1).id).toBe('S1:R504');
    });

    it('adds the second sheet as one more chunk when the budget allows', async () => {
        const { sources } = await patientsWithOctober();
        const { chunks, stats } = prepareSources(sources);
        expect(chunks).toHaveLength(35);
        expect(stats).toMatchObject({ chunks: 35, sources: 2, rows: 502 });
        expect(chunks[34].source_id).toBe('S2');
        expect(chunks[34].header).toBe('S2:R1 | Name | National ID | Mobile');
        expect(chunks[34].lines.map((l) => l.id)).toEqual(['S2:R2', 'S2:R3']);
    });
});
