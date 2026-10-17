// Enum engine, alias tables and reference data (spec §8.3, Appendix C).
//
// One matching engine handles marital status, governorates, follower, section
// and source of money:
//   1. fold the raw text (canonicalize.foldForMatch), also with a leading ال
//      removed;
//   2. exact alias/label match → silent;
//   3. fuzzy match (Damerau-Levenshtein, per-length budgets) → only when a
//      single best candidate exists, flagged ENUM_FUZZY;
//   4. no match → empty value + ENUM_UNMATCHED with the raw text kept as a hint.
//
// Values are what the app stores: marital status codes, the 27 English
// governorate names, and `app_options` keys for the live lists.

import { foldForMatch, stripLeadingAl } from './canonicalize.js';

// ---------------------------------------------------------------------------
// Marital status (Appendix C.1)
// ---------------------------------------------------------------------------

export const MARITAL_STATUS = [
    {
        value: 'single',
        aliases: ['single', 'unmarried', 'أعزب', 'اعزب', 'عازب', 'عزباء', 'غير متزوج', 'غير متزوجة', 'سنجل'],
    },
    {
        value: 'married',
        aliases: ['married', 'متزوج', 'متزوجة', 'متجوز', 'متجوزة'],
    },
    {
        value: 'divorced',
        aliases: ['divorced', 'مطلق', 'مطلقة'],
    },
    {
        value: 'widowed',
        aliases: ['widowed', 'widow', 'widower', 'أرمل', 'ارمل', 'أرملة', 'ارملة'],
    },
];

// ---------------------------------------------------------------------------
// Governorates (Appendix C.2) — value is the app's stored English name.
// `idCode` is the national-ID governorate-of-birth code (digits 8–9); 88 is
// "born abroad" and has no governorate.
// ---------------------------------------------------------------------------

export const GOVERNORATES = [
    { value: 'Cairo', idCode: '01', ar: 'القاهرة', aliases: ['قاهرة', 'القاهره', 'cairo'] },
    { value: 'Alexandria', idCode: '02', ar: 'الإسكندرية', aliases: ['الاسكندرية', 'اسكندرية', 'alex', 'alexandria'] },
    { value: 'Port Said', idCode: '03', ar: 'بورسعيد', aliases: ['بور سعيد', 'port said'] },
    { value: 'Suez', idCode: '04', ar: 'السويس', aliases: ['suez'] },
    { value: 'Damietta', idCode: '11', ar: 'دمياط', aliases: ['damietta'] },
    { value: 'Dakahlia', idCode: '12', ar: 'الدقهلية', aliases: ['الدقهليه', 'dakahleya', 'dakahlia'] },
    { value: 'Sharqia', idCode: '13', ar: 'الشرقية', aliases: ['الشرقيه', 'sharkia', 'sharqia'] },
    { value: 'Qalyubia', idCode: '14', ar: 'القليوبية', aliases: ['القليوبيه', 'kalyoubia', 'qaliubiya', 'qalyubia'] },
    { value: 'Kafr El Sheikh', idCode: '15', ar: 'كفر الشيخ', aliases: ['كفر الشيخ', 'kafr el-sheikh', 'kafr elsheikh', 'kafr el sheikh'] },
    { value: 'Gharbia', idCode: '16', ar: 'الغربية', aliases: ['الغربيه', 'gharbia'] },
    { value: 'Monufia', idCode: '17', ar: 'المنوفية', aliases: ['المنوفيه', 'menofia', 'monufia'] },
    { value: 'Beheira', idCode: '18', ar: 'البحيرة', aliases: ['البحيره', 'behera', 'beheira'] },
    { value: 'Ismailia', idCode: '19', ar: 'الإسماعيلية', aliases: ['الاسماعيلية', 'الاسماعيليه', 'ismailia'] },
    { value: 'Giza', idCode: '21', ar: 'الجيزة', aliases: ['جيزة', 'الجيزه', 'giza'] },
    { value: 'Beni Suef', idCode: '22', ar: 'بني سويف', aliases: ['بنى سويف', 'bani suef', 'beni suef'] },
    { value: 'Faiyum', idCode: '23', ar: 'الفيوم', aliases: ['faiyum', 'fayoum'] },
    { value: 'Minya', idCode: '24', ar: 'المنيا', aliases: ['minia', 'minya'] },
    { value: 'Asyut', idCode: '25', ar: 'أسيوط', aliases: ['اسيوط', 'asyut', 'assiut'] },
    { value: 'Sohag', idCode: '26', ar: 'سوهاج', aliases: ['sohag'] },
    { value: 'Qena', idCode: '27', ar: 'قنا', aliases: ['qena'] },
    { value: 'Aswan', idCode: '28', ar: 'أسوان', aliases: ['اسوان', 'aswan'] },
    { value: 'Luxor', idCode: '29', ar: 'الأقصر', aliases: ['الاقصر', 'luxor'] },
    { value: 'Red Sea', idCode: '31', ar: 'البحر الأحمر', aliases: ['البحر الاحمر', 'red sea'] },
    { value: 'New Valley', idCode: '32', ar: 'الوادي الجديد', aliases: ['الوادى الجديد', 'new valley'] },
    { value: 'Matrouh', idCode: '33', ar: 'مطروح', aliases: ['marsa matruh', 'matrouh'] },
    { value: 'North Sinai', idCode: '34', ar: 'شمال سيناء', aliases: ['north sinai'] },
    { value: 'South Sinai', idCode: '35', ar: 'جنوب سيناء', aliases: ['south sinai'] },
];

