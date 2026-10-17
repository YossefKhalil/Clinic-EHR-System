// Canned "good model" output for golden fixture #1 (synthetic data only).
//
// This is exactly what a well-behaved model returns for the canonicalized
// source lines of fixture-01 (spec §5.5: Arabic-Indic digits are converted in
// code before the prompt, so the model sees — and copies — Western digits).
// Values are copied as written: no reformatting, no completing, no mapping.
//
// The M1 pipeline test runs this through the rules engine without any LLM;
// the M4 eval runner later replaces it with the real model and checks the
// same expectations.

import { FIELD_KEYS } from '../../../supabase/functions/_shared/import-core/field-registry.js';

const EMPTY_FIELDS = Object.fromEntries(FIELD_KEYS.map((key) => [key, '']));

function record(fields) {
    return {
        ...EMPTY_FIELDS,
        notes: [],
        unmapped: [],
        _uncertain: [],
        ...fields,
    };
}

export const CANNED_RECORDS = [
    // 1 — L001
    record({
        _src: 'S1:L001',
        name: 'احمد محمود السيد',
        national_id: '29805151201234',
        mobile: '01012345678',
        marital_status: 'متزوج',
        governorate: 'الدقهلية',
        visit_date: '12/10/2026',
        price: '300 ج',
    }),

    // 2 — L002–L003 (two lines, one patient)
    record({
        _src: 'S1:L002-L003',
        name: 'Mona Hassan Ali',
        mobile: '+20 111 234 5678',
        date_of_birth: '3/4/1985',
        marital_status: 'single',
        visit_date: '14 Oct.',
        price: '250',
        follower: 'dr amr',
        notes: ['follow up'],
    }),

    // 3 — L004–L008 (one patient spread over five lines)
    record({
        _src: 'S1:L004-L008',
        name: 'سارة عبد الرحمن',
        national_id: '29903220201567',
        mobile: '01223344556',
        marital_status: 'مطلقة',
        governorate: 'الاسكندرية',
        notes: ['حساسية من البنسلين'],
    }),

    // 4 — L009
    record({
        _src: 'S1:L009',
        name: 'khaled ibrahim',
        national_id: '3050101010101',
        mobile: '1012345679',
        governorate: 'Giza',
        source_of_money: 'insurance',
    }),

    // 5 — L011–L012; the mobile is copied with its leading letter O
    record({
        _src: 'S1:L011-L012',
        name: 'محمد علي حسن',
        mobile: 'O1512345670',
        date_of_birth: '1975-11-30',
        marital_status: 'ارمل',
        governorate: 'القاهرة',
        notes: ['سكر + ضغط .. متابعة كل شهر'],
    }),

    // 6 — L013; the same patient as row 1, second visit
    record({
        _src: 'S1:L013',
        name: 'احمد محمود السيد',
        national_id: '29805151201234',
        mobile: '+201012345678',
        marital_status: 'متجوز',
        notes: ['تاني زيارة'],
    }),

    // 7 — L014–L016; the model was unsure about the notes (the "??")
    record({
        _src: 'S1:L014-L016',
        name: 'Nour El-Din',
        national_id: '28512230101234',
        date_of_birth: '23-12-85',
        governorate: 'Cairo',
        price: '400',
        notes: ['allergic to aspirin ??'],
        _uncertain: ['notes: question marks in the source'],
    }),

    // 8 — L017; Tanta is a city, so it goes to address, not governorate
    record({
        _src: 'S1:L017',
        name: 'ياسمين فتحي',
        mobile: '010987654321',
        date_of_birth: '15 مارس 2002',
        marital_status: 'عزباء',
        address: 'طنطا',
    }),

    // 9 — L018–L019
    record({
        _src: 'S1:L018-L019',
        name: 'Omar S.',
        national_id: '30106150301987',
        mobile: '01234 56789',
        governorate: 'Port Said',
        follower: 'Dr. Hala',
        notes: ['follow-up'],
    }),

    // 10 — L020–L021; the relative date is copied but never resolved
    record({
        _src: 'S1:L020-L021',
        name: 'ام كريم',
        mobile: '0111-222-3344',
        visit_date: 'امبارح',
        price: '350 جنيه',
        follower: 'د. هالة',
    }),
];
