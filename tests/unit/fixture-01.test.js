// Fixture integrity checks. These do not run the pipeline (that arrives with
// M1's canned-output test); they make sure the fixture itself is consistent,
// so a broken expectation cannot be mistaken for a pipeline failure later.

import { describe, expect, it } from 'vitest';
import {
    CORRUPTION_VARIANTS,
    ENUM_SNAPSHOT,
    EXPECTED_ROWS,
    FIXTURE_ID,
    JOB_ASSERTIONS,
    LINES,
    RAW_ENUM_HINTS,
} from '../fixtures/golden/fixture-01.js';

function statusFromIssues(issues) {
    if (issues.some((issue) => issue.severity === 'error')) return 'error';
    if (issues.some((issue) => issue.severity === 'warn')) return 'review';
    return 'ready';
}

describe('golden fixture 01', () => {
    it('has a stable id and the 21 source lines of Appendix E', () => {
        expect(FIXTURE_ID).toBe('golden-01');
        expect(LINES).toHaveLength(21);
        expect(new Set(LINES.map((line) => line.id)).size).toBe(21);
        expect(LINES[0].id).toBe('L001');
        expect(LINES.at(-1).id).toBe('L021');
    });

    it('keeps Arabic-Indic digits in the source and only canonicalizes where stated', () => {
        for (const line of LINES) {
            expect(line.text, line.id).toBeTruthy();
            if (line.canonical) {
                expect(line.canonical, line.id).not.toBe(line.text);
                // canonicalization converts digits, never removes characters
                expect(line.canonical.replace(/[0-9٠-٩]/g, '')).toBe(line.text.replace(/[0-9٠-٩]/g, ''));
            }
        }
    });

    it('expects exactly 10 rows and cites only existing lines', () => {
        expect(EXPECTED_ROWS).toHaveLength(JOB_ASSERTIONS.rowCount);
        const ids = new Set(LINES.map((line) => line.id));
        for (const row of EXPECTED_ROWS) {
            expect(row.src.length, `row ${row.index}`).toBeGreaterThan(0);
            for (const ref of row.src) expect(ids.has(ref), `row ${row.index} cites ${ref}`).toBe(true);
        }
    });

    it('derives each row status from its own issues (spec 8.5)', () => {
        for (const row of EXPECTED_ROWS) {
            expect(statusFromIssues(row.issues), `row ${row.index}`).toBe(row.status);
        }
    });

    it('matches the job-level assertions of E.3', () => {
        const errorRows = EXPECTED_ROWS.filter((row) => row.status === 'error').map((row) => row.index);
        expect(errorRows).toEqual(JOB_ASSERTIONS.errorRows);
        expect(EXPECTED_ROWS.filter((row) => row.status !== 'error').map((row) => row.index))
            .toEqual(JOB_ASSERTIONS.importableByDefault);
    });

    it('never cites the clinic announcement line and marks no missed records', () => {
        const cited = new Set(EXPECTED_ROWS.flatMap((row) => row.src));
        for (const line of JOB_ASSERTIONS.ignoredLines) {
            expect(cited.has(line), line).toBe(false);
        }
        expect(JOB_ASSERTIONS.possibleMissedRecordLines).toEqual([]);
    });

    it('flags only row 6 as the in-batch duplicate of row 1', () => {
        expect(JOB_ASSERTIONS.duplicateOf).toEqual({ 6: 1 });
    });

    it('records raw enum hints for the unmatched enum cells', () => {
        for (const [index, hints] of Object.entries(RAW_ENUM_HINTS)) {
            const row = EXPECTED_ROWS.find((r) => r.index === Number(index));
            expect(row, `row ${index}`).toBeTruthy();
            for (const [field, raw] of Object.entries(hints)) {
                expect(raw, `row ${index} ${field}`).toBeTruthy();
                expect(row.cells[field], `row ${index} ${field}`).toBe('');
                expect(
                    row.issues.some((i) => i.code === 'ENUM_UNMATCHED' && i.field === field),
                    `row ${index} ${field}`,
                ).toBe(true);
            }
        }
    });

    it('has option-list snapshots shaped like app_options rows', () => {
        for (const kind of ['follower', 'section', 'sourceOfMoney']) {
            for (const option of ENUM_SNAPSHOT[kind]) {
                expect(option.key, kind).toBeTruthy();
                expect(option.label_en, kind).toBeTruthy();
                expect(option.label_ar, kind).toBeTruthy();
            }
        }
        expect(ENUM_SNAPSHOT.maritalStatus).toEqual(['single', 'married', 'divorced', 'widowed']);
        expect(ENUM_SNAPSHOT.governorate).toHaveLength(27);
    });

    it('keeps the corrupted-digit variant aligned with its source line', () => {
        for (const variant of CORRUPTION_VARIANTS) {
            const line = LINES.find((l) => l.id === variant.sourceLine);
            expect(line, variant.sourceLine).toBeTruthy();
            expect(line.canonical ?? line.text).toContain(variant.sourceValue);
            expect(variant.modelValue).toHaveLength(14);
            expect(variant.modelValue).not.toBe(variant.sourceValue);
        }
    });
});