export const GOVERNORATE_BY_ID_CODE = Object.freeze(
    Object.fromEntries(GOVERNORATES.map((entry) => [entry.idCode, entry.value])),
);

/** Governorate-of-birth code 88 means born outside Egypt. */
export const BORN_ABROAD_ID_CODE = '88';

// ---------------------------------------------------------------------------
// Month names (Appendix C.3) — Egyptian/common, Levantine and English.
// ---------------------------------------------------------------------------

export const MONTHS = Object.freeze({
    'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4, 'ابريل': 4, 'مايو': 5,
    'يونيو': 6, 'يوليو': 7, 'أغسطس': 8, 'اغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10,
    'اكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
    'كانون الثاني': 1, 'شباط': 2, 'آذار': 3, 'اذار': 3, 'نيسان': 4, 'أيار': 5,
    'ايار': 5, 'حزيران': 6, 'تموز': 7, 'آب': 8, 'اب': 8, 'أيلول': 9, 'ايلول': 9,
    'تشرين الأول': 10, 'تشرين الاول': 10, 'تشرين الثاني': 11, 'كانون الأول': 12,
    'كانون الاول': 12,
    'january': 1, 'jan': 1, 'february': 2, 'feb': 2, 'march': 3, 'mar': 3,
    'april': 4, 'apr': 4, 'may': 5, 'june': 6, 'jun': 6, 'july': 7, 'jul': 7,
    'august': 8, 'aug': 8, 'september': 9, 'sep': 9, 'sept': 9, 'october': 10,
    'oct': 10, 'november': 11, 'nov': 11, 'december': 12, 'dec': 12,
});

/** Month number for a written month name (folded comparison), or null. */
export function monthFromName(name) {
    const folded = foldForMatch(name).replace(/\.+$/, '');
    if (!folded) return null;
    for (const [label, month] of Object.entries(MONTHS)) {
        if (foldForMatch(label) === folded) return month;
    }
    return null;
}

/** Folded month-name set, used by date grounding. */
export const MONTH_NAMES_FOLDED = Object.freeze(
    [...new Set(Object.keys(MONTHS).map((label) => foldForMatch(label)))],
);

// ---------------------------------------------------------------------------
// Currency words stripped from price (Appendix C.4)
// ---------------------------------------------------------------------------

export const CURRENCY_WORDS = Object.freeze([
    'ج.م', 'ج', 'جنيهات', 'جنيه', 'جنية', 'egp', 'l.e', 'le', 'pounds', 'pound',
]);

// ---------------------------------------------------------------------------
// Fuzzy matching — Damerau-Levenshtein (optimal string alignment) with a cap
// ---------------------------------------------------------------------------

/**
 * Damerau-Levenshtein distance, capped at `max + 1` (returned as `max + 1`
 * when the true distance exceeds the cap — callers only compare against max).
 */
export function damerauLevenshtein(a, b, max = Infinity) {
    const s1 = String(a ?? '');
    const s2 = String(b ?? '');
    if (s1 === s2) return 0;
    if (Math.abs(s1.length - s2.length) > max) return max + 1;
    if (!s1.length) return s2.length;
    if (!s2.length) return s1.length;

    let prev2 = null;
    let prev = Array.from({ length: s2.length + 1 }, (_, j) => j);

    for (let i = 1; i <= s1.length; i += 1) {
        const current = new Array(s2.length + 1);
        current[0] = i;
        let rowMin = current[0];
        for (let j = 1; j <= s2.length; j += 1) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            let value = Math.min(
                prev[j] + 1, // deletion
                current[j - 1] + 1, // insertion
                prev[j - 1] + cost, // substitution
            );
            if (prev2 && i > 1 && j > 1 && s1[i - 1] === s2[j - 2] && s1[i - 2] === s2[j - 1]) {
                value = Math.min(value, prev2[j - 2] + 1); // transposition
            }
            current[j] = value;
            if (value < rowMin) rowMin = value;
        }
        if (rowMin > max) return max + 1;
        prev2 = prev;
        prev = current;
    }
    return prev[s2.length] > max ? max + 1 : prev[s2.length];
}

