// Deterministic mock review data for the visual preview route.
//
// The import review screen can only be reached with a live extraction job, so
// nobody can eyeball a UI change without running a real import (and a real
// provider). `?mock=review` seeds this data instead: no network calls, no
// auth, no patient data - just the same component, the same rules engine and
// the same markup the production screen uses.
//
// The rows mirror what the edge function actually stores (see
// `import-core/dedupe.js`: a duplicate row carries `dup.action = 'skip'` until
// the reviewer decides), so the preview shows the real statuses and counts.

const TODAY = '2026-10-20';

function cell(value, origin = 'extracted', raw = value) {
    return { value, raw, origin };
}

function row({ id, seq, cells, issues = [], dup = null, removed = false }) {
    const status = issues.some((issue) => issue.severity === 'error')
        ? 'error'
        : issues.length > 0
            ? 'review'
            : 'ready';
    return {
        id,
        seq,
        chunk_id: 'chunk-1',
        source_id: 'source-1',
        version: 1,
        src: ['line-1'],
        cells: Object.fromEntries(Object.entries(cells).map(([key, value]) => [
            key,
            typeof value === 'object' && value !== null && 'value' in value
                ? value
                : cell(value),
        ])),
        issues,
        acknowledged: [],
        dup,
        removed,
        collapsed: false,
        status,
    };
}

