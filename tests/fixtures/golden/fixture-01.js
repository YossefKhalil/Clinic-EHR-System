// Golden fixture #1 — Appendix E of the design spec (synthetic data only).
//
// This fixture is the contract the rules engine (M1) and the extraction
// pipeline (M4) are tested against, first with canned model output (no LLM),
// later against the real model in the eval runner.
//
// Conventions:
//   - Line ids are local (`L001`); the pooled id is `S1:L001`.
//   - `text` is the source exactly as typed. Arabic-Indic digits are part of
//     the source; `canonical` is only present when canonicalization changes
//     the line (spec §5.5 converts digits in code, never in the LLM).
//   - Expected values are the NORMALIZED cell values. `derived` lists cells
//     whose origin must be `derived` (never mistaken for source values).
//   - `issues` lists every issue code expected, with severity. Info-level
//     codes never change the row status.
//   - Follower and Source of Money expectations assume the app's seeded
//     option lists (below), which do not contain the fixture's raw texts.

export const FIXTURE_ID = 'golden-01';
export const FIXTURE_TITLE = 'Appendix E — synthetic mixed Arabic/English typed list';

export const SOURCE = {
    id: 'S1',
    kind: 'text',
    name: 'Typed text',
};

// Sources of truth for enum matching during the fixture run: the app's seeded
// app_options rows (supabase/schema.sql) plus the marital/governorate lists.
export const ENUM_SNAPSHOT = {
    maritalStatus: ['single', 'married', 'divorced', 'widowed'],
    governorate: [
        'Cairo', 'Giza', 'Alexandria', 'Dakahlia', 'Red Sea', 'Beheira', 'Faiyum',
        'Gharbia', 'Ismailia', 'Monufia', 'Minya', 'Qalyubia', 'New Valley', 'Suez',
        'Aswan', 'Asyut', 'Beni Suef', 'Port Said', 'Damietta', 'South Sinai',
        'North Sinai', 'Sharqia', 'Kafr El Sheikh', 'Qena', 'Luxor', 'Sohag', 'Matrouh',
    ],
    follower: [
        { key: 'hassan_hamam', label_en: 'Hassan Hamam', label_ar: 'حسن حمام' },
        { key: 'abdel_rahman_ahmed', label_en: 'Abdel Rahman Ahmed', label_ar: 'عبد الرحمن أحمد' },
        { key: 'ahmed_saad', label_en: 'Ahmed Saad', label_ar: 'احمد سعد' },
        { key: 'mohamed_ali', label_en: 'Mohamed Ali', label_ar: 'محمد علي' },
        { key: 'mohamed_ahmed', label_en: 'Mohamed Ahmed', label_ar: 'محمد أحمد' },
        { key: 'hazem', label_en: 'Hazem', label_ar: 'حازم' },
        { key: 'mohamed_rabie', label_en: 'Mohamed Rabie', label_ar: 'محمد رابي' },
    ],
    section: [
        { key: 'agamy', label_en: 'Agamy', label_ar: 'العجمي' },
        { key: 'dekhila', label_en: 'Dekhila', label_ar: 'الدخيلة' },
    ],
    sourceOfMoney: [
        { key: 'charity', label_en: 'Charity', label_ar: 'الجمعية الخيرية' },
        { key: 'country', label_en: 'Country', label_ar: 'الدولة' },
    ],
};

// ---------------------------------------------------------------------------
// Source lines
// ---------------------------------------------------------------------------

