// M1 golden test: the rules engine against the canned "good model" output of
// fixture #1 (spec Appendix E). No LLM, no clock — FIXTURE_TODAY is fixed.
//
// Assertion policy (decision M1): error/warn codes must match the fixture
// EXACTLY (so an unexpected warning cannot slip through); info codes must be a
// SUBSET of what the pipeline produces (the spec's E.2 table lists only some
// of the info flags, e.g. it predates AGE_DERIVED).

import { describe, expect, it } from 'vitest';
import { runPipeline } from '@import-core/pipeline.js';
import { FIELDS } from '@import-core/field-registry.js';
import { parseSrcRefs } from '@import-core/verify.js';

import {
    CORRUPTION_VARIANTS,
    ENUM_SNAPSHOT,
    EXPECTED_ROWS,
    FIXTURE_TODAY,
    JOB_ASSERTIONS,
    LINES,
    RAW_ENUM_HINTS,
} from '../fixtures/golden/fixture-01.js';
import { CANNED_RECORDS } from '../fixtures/golden/fixture-01-canned.js';

const SOURCE_ID = 'S1';

function pooledLines() {
    return LINES.map((line) => ({
        id: `${SOURCE_ID}:${line.id}`,
        text: line.text,
        canonical: line.canonical,
    }));
}

function run(records = CANNED_RECORDS) {
    return runPipeline({
        records,
        sourceId: SOURCE_ID,
        kind: 'text',
        lines: pooledLines(),
        snapshot: ENUM_SNAPSHOT,
        today: FIXTURE_TODAY,
    });
}

/** Stable comparison form of an issue (the fixture lists code/field/severity). */
const issueKey = (entry) => `${entry.code}|${entry.field ?? ''}|${entry.severity}`;

/** Compare values as text: the fixture stores the display form (`'300'`). */
function cellText(value) {
    if (Array.isArray(value)) return value.join(' | ');
    return String(value ?? '');
}

function sorted(values) {
    return [...values].sort();
}