export function buildMockReviewState() {
    const rows = [
        row({
            id: 'row-1',
            seq: 1,
            cells: {
                name: 'Fatma Ibrahim Ali',
                national_id: '28811220501187',
                mobile: cell('0112 street 9, camp Caesar', 'snapped'),
                date_of_birth: '1988-11-05',
                age: cell(37, 'derived'),
                marital_status: 'married',
                children_count: 2,
                governorate: 'Alexandria',
                address: 'Camp Caesar, street 9, building 4, Alexandria',
                problem: 'Recurring headache and dizziness for two weeks.',
                solution: 'Tension headache, magnesium supplement, follow-up in two weeks.',
                visit_date: '2026-10-02',
                price: 150,
                follower: 'Nour',
                section: 'Agamy',
                source_of_money: 'cash',
                notes: ['Allergic to penicillin', 'Prefers evening appointments'],
            },
            issues: [{
                code: 'MOBILE_FORMAT',
                severity: 'warn',
                field: 'mobile',
                detail: { reason: 'not_mobile' },
            }],
        }),
        row({
            id: 'row-2',
            seq: 2,
            cells: {
                name: 'Mona Mahmoud Saleh',
                national_id: '29104011204567',
                mobile: '01098765432',
                date_of_birth: '1991-04-01',
                age: cell(35, 'derived'),
                marital_status: 'single',
                children_count: 0,
                governorate: 'Alexandria',
                address: 'Agamy, Alexandria',
                problem: 'Routine check-up',
                solution: 'No treatment needed.',
                visit_date: '2026-10-12',
                price: 100,
                follower: 'Dr. Hala',
                section: 'Agamy',
                source_of_money: 'cash',
                notes: [],
            },
        }),
        row({
            id: 'row-3',
            seq: 3,
            cells: {
                name: 'Ahmed Samir Hassan',
                national_id: '29511150102345',
                mobile: '01234567890',
                date_of_birth: '1995-11-15',
                age: cell(30, 'derived'),
                marital_status: 'married',
                children_count: 1,
                governorate: 'Cairo',
                address: 'Cairo',
                problem: 'Follow-up',
                solution: 'Continue plan.',
                visit_date: '2026-10-05',
                price: 120,
                follower: '',
                section: 'Dekhila',
                source_of_money: 'insurance',
                notes: [],
            },
            dup: { kind: 'in_batch', action: 'skip', duplicateOf: 2 },
            issues: [{
                code: 'DUP_IN_BATCH',
                severity: 'warn',
                field: 'national_id',
                detail: { duplicateOf: 2 },
            }],
        }),
        row({
            id: 'row-4',
            seq: 4,
            cells: {
                name: 'Youssef Karim',
                national_id: '3010',
                mobile: '01055566677',
                date_of_birth: '2001-01-01',
                age: cell(25, 'derived'),
                marital_status: 'single',
                children_count: 0,
                governorate: 'Giza',
                address: 'Giza',
                problem: 'Headache',
                solution: 'Observation.',
                visit_date: '2026-09-28',
                price: 90,
                follower: '',
                section: 'Dekhila',
                source_of_money: 'cash',
                notes: [],
            },
            issues: [{
                code: 'NID_LENGTH',
                severity: 'error',
                field: 'national_id',
                detail: { expected: 14, actual: 4 },
            }],
        }),
        row({
            id: 'row-5',
            seq: 5,
            cells: {
                name: 'Salma Hassan Mostafa',
                national_id: '29308051203987',
                mobile: '01122334455',
                date_of_birth: '1993-08-05',
                age: cell(33, 'derived'),
                marital_status: 'married',
                children_count: 3,
                governorate: 'Alexandria',
                address: 'Smouha, Alexandria',
                problem: 'Back pain',
                solution: 'Physiotherapy, twice a week.',
                visit_date: '2026-10-15',
                price: 200,
                follower: 'Dr. Hala',
                section: 'Agamy',
                source_of_money: 'insurance',
                notes: [],
            },
        }),
        row({
            id: 'row-6',
            seq: 6,
            cells: {
                name: 'Karim Adel Fouad',
                national_id: '29002251108745',
                mobile: '01099887766',
                date_of_birth: '1990-02-25',
                age: cell(36, 'derived'),
                marital_status: 'married',
                children_count: 1,
                governorate: 'Cairo',
                address: 'Nasr City, Cairo',
                problem: 'Check-up',
                solution: 'Nothing to report.',
                visit_date: '2026-10-11',
                price: 150,
                follower: 'Nour',
                section: 'Dekhila',
                source_of_money: 'cash',
                notes: [],
            },
            removed: true,
        }),
    ];

    return {
        rows,
        chunksById: new Map([['chunk-1', {
            id: 'chunk-1',
            idx: 1,
            payload: {
                kind: 'text',
                lines: [
                    { id: 'line-1', text: 'Fatma Ibrahim Ali 28811220501187 0112 street 9 camp Caesar 02/10/2026' },
                    { id: 'line-2', text: 'Mona Mahmoud Saleh 29104011204567 01098765432 12/10/2026' },
                    { id: 'line-3', text: 'Ahmed Samir Hassan 29511150102345 01234567890 05/10/2026' },
                    { id: 'line-4', text: 'Youssef Karim 3010 01055566677 28/09/2026' },
                    { id: 'line-5', text: 'Salma Hassan Mostafa 29308051203987 01122334455 15/10/2026' },
                ],
            },
        }]]),
        config: { enum_snapshot: {} },
        defaults: {},
        today: TODAY,
        existing: new Map(),
        nameDobMatches: new Set(),
    };
}

/** Seed the wizard component with the mock job, sources and review state. */
export function seedMockReview(wizard) {
    if (!wizard) return;
    wizard.step = 'review';
    wizard.busy = false;
    wizard.busyLabel = '';
    wizard.job = { id: 'mock-job', status: 'review', config: {} };
    wizard.sources = [{ id: 'source-1', name: 'notes-scan.pdf' }];
    wizard.chunks = [{ id: 'chunk-1', idx: 1 }];
    wizard.rejects = [{
        id: 'reject-1',
        chunk_id: 'chunk-1',
        reason: 'UNMAPPED',
        raw: 'street 9, camp Caesar, 0112 street 9',
        src: { seq: 1 },
    }];
    wizard.banners = [];
    wizard.saveState = 'saved';
    wizard.reviewMode = 'simple';
    wizard.filter = 'all';
    wizard.selected = [];
    wizard.expandedRowId = 'row-1';
    wizard.nextIssueIndex = 0;
    wizard.sectionPicker = '';
    wizard.reviewState = buildMockReviewState();
}