export const LINES = [
    { id: 'L001', text: 'مريض 1: احمد محمود السيد - 29805151201234 - 01012345678 - متزوج - الدقهلية - كشف 12/10/2026 - 300 ج' },
    { id: 'L002', text: 'Mona Hassan Ali, phone +20 111 234 5678, born 3/4/1985, single' },
    { id: 'L003', text: 'visit: 14 Oct. paid 250. dr amr follow up' },
    { id: 'L004', text: 'سارة عبد الرحمن' },
    { id: 'L005', text: '٢٩٩٠٣٢٢٠٢٠١٥٦٧', canonical: '29903220201567' },
    { id: 'L006', text: '٠١٢٢٣٣٤٤٥٥٦', canonical: '01223344556' },
    { id: 'L007', text: 'مطلقة / الاسكندرية' },
    { id: 'L008', text: 'ملاحظات: حساسية من البنسلين' },
    { id: 'L009', text: 'khaled ibrahim | 1012345679 | ID 3050101010101 | Giza | source: insurance' },
    { id: 'L010', text: '---- العيادة مغلقة الجمعة القادمة ----' },
    { id: 'L011', text: 'محمد علي حسن, O1512345670, ولد 1975-11-30, ارمل, القاهرة' },
    { id: 'L012', text: 'ملاحظات: سكر + ضغط .. متابعة كل شهر' },
    { id: 'L013', text: 'احمد محمود السيد +201012345678 متجوز 29805151201234 (تاني زيارة)' },
    { id: 'L014', text: 'Nour El-Din   28512230101234   DOB 23-12-85   Cairo' },
    { id: 'L015', text: 'allergic to aspirin ??' },
    { id: 'L016', text: 'price: ٤٠٠', canonical: 'price: 400' },
    { id: 'L017', text: 'ياسمين فتحي — ٠١٠٩٨٧٦٥٤٣٢١ — 15 مارس ٢٠٠٢ — عزباء — طنطا', canonical: 'ياسمين فتحي — 010987654321 — 15 مارس 2002 — عزباء — طنطا' },
    { id: 'L018', text: 'Omar S. 30106150301987 01234 56789' },
    { id: 'L019', text: 'Port Said, follow-up Dr. Hala' },
    { id: 'L020', text: 'ام كريم (باقي الاسم مش معايا) 0111-222-3344' },
    { id: 'L021', text: 'كشف امبارح - مصروفات ٣٥٠ جنيه - المتابعة د. هالة', canonical: 'كشف امبارح - مصروفات 350 جنيه - المتابعة د. هالة' },
];

// ---------------------------------------------------------------------------
// Expected extraction + verification results (spec §E.2)
// ---------------------------------------------------------------------------

const EMPTY_ROW = {
    name: '', national_id: '', mobile: '', date_of_birth: '', age: '',
    marital_status: '', children_count: '', governorate: '', address: '',
    problem: '', solution: '', visit_date: '', price: '', follower: '',
    source_of_money: '', notes: [],
};

function expectRow(index, src, cells, issues, status, extra = {}) {
    return {
        index,
        src,
        cells: { ...EMPTY_ROW, ...cells },
        issues,
        status,
        derived: extra.derived || [],
        unmapped: extra.unmapped || [],
    };
}

