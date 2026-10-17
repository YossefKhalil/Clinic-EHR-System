// Normalizers (spec §8.3) — pure, idempotent, one per field type.
//
// Contract: `(raw, context) -> { value, issues[], ... }`.
//   - raw is the model's value, copied as written (or a user edit in review).
//   - value is what may be stored after normalization; '' or null = empty.
//   - issues carry stable codes from issues.js; nothing here throws on bad input.
//
// Validators (validate.js) own required/range checks; normalizers own parsing,
// ambiguity flags and unit handling. Range checks that need `today` live in
// validators so the normalizer stays timeless.

import {
    canonicalizeText, collapseSpaces, isEmptyToken, toWesternDigits, foldForMatch, foldTokens,
} from './canonicalize.js';
import {
    BORN_ABROAD_ID_CODE, CURRENCY_WORDS, GOVERNORATE_BY_ID_CODE,
    enumCandidates, matchEnum, monthFromName,
} from './enums.js';
import { issue } from './issues.js';
import { LIMITS } from './limits.js';

const asScalar = (raw) => String(raw ?? '');

function emptyResult(extra = {}) {
    return { value: '', issues: [], ...extra };
}

/** Whole-value "empty" tokens (Appendix C.5) plus a plain empty string. */
function isEffectivelyEmpty(raw) {
    if (raw === null || raw === undefined) return true;
    const text = asScalar(raw).trim();
    return text === '' || isEmptyToken(text);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

export function isRealDate(year, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

export function toIso(year, month, day) {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Whole years between an ISO dob and an ISO reference date; null when invalid. */
export function ageFromDob(dobIso, todayIso) {
    if (!dobIso || !todayIso) return null;
    const dob = new Date(`${dobIso}T00:00:00Z`);
    const today = new Date(`${todayIso}T00:00:00Z`);
    if (Number.isNaN(dob.getTime()) || Number.isNaN(today.getTime())) return null;
    let age = today.getUTCFullYear() - dob.getUTCFullYear();
    const monthDiff = today.getUTCMonth() - dob.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
    return age >= 0 ? age : null;
}

const RELATIVE_DATE_TOKENS = [
    'yesterday', 'today', 'tomorrow', 'امبارح', 'مبارح', 'النهاردة', 'النهارده',
    'اليوم', 'بكرة', 'بكرا', 'last sunday', 'last monday', 'last tuesday',
    'last wednesday', 'last thursday', 'last friday', 'last saturday',
    'الأحد', 'الاتنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت',
];

// ---------------------------------------------------------------------------
// name
// ---------------------------------------------------------------------------

const NAME_PARTIAL_PHRASES = [
    'باقي الاسم', 'باقى الاسم', 'مش معايا', 'الاسم ناقص',
    'partial name', 'name incomplete', 'rest of the name',
];

/**
 * True when a source text says the name is incomplete ("the rest of the name
 * I don't have"). The pipeline checks the cited lines, not the extracted
 * value, so the hint survives even when the model cleaned the name up.
 */
export function hasPartialNameHint(text) {
    const folded = foldForMatch(text);
    if (!folded) return false;
    return NAME_PARTIAL_PHRASES.some((phrase) => folded.includes(foldForMatch(phrase)));
}

export function normalizeName(raw) {
    if (isEffectivelyEmpty(raw)) return emptyResult();
    let text = collapseSpaces(canonicalizeText(asScalar(raw)));
    // Trim leading/trailing punctuation (- , : ;) but never the dot: "Omar S."
    // is a name, not a sentence (spec §8.3).
    text = text.replace(/^[\s\-–—,:;]+/, '').replace(/[\s\-–—,:;]+$/, '');
    const issues = [];

    const tokens = foldTokens(text);
    if (tokens.length === 1) issues.push(issue('NAME_SINGLE_TOKEN', { field: 'name' }));

    return { value: text, issues };
}

// ---------------------------------------------------------------------------
// national_id
// ---------------------------------------------------------------------------

/** Digits-only cleanup with the O→0 adjacency rule shared by ID and mobile. */
function cleanDigitText(raw) {
    const text = toWesternDigits(asScalar(raw)).replace(/[\s\-.()\u060C,]/g, '');
    // A letter O counts as a zero when it sits next to a digit or another O
    // ("1OO" → "100"). One pass suffices: O→0 can only turn a neighbour into
    // a digit, and such a neighbour was an O already handled by this rule.
    const numericNeighbour = (ch) => ch !== undefined && /[\dOo]/.test(ch);
    return text.replace(/[Oo]/g, (match, offset) => (
        numericNeighbour(text[offset - 1]) || numericNeighbour(text[offset + 1]) ? '0' : match
    ));
}

/**
 * Decode the structure of a 14-digit Egyptian national ID.
 * Dig 1 century digit, 2–7 YYMMDD, 8–9 governorate of birth, 10–13 sequence,
 * 14 check digit (never validated — the algorithm is not officially published).
 */
export function decodeNationalId(value) {
    const digits = asScalar(value);
    if (!/^\d{14}$/.test(digits)) return null;
    const centuryDigit = Number(digits[0]);
    if (centuryDigit !== 2 && centuryDigit !== 3) return null;
    const century = centuryDigit === 2 ? 1900 : 2000;
    const year = century + Number(digits.slice(1, 3));
    const month = Number(digits.slice(3, 5));
    const day = Number(digits.slice(5, 7));
    const governorateCode = digits.slice(7, 9);
    if (!isRealDate(year, month, day)) return null;
    return {
        date: toIso(year, month, day),
        governorateCode,
    };
}

export function normalizeNationalId(raw) {
    if (isEffectivelyEmpty(raw)) return emptyResult({ decoded: null });
    const digits = cleanDigitText(raw);
    const issues = [];

    if (/\D/.test(digits)) {
        issues.push(issue('NID_CHARS', { field: 'national_id', detail: { value: digits } }));
        return { value: digits, issues, decoded: null };
    }
    if (digits.length !== 14) {
        issues.push(issue('NID_LENGTH', { field: 'national_id', detail: { length: digits.length } }));
        return { value: digits, issues, decoded: null };
    }

    const centuryDigit = Number(digits[0]);
    if (centuryDigit !== 2 && centuryDigit !== 3) {
        issues.push(issue('NID_CENTURY', { field: 'national_id' }));
        return { value: digits, issues, decoded: null };
    }

    const year = (centuryDigit === 2 ? 1900 : 2000) + Number(digits.slice(1, 3));
    const month = Number(digits.slice(3, 5));
    const day = Number(digits.slice(5, 7));
    if (!isRealDate(year, month, day)) {
        issues.push(issue('NID_DATE_INVALID', { field: 'national_id' }));
        return { value: digits, issues, decoded: null };
    }

    const decoded = { date: toIso(year, month, day), governorateCode: digits.slice(7, 9) };
    if (decoded.governorateCode !== BORN_ABROAD_ID_CODE && !GOVERNORATE_BY_ID_CODE[decoded.governorateCode]) {
        issues.push(issue('NID_GOV_UNKNOWN', { field: 'national_id', detail: { code: decoded.governorateCode } }));
    }
    return { value: digits, issues, decoded };
}

// ---------------------------------------------------------------------------
// mobile
// ---------------------------------------------------------------------------

/**
 * Normalize an Egyptian mobile to the app's storage format (decision D19,
 * `PHONE_STORAGE_FORMAT = 'local'` → `01xxxxxxxxx`).
 */
export function normalizeMobile(raw, { storageFormat = LIMITS.PHONE_STORAGE_FORMAT } = {}) {
    if (isEffectivelyEmpty(raw)) return emptyResult({ raw: '' });
    const original = asScalar(raw).trim();
    let digits = cleanDigitText(original).replace(/^\++/, '');

    const issues = [];

    // Country code: +20…, 0020…, or a 12-digit string starting 20.
    if (/^0020/.test(digits)) digits = digits.slice(4);
    else if (/^20\d{10}$/.test(digits)) digits = digits.slice(2);

    // 10-digit local number missing its leading zero.
    if (/^1[0125]\d{8}$/.test(digits)) digits = `0${digits}`;

    const isMobile = /^01[0125]\d{8}$/.test(digits);
    if (!isMobile) {
        const looksLandline = /^0[23456789]/.test(digits) && !/^01/.test(digits);
        issues.push(issue('MOBILE_FORMAT', {
            field: 'mobile',
            detail: { value: digits, hint: looksLandline ? 'landline' : null },
        }));
    }

    const value = storageFormat === 'international' && isMobile
        ? `+20${digits.slice(1)}`
        : digits;
    return { value, issues, raw: original };
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

const DATE_AMBIGUOUS_CODE = { date_of_birth: 'DOB_AMBIGUOUS', visit_date: 'DATE_AMBIGUOUS' };
const TWO_DIGIT_YEAR_CODE = { date_of_birth: 'DOB_TWO_DIGIT_YEAR', visit_date: 'DATE_TWO_DIGIT_YEAR' };

function resolveTwoDigitYear(year, field, todayIso) {
    const currentYear = Number(String(todayIso).slice(0, 4));
    const yy = Number(year);
    if (field === 'visit_date') return 2000 + yy;
    // dob: the century that keeps the date in the past; prefer the more recent.
    const recent = 2000 + yy;
    if (recent <= currentYear) return recent;
    return 1900 + yy;
}

/**
 * Parse a written date to ISO. Day-first (Egyptian convention). Never invents
 * a year, never resolves relative words. `context.idDate` (decoded from a
 * valid national ID) disambiguates day/month order when it matches exactly
 * one reading.
 */
export function normalizeDate(raw, { field, today, idDate = null } = {}) {
    if (isEffectivelyEmpty(raw)) return emptyResult({ raw: '' });
    const original = asScalar(raw).trim();
    const text = collapseSpaces(toWesternDigits(canonicalizeText(original)));
    const issues = [];

    const folded = foldForMatch(text);
    if (RELATIVE_DATE_TOKENS.some((token) => foldForMatch(token) === folded || folded.includes(foldForMatch(token)))) {
        issues.push(issue('DATE_RELATIVE', { field, detail: { raw: original } }));
        return { value: '', issues, raw: original };
    }

    const applyMonthDay = (day, month, year, { ambiguous, twoDigit }) => {
        if (!isRealDate(year, month, day)) return null;
        const iso = toIso(year, month, day);
        if (twoDigit) issues.push(issue(TWO_DIGIT_YEAR_CODE[field] || 'DATE_TWO_DIGIT_YEAR', { field }));
        if (ambiguous) {
            // The ID can disambiguate: if exactly one of the two readings
            // matches the decoded birth date, that reading wins, no flag.
            const swapped = toIso(year, day, month);
            if (idDate && swapped === idDate && iso !== idDate) {
                return swapped;
            }
            if (idDate && iso === idDate) return iso;
            issues.push(issue(DATE_AMBIGUOUS_CODE[field] || 'DATE_AMBIGUOUS', { field }));
        }
        return iso;
    };

    // 1. ISO: yyyy-mm-dd
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
        const [, y, m, d] = match;
        const iso = applyMonthDay(Number(d), Number(m), Number(y), { ambiguous: false, twoDigit: false });
        if (iso) return { value: iso, issues, raw: original };
    }

    // 2. dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy …
    match = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
    if (match) {
        const [, dRaw, mRaw, yRaw] = match;
        const day = Number(dRaw);
        const month = Number(mRaw);
        const twoDigit = yRaw.length === 2;
        const year = twoDigit ? resolveTwoDigitYear(yRaw, field, today) : Number(yRaw);
        const ambiguous = day <= 12 && month <= 12 && day !== month;
        const iso = applyMonthDay(day, month, year, { ambiguous, twoDigit });
        if (iso) return { value: iso, issues, raw: original };
    }

    // 3. yyyymmdd
    match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (match) {
        const iso = applyMonthDay(Number(match[3]), Number(match[2]), Number(match[1]), { ambiguous: false, twoDigit: false });
        if (iso) return { value: iso, issues, raw: original };
    }

    // 4. dd <month name> yyyy (Arabic or English, optional trailing dot)
    match = text.match(/^(\d{1,2})\s+([\p{L}.]+)\s+(\d{2}|\d{4})$/u);
    if (match) {
        const month = monthFromName(match[2]);
        if (month) {
            const twoDigit = match[3].length === 2;
            const year = twoDigit ? resolveTwoDigitYear(match[3], field, today) : Number(match[3]);
            const iso = applyMonthDay(Number(match[1]), month, year, { ambiguous: false, twoDigit });
            if (iso) return { value: iso, issues, raw: original };
        }
    }

    // 5. Day and month without a year — never invent one.
    if (/^\d{1,2}[/\-.]\d{1,2}$/.test(text) || /^\d{1,2}\s+[\p{L}.]+$/u.test(text)) {
        issues.push(issue('DATE_NO_YEAR', { field, detail: { raw: original } }));
        return { value: '', issues, raw: original };
    }

    issues.push(issue('VALUE_NOT_IN_SOURCE', {
        field, severity: 'warn', detail: { raw: original, reason: 'unparsed_date' },
    }));
    return { value: '', issues, raw: original };
}

// ---------------------------------------------------------------------------
// age, children_count, price
// ---------------------------------------------------------------------------

const AGE_MONTH_DAY_UNITS = ['شهور', 'شهر', 'أيام', 'ايام', 'يوم', 'months', 'month', 'days', 'day'];

export function normalizeAge(raw) {
    if (isEffectivelyEmpty(raw)) return emptyResult({ raw: '' });
    const original = asScalar(raw).trim();
    const text = collapseSpaces(toWesternDigits(canonicalizeText(original)));
    const issues = [];

    const digits = (text.match(/\d+/) || [])[0];
    if (!digits) return emptyResult({ raw: original });

    const value = Number(digits);
    const unitTokens = foldTokens(text);
    const hasMonthDayUnit = AGE_MONTH_DAY_UNITS.some((unit) => unitTokens.includes(foldForMatch(unit)));

    if (hasMonthDayUnit) {
        issues.push(issue('AGE_UNIT', { field: 'age', detail: { raw: original, unit: 'month_day' } }));
        return { value: 0, issues, raw: original };
    }
    return { value, issues, raw: original };
}

const NONE_WORDS = ['لا يوجد', 'بدون', 'none', 'no children', 'مفيش'];

export function normalizeChildrenCount(raw) {
    if (raw === null || raw === undefined) return emptyResult({ raw: '' });
    const original = asScalar(raw).trim();
    if (original === '') return emptyResult({ raw: '' });
    const folded = foldForMatch(canonicalizeText(original));
    if (NONE_WORDS.some((word) => foldForMatch(word) === folded)) {
        return { value: 0, issues: [], raw: original };
    }
    if (isEmptyToken(original)) return emptyResult({ raw: original });
    const digits = (toWesternDigits(canonicalizeText(original)).match(/\d+/) || [])[0];
    if (!digits) return emptyResult({ raw: original });
    return { value: Number(digits), issues: [], raw: original };
}

export function normalizePrice(raw) {
    if (isEffectivelyEmpty(raw)) return emptyResult({ raw: '' });
    const original = asScalar(raw).trim();
    let text = toWesternDigits(canonicalizeText(original)).toLowerCase();

    // Strip currency words, longest first so "ج.م" wins over "ج".
    for (const word of [...CURRENCY_WORDS].sort((a, b) => b.length - a.length)) {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (/^[a-z.]/.test(word)) {
            text = text.replace(new RegExp(escaped, 'gi'), ' ');
        } else if (word === 'ج') {
            text = text.replace(/(?<![\p{L}])ج(?![\p{L}])/gu, ' ');
        } else {
            text = text.replace(new RegExp(escaped, 'g'), ' ');
        }
    }
    text = text.replace(/[,'\u066C]/g, '').replace(/\u066B/g, '.').trim();

    const match = text.match(/-?\d+(\.\d+)?/);
    if (!match) {
        return { value: null, issues: [issue('VALUE_NOT_IN_SOURCE', {
            field: 'price', severity: 'warn', detail: { raw: original, reason: 'unparsed_price' },
        })], raw: original };
    }
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return { value: null, issues: [issue('PRICE_RANGE', {
            field: 'price', detail: { raw: original, value: parsed },
        })], raw: original };
    }
    const rounded = Math.round(parsed * 100) / 100;
    // Never emit negative zero: "-0" is just 0 with a sign artifact.
    return { value: rounded === 0 ? 0 : rounded, issues: [], raw: original };
}

// ---------------------------------------------------------------------------
// free text and notes
// ---------------------------------------------------------------------------

export function normalizeFreeText(raw) {
    if (raw === null || raw === undefined) return emptyResult({ raw: '' });
    const original = asScalar(raw);
    if (isEffectivelyEmpty(original)) return emptyResult({ raw: original });
    const text = original
        .normalize('NFC')
        .replace(/\r\n?/g, '\n')
        // Strip control characters, but keep line breaks; tabs stay and are
        // collapsed to single spaces together with the other whitespace.
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .split('\n')
        .map((line) => collapseSpaces(line))
        .join('\n')
        .trim();
    return { value: text, issues: [], raw: original };
}

export function normalizeNotes(raw) {
    const original = raw;
    const list = Array.isArray(raw) ? raw : (isEffectivelyEmpty(raw) ? [] : [raw]);
    const seen = new Set();
    const notes = [];
    for (const entry of list) {
        const text = normalizeFreeText(entry).value;
        if (!text) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        notes.push(text);
    }
    return { value: notes, issues: [], raw: original };
}

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

export function normalizeEnum(raw, { enumName, snapshot = {} } = {}) {
    if (isEffectivelyEmpty(raw)) return emptyResult({ raw: '' });
    const original = asScalar(raw).trim();
    const candidates = enumCandidates(enumName, snapshot);
    const match = matchEnum(original, candidates);
    const issues = [];

    if (match.value && match.fuzzy) {
        issues.push(issue('ENUM_FUZZY', {
            field: null, detail: { raw: original, value: match.value, matchedLabel: match.matchedLabel },
        }));
    } else if (!match.value) {
        issues.push(issue('ENUM_UNMATCHED', { field: null, detail: { raw: original } }));
    }

    return { value: match.value, issues, raw: original };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export const NORMALIZERS = {
    name: normalizeName,
    nationalId: normalizeNationalId,
    mobile: normalizeMobile,
    date: normalizeDate,
    age: normalizeAge,
    childrenCount: normalizeChildrenCount,
    price: normalizePrice,
    freeText: normalizeFreeText,
    notes: normalizeNotes,
    enumMatch: normalizeEnum,
};

/**
 * Run the normalizer bound to a registry field.
 *
 * @param {import('./field-registry.js').FieldEntry} field
 * @param {unknown} raw
 * @param {{today: string, snapshot?: object, idDate?: string|null}} context
 */
export function normalizeField(field, raw, context = {}) {
    const normalizer = NORMALIZERS[field.normalize];
    if (!normalizer) throw new Error(`No normalizer named ${field.normalize} for ${field.key}`);

    let result;
    if (field.normalize === 'enumMatch') {
        result = normalizer(raw, { enumName: field.enum, snapshot: context.snapshot });
    } else if (field.normalize === 'date') {
        // The decoded national ID disambiguates day/month order for the date
        // of birth only (spec §8.3); a visit date never matches a birth date.
        result = normalizer(raw, {
            field: field.key,
            today: context.today,
            idDate: field.key === 'date_of_birth' ? context.idDate : null,
        });
    } else if (field.normalize === 'mobile') {
        result = normalizer(raw, { storageFormat: context.phoneStorageFormat });
    } else {
        result = normalizer(raw);
    }

    // Bind issue.field when the normalizer left it open (enums know their
    // source but not their column).
    for (const entry of result.issues) {
        if (!entry.field || entry.field === null) entry.field = field.key;
    }
    return result;
}

/** Empty-value set used by grounding for "blank the cell" decisions. */
export function valueIsEmpty(value) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    return String(value).trim() === '';
}