describe('golden fixture 01 through the pipeline (canned output)', () => {
    const result = run();

    it('produces exactly 10 rows, rejects none, and never misses a record', () => {
        expect(result.rows).toHaveLength(JOB_ASSERTIONS.rowCount);
        expect(result.rejected).toEqual([]);
        expect(result.counts.rows).toBe(JOB_ASSERTIONS.rowCount);
        expect(result.issues).toEqual([]); // no ROW_MISSING / POSSIBLE_MISSED_RECORD
        expect(JOB_ASSERTIONS.ignoredLines).toEqual(['L010']);
        expect(JOB_ASSERTIONS.possibleMissedRecordLines).toEqual([]);
    });

    it('resolves every citation to real source lines', () => {
        for (const row of result.rows) {
            expect(row.srcValid, `row ${row.index}`).toBe(true);
            expect(row.src.length, `row ${row.index}`).toBeGreaterThan(0);
        }
    });

    it('matches statuses, error/warn codes, values and origins row by row', () => {
        for (const expected of EXPECTED_ROWS) {
            const row = result.rows.find((entry) => entry.index === expected.index);
            const label = `row ${expected.index}`;
            expect(row, label).toBeTruthy();

            expect(row.status, `${label} status`).toBe(expected.status);

            // Errors and warnings: exact match with the fixture.
            const actualErrorWarn = sorted(
                row.issues.filter((entry) => entry.severity !== 'info').map(issueKey),
            );
            const wantedErrorWarn = sorted(
                expected.issues.filter((entry) => entry.severity !== 'info').map(issueKey),
            );
            expect(actualErrorWarn, `${label} error/warn codes`).toEqual(wantedErrorWarn);

            // Info: expected must all be produced; extras are allowed.
            for (const info of expected.issues.filter((entry) => entry.severity === 'info')) {
                expect(row.issues.map(issueKey), `${label} info ${info.code}`)
                    .toContain(issueKey(info));
            }

            // Normalized values.
            for (const [key, want] of Object.entries(expected.cells)) {
                expect(cellText(row.cells[key].value), `${label} ${key}`).toBe(cellText(want));
            }

            // Origins: exactly the fixture's derived cells carry `derived`.
            for (const key of expected.derived) {
                expect(row.cells[key].origin, `${label} ${key} origin`).toBe('derived');
            }
            const derivedKeys = sorted(
                FIELDS.map((field) => field.key).filter((key) => row.cells[key].origin === 'derived'),
            );
            expect(derivedKeys, `${label} derived set`).toEqual(sorted(expected.derived));
        }
    });

    it('keeps the unmatched enum raw texts as issue hints (§8.3 step 4)', () => {
        for (const [index, hints] of Object.entries(RAW_ENUM_HINTS)) {
            const row = result.rows.find((entry) => entry.index === Number(index));
            for (const [field, raw] of Object.entries(hints)) {
                const entry = row.issues.find((issue) => issue.code === 'ENUM_UNMATCHED' && issue.field === field);
                expect(entry, `row ${index} ${field}`).toBeTruthy();
                expect(entry.detail.raw, `row ${index} ${field} raw hint`).toBe(raw);
                expect(cellText(row.cells[field].value), `row ${index} ${field} cell`).toBe('');
            }
        }
    });

    it('matches the E.3 row sets: errors [2,4,5,6,8,10], importable [1,3,7,9]', () => {
        const errorRows = result.rows.filter((row) => row.status === 'error').map((row) => row.index);
        expect(errorRows).toEqual(JOB_ASSERTIONS.errorRows);
        const importable = result.rows
            .filter((row) => row.status !== 'error' && !row.collapsed)
            .map((row) => row.index);
        expect(importable).toEqual(JOB_ASSERTIONS.importableByDefault);
    });

    it('flags row 6 as the in-batch duplicate of row 1', () => {
        const row1 = result.rows.find((row) => row.index === 1);
        const row6 = result.rows.find((row) => row.index === 6);
        expect(row1.dup).toBeNull();
        expect(row6.dup).toMatchObject({ kind: 'in_batch', action: 'skip', duplicateOf: 1 });
        expect(row6.issues.some((issue) => issue.code === 'DUP_IN_BATCH')).toBe(true);
        expect(JOB_ASSERTIONS.duplicateOf).toEqual({ 6: 1 });
    });

    it('never invents sub-values: no visit year for L003, no date for L021', () => {
        const row2 = result.rows.find((row) => row.index === 2);
        expect(cellText(row2.cells.visit_date.value)).toBe('');
        expect(row2.issues.some((issue) => issue.code === 'DATE_NO_YEAR')).toBe(true);

        const row10 = result.rows.find((row) => row.index === 10);
        expect(cellText(row10.cells.visit_date.value)).toBe('');
        expect(row10.issues.some((issue) => issue.code === 'DATE_RELATIVE')).toBe(true);

        expect(JOB_ASSERTIONS.inventedDateLines).toEqual([]);
    });

    it('R-01: a corrupted 14-digit ID ends as the source value or blank with an error', () => {
        const variant = CORRUPTION_VARIANTS[0];
        const citedLine = `${SOURCE_ID}:${variant.sourceLine}`;
        const records = CANNED_RECORDS.map((record) => (
            record.national_id === variant.sourceValue
                && parseSrcRefs(record._src, SOURCE_ID).includes(citedLine)
                ? { ...record, national_id: variant.modelValue }
                : record
        ));
        const corrupted = run(records);
        const row = corrupted.rows.find((entry) => entry.index === 3);
        const cell = row.cells.national_id;
        const snapped = row.issues.find((issue) => issue.code === 'SNAPPED_TO_SOURCE' && issue.field === 'national_id');
        const blanked = row.issues.find(
            (issue) => issue.code === 'VALUE_NOT_IN_SOURCE' && issue.field === 'national_id' && issue.severity === 'error',
        );
        expect(snapped || blanked, 'never silently accepted').toBeTruthy();
        if (snapped) {
            expect(cellText(cell.value)).toBe(variant.sourceValue);
            expect(cell.origin).toBe('snapped');
            expect(cellText(row.cells.date_of_birth.value)).toBe('1999-03-22');
        } else {
            expect(cellText(cell.value)).toBe('');
        }
        // The other rows are untouched by the variant.
        expect(cellText(corrupted.rows.find((entry) => entry.index === 1).cells.national_id.value))
            .toBe('29805151201234');
    });

    it('is deterministic and idempotent across runs', () => {
        const again = run();
        expect(JSON.stringify(again.rows)).toBe(JSON.stringify(result.rows));
    });
});