export const EXPECTED_ROWS = [
    // 1 — clean ID row; visit date 12/10 is day-first ambiguous; DOB derived from ID.
    expectRow(1, ['L001'], {
        name: 'احمد محمود السيد',
        national_id: '29805151201234',
        mobile: '01012345678',
        date_of_birth: '1998-05-15',
        marital_status: 'married',
        governorate: 'Dakahlia',
        visit_date: '2026-10-12',
        price: '300',
    }, [
        { code: 'DATE_AMBIGUOUS', field: 'visit_date', severity: 'warn' },
        { code: 'DOB_DERIVED_FROM_NID', field: 'date_of_birth', severity: 'info' },
    ], 'review', { derived: ['date_of_birth'] }),

    // 2 — no ID (error); +20 number; ambiguous day-first DOB; "14 Oct." has no year.
    expectRow(2, ['L002', 'L003'], {
        name: 'Mona Hassan Ali',
        mobile: '01112345678',
        date_of_birth: '1985-04-03',
        marital_status: 'single',
        price: '250',
        notes: ['follow up'],
    }, [
        { code: 'NID_REQUIRED', field: 'national_id', severity: 'error' },
        { code: 'DOB_AMBIGUOUS', field: 'date_of_birth', severity: 'warn' },
        { code: 'DATE_NO_YEAR', field: 'visit_date', severity: 'info' },
        { code: 'ENUM_UNMATCHED', field: 'follower', severity: 'warn' },
    ], 'error'),

    // 3 — multi-line Arabic block; Arabic-Indic digits canonicalized; DOB derived.
    expectRow(3, ['L004', 'L005', 'L006', 'L007', 'L008'], {
        name: 'سارة عبد الرحمن',
        national_id: '29903220201567',
        mobile: '01223344556',
        date_of_birth: '1999-03-22',
        marital_status: 'divorced',
        governorate: 'Alexandria',
        notes: ['حساسية من البنسلين'],
    }, [
        { code: 'DOB_DERIVED_FROM_NID', field: 'date_of_birth', severity: 'info' },
    ], 'ready', { derived: ['date_of_birth'] }),

    // 4 — 13-digit ID stays as written (never completed); mobile without leading zero.
    expectRow(4, ['L009'], {
        name: 'khaled ibrahim',
        national_id: '3050101010101',
        mobile: '01012345679',
        governorate: 'Giza',
    }, [
        { code: 'NID_LENGTH', field: 'national_id', severity: 'error' },
    ], 'error'),

    // 5 — "O" in the number is read as 0 (015…); no ID → error.
    expectRow(5, ['L011', 'L012'], {
        name: 'محمد علي حسن',
        mobile: '01512345670',
        date_of_birth: '1975-11-30',
        marital_status: 'widowed',
        governorate: 'Cairo',
        notes: ['سكر + ضغط .. متابعة كل شهر'],
    }, [
        { code: 'NID_REQUIRED', field: 'national_id', severity: 'error' },
    ], 'error'),

    // 6 — same ID as row 1 (duplicate in batch).
    expectRow(6, ['L013'], {
        name: 'احمد محمود السيد',
        national_id: '29805151201234',
        mobile: '01012345678',
        date_of_birth: '1998-05-15',
        marital_status: 'married',
        notes: ['تاني زيارة'],
    }, [
        { code: 'DUP_IN_BATCH', field: null, severity: 'error' },
        { code: 'DOB_DERIVED_FROM_NID', field: 'date_of_birth', severity: 'info' },
    ], 'error', { derived: ['date_of_birth'] }),

    // 7 — DOB matches the ID exactly (no derive, no mismatch); "??" → model-uncertain note.
    expectRow(7, ['L014', 'L015', 'L016'], {
        name: 'Nour El-Din',
        national_id: '28512230101234',
        date_of_birth: '1985-12-23',
        governorate: 'Cairo',
        price: '400',
        notes: ['allergic to aspirin ??'],
    }, [
        { code: 'MODEL_UNCERTAIN', field: 'notes', severity: 'warn' },
    ], 'review'),

    // 8 — city in the governorate slot stays out of governorate; 12-digit mobile as written.
    expectRow(8, ['L017'], {
        name: 'ياسمين فتحي',
        mobile: '010987654321',
        date_of_birth: '2002-03-15',
        marital_status: 'single',
        address: 'طنطا',
    }, [
        { code: 'NID_REQUIRED', field: 'national_id', severity: 'error' },
        { code: 'MOBILE_FORMAT', field: 'mobile', severity: 'warn' },
    ], 'error'),

    // 9 — ID derived DOB; "01234 56789" merges to 10 digits (still not 11 → warn).
    expectRow(9, ['L018', 'L019'], {
        name: 'Omar S.',
        national_id: '30106150301987',
        mobile: '0123456789',
        date_of_birth: '2001-06-15',
        governorate: 'Port Said',
        notes: ['follow-up'],
    }, [
        { code: 'MOBILE_FORMAT', field: 'mobile', severity: 'warn' },
        { code: 'ENUM_UNMATCHED', field: 'follower', severity: 'warn' },
        { code: 'DOB_DERIVED_FROM_NID', field: 'date_of_birth', severity: 'info' },
    ], 'review', { derived: ['date_of_birth'] }),

    // 10 — single-token name; relative visit date stays empty.
    expectRow(10, ['L020', 'L021'], {
        name: 'ام كريم',
        mobile: '01112223344',
        price: '350',
    }, [
        { code: 'NID_REQUIRED', field: 'national_id', severity: 'error' },
        { code: 'DATE_RELATIVE', field: 'visit_date', severity: 'info' },
        { code: 'ENUM_UNMATCHED', field: 'follower', severity: 'warn' },
    ], 'error'),
];

// Raw enum texts the model saw, kept for hint display assertions (§8.3 step 4).
export const RAW_ENUM_HINTS = {
    2: { follower: 'dr amr' },
    9: { follower: 'Dr. Hala' },
    10: { follower: 'د. هالة' },
};

// ---------------------------------------------------------------------------
// Job-level assertions (spec §E.3)
// ---------------------------------------------------------------------------

export const JOB_ASSERTIONS = {
    rowCount: 10,
    // L010 is a clinic announcement: not a row, and no missed-record banner.
    ignoredLines: ['L010'],
    possibleMissedRecordLines: [],
    errorRows: [2, 4, 5, 6, 8, 10],
    importableByDefault: [1, 3, 7, 9],
    duplicateOf: { 6: 1 },
    // No visit year was invented for L003; no date at all for L021.
    inventedDateLines: [],
};

// E.3 #8 — a corrupted-digit variant of the group occupied by row 3. It must
// end as the source value with SNAPPED_TO_SOURCE, or blank with an error
// (regression R-01). Never silently accepted.
export const CORRUPTION_VARIANTS = [
    {
        description: 'One digit inserted, last digit dropped — still 14 digits',
        sourceLine: 'L005',
        sourceValue: '29903220201567',
        modelValue: '29903222020156',
        expect: { acceptOnlyIf: ['SNAPPED_TO_SOURCE'], orBlankWith: 'VALUE_NOT_IN_SOURCE' },
    },
];