/** Fuzzy budget by folded length: 1 for 4–7 characters, 2 for 8+. */
export function fuzzyBudget(folded, { short = 1, long = 2 } = {}) {
    const length = String(folded ?? '').length;
    if (length < 4) return 0;
    return length <= 7 ? short : long;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * @param {string} raw
 * @param {{value: string, labels: string[]}[]} candidates
 * @returns {{value: string, matchedLabel: string|null, fuzzy: boolean, raw: string}}
 */
export function matchEnum(raw, candidates) {
    const original = String(raw ?? '');
    const folded = foldForMatch(original);
    if (!folded) return { value: '', matchedLabel: null, fuzzy: false, raw: original };

    const foldedCandidates = candidates.map((candidate) => ({
        value: candidate.value,
        foldedLabels: [...new Set(candidate.labels.map((label) => foldForMatch(label)).filter(Boolean))],
    }));

    const variants = [folded, stripLeadingAl(folded)];

    // 2a. Exact match, with and without the leading ال.
    const exact = new Set();
    let matchedLabel = null;
    for (const candidate of foldedCandidates) {
        for (const label of candidate.foldedLabels) {
            const labelVariants = [label, stripLeadingAl(label)];
            if (variants.some((variant) => labelVariants.includes(variant))) {
                exact.add(candidate.value);
                matchedLabel = label;
            }
        }
    }
    if (exact.size === 1) {
        return { value: [...exact][0], matchedLabel, fuzzy: false, raw: original };
    }
    if (exact.size > 1) {
        // A curated alias table should never be this ambiguous; refuse to guess.
        return { value: '', matchedLabel: null, fuzzy: false, raw: original };
    }

    // 3. Fuzzy: unique best candidate only.
    const budget = fuzzyBudget(folded);
    if (budget === 0) return { value: '', matchedLabel: null, fuzzy: false, raw: original };

    let bestDistance = budget + 1;
    let bestValues = new Set();
    let bestLabel = null;
    for (const candidate of foldedCandidates) {
        let candidateBest = budget + 1;
        let candidateLabel = null;
        for (const label of candidate.foldedLabels) {
            for (const variant of variants) {
                for (const labelVariant of [label, stripLeadingAl(label)]) {
                    const distance = damerauLevenshtein(variant, labelVariant, budget);
                    if (distance < candidateBest) {
                        candidateBest = distance;
                        candidateLabel = label;
                    }
                }
            }
        }
        if (candidateBest < bestDistance) {
            bestDistance = candidateBest;
            bestValues = new Set([candidate.value]);
            bestLabel = candidateLabel;
        } else if (candidateBest === bestDistance) {
            bestValues.add(candidate.value);
            bestLabel = null;
        }
    }

    if (bestValues.size === 1 && bestDistance <= budget) {
        return { value: [...bestValues][0], matchedLabel: bestLabel, fuzzy: true, raw: original };
    }
    return { value: '', matchedLabel: null, fuzzy: false, raw: original };
}

// ---------------------------------------------------------------------------
// Candidate resolution by enum source name (registry `enum` values)
// ---------------------------------------------------------------------------

/**
 * Resolve the candidate list for a registry enum source. `snapshot` carries
 * the app_options rows frozen into the job config at start (spec §4.3);
 * marital status and governorates are static.
 *
 * @param {string} enumName
 * @param {{follower?: object[], section?: object[], sourceOfMoney?: object[]}} snapshot
 * @returns {{value: string, labels: string[]}[]}
 */
export function enumCandidates(enumName, snapshot = {}) {
    if (enumName === 'maritalStatus') {
        return MARITAL_STATUS.map(({ value, aliases }) => ({ value, labels: aliases }));
    }
    if (enumName === 'governorate') {
        return GOVERNORATES.map(({ value, ar, aliases }) => ({ value, labels: [ar, value, ...aliases] }));
    }
    if (enumName === 'follower' || enumName === 'section' || enumName === 'sourceOfMoney') {
        return (snapshot[enumName] || []).map((option) => ({
            value: option.key,
            labels: [option.label_en, option.label_ar, option.key].filter(Boolean),
        }));
    }
    throw new Error(`Unknown enum source: ${enumName}`);
}
