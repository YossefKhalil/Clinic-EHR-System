import { describe, expect, it } from 'vitest';
import { fieldByKey } from '@import-core/field-registry.js';
import {
    ageFromDob,
    decodeNationalId,
    hasPartialNameHint,
    normalizeAge,
    normalizeChildrenCount,
    normalizeDate,
    normalizeEnum,
    normalizeField,
    normalizeFreeText,
    normalizeMobile,
    normalizeName,
    normalizeNationalId,
    normalizeNotes,
    normalizePrice,
    valueIsEmpty,
} from '@import-core/normalizers.js';

import { ENUM_SNAPSHOT } from '../fixtures/golden/fixture-01.js';

const TODAY = '2026-10-17';
const codes = (result) => result.issues.map((entry) => entry.code);

describe('normalizeName', () => {
    it('collapses whitespace and trims leading/trailing punctuation', () => {
        expect(normalizeName('  - أحمد   محمود :').value).toBe('أحمد محمود');
        expect(normalizeName('--- Mona Hassan ---').value).toBe('Mona Hassan');
    });

    it('keeps an internal or trailing dot ("Omar S." is a name)', () => {
        expect(normalizeName('Omar S.').value).toBe('Omar S.');
        expect(normalizeName('Nour El-Din').value).toBe('Nour El-Din');
    });

    it('strips zero-width characters but never folds letters', () => {
        expect(normalizeName('أ\u200Bحمد').value).toBe('أحمد');
    });

    it('flags a single token and treats empty tokens as empty', () => {
        expect(codes(normalizeName('Sara'))).toEqual(['NAME_SINGLE_TOKEN']);
        expect(normalizeName('n/a')).toMatchObject({ value: '' });
        expect(normalizeName('أحمد محمود')).toMatchObject({ value: 'أحمد محمود' });
    });
});

describe('normalizeNationalId', () => {
    it('reads Arabic-Indic digits and decodes the structure', () => {
        const result = normalizeNationalId('٢٩٩٠٣٢٢٠٢٠١٥٦٧');
        expect(result.value).toBe('29903220201567');
        expect(result.decoded).toEqual({ date: '1999-03-22', governorateCode: '02' });
        expect(result.issues).toEqual([]);
    });

    it('reads an O adjacent to digits as 0 and strips separators', () => {
        expect(normalizeNationalId('2980-5151-20123O').value).toBe('29805151201230');
        expect(normalizeNationalId('2980 5151 201234').value).toBe('29805151201234');
    });

    it('flags remaining characters, wrong length and bad century', () => {
        expect(codes(normalizeNationalId('abc123'))).toEqual(['NID_CHARS']);
        expect(codes(normalizeNationalId('3050101010101'))).toEqual(['NID_LENGTH']);
        expect(normalizeNationalId('3050101010101').issues[0].detail).toEqual({ length: 13 });
        expect(codes(normalizeNationalId('19805151201234'))).toEqual(['NID_CENTURY']);
    });

    it('flags impossible dates and unknown governorate codes (88 is known)', () => {
        expect(codes(normalizeNationalId('29913321201234'))).toEqual(['NID_DATE_INVALID']);
        expect(codes(normalizeNationalId('29805159901234'))).toEqual(['NID_GOV_UNKNOWN']);
        expect(codes(normalizeNationalId('29805158801234'))).toEqual([]);
    });

    it('decodes only well-formed IDs', () => {
        expect(decodeNationalId('29805151201234')).toEqual({ date: '1998-05-15', governorateCode: '12' });
        expect(decodeNationalId('3050101010101')).toBeNull();
        expect(decodeNationalId('19805151201234')).toBeNull();
        expect(decodeNationalId('')).toBeNull();
        expect(decodeNationalId(null)).toBeNull();
    });
});

describe('normalizeMobile', () => {
    it('normalizes +20, 0020 and missing-zero forms to 01xxxxxxxxx', () => {
        expect(normalizeMobile('+20 111 234 5678')).toMatchObject({ value: '01112345678' });
        expect(normalizeMobile('+201012345678')).toMatchObject({ value: '01012345678' });
        expect(normalizeMobile('0020 121 234 5678')).toMatchObject({ value: '01212345678' });
        expect(normalizeMobile('1012345679')).toMatchObject({ value: '01012345679' });
        expect(normalizeMobile('0111-222-3344')).toMatchObject({ value: '01112223344' });
        expect(normalizeMobile('01512345670').issues).toEqual([]);
    });

    it('flags non-mobile shapes and hints at landlines; keeps cleaned digits', () => {
        const retyped = normalizeMobile('010987654321');
        expect(retyped.value).toBe('010987654321');
        expect(codes(retyped)).toEqual(['MOBILE_FORMAT']);
        const landline = normalizeMobile('0221234567');
        expect(codes(landline)).toEqual(['MOBILE_FORMAT']);
        expect(landline.issues[0].detail.hint).toBe('landline');
    });

    it('honors the storage-format constant', () => {
        expect(normalizeMobile('01012345678', { storageFormat: 'international' }).value)
            .toBe('+201012345678');
        expect(normalizeMobile('01012345678', { storageFormat: 'local' }).value)
            .toBe('01012345678');
    });

    it('treats empty tokens as empty', () => {
        expect(normalizeMobile('—').value).toBe('');
        expect(normalizeMobile('').value).toBe('');
        expect(normalizeMobile('   ').value).toBe('');
        expect(normalizeMobile(undefined).value).toBe('');
        expect(normalizeMobile(null).value).toBe('');
    });
});

describe('normalizeDate', () => {
    const dob = (raw, extra = {}) => normalizeDate(raw, { field: 'date_of_birth', today: TODAY, ...extra });
    const visit = (raw) => normalizeDate(raw, { field: 'visit_date', today: TODAY });

    it('accepts the written formats of §8.3 and outputs ISO', () => {
        expect(dob('1998-05-15').value).toBe('1998-05-15');
        expect(dob('15/3/1985').value).toBe('1985-03-15');
        expect(dob('15-3-1985').value).toBe('1985-03-15');
        expect(dob('15.3.1985').value).toBe('1985-03-15');
        expect(dob('19980515').value).toBe('1998-05-15');
        expect(dob('15 مارس 2002').value).toBe('2002-03-15');
        expect(dob('15 Oct. 1985').value).toBe('1985-10-15');
    });

    it('reads day-first and flags day/month ambiguity', () => {
        const result = dob('3/4/1985');
        expect(result.value).toBe('1985-04-03');
        expect(codes(result)).toEqual(['DOB_AMBIGUOUS']);
    });

    it('lets a decoded national ID disambiguate exactly one reading', () => {
        const asDayFirst = dob('03/04/1985', { idDate: '1985-04-03' });
        expect(asDayFirst).toMatchObject({ value: '1985-04-03' });
        expect(codes(asDayFirst)).toEqual([]);
        const asMonthFirst = dob('03/04/1985', { idDate: '1985-03-04' });
        expect(asMonthFirst).toMatchObject({ value: '1985-03-04' });
        expect(codes(asMonthFirst)).toEqual([]);
    });

    it('resolves two-digit years by field: dob stays in the past, visit uses 20yy', () => {
        expect(dob('23-12-85')).toMatchObject({ value: '1985-12-23' });
        expect(codes(dob('23-12-85'))).toEqual(['DOB_TWO_DIGIT_YEAR']);
        expect(visit('15/3/26')).toMatchObject({ value: '2026-03-15' });
        expect(codes(visit('15/3/26'))).toEqual(['DATE_TWO_DIGIT_YEAR']);
    });

    it('never invents a year and never resolves relative words', () => {
        expect(dob('14 Oct.')).toMatchObject({ value: '' });
        expect(codes(dob('14 Oct.'))).toEqual(['DATE_NO_YEAR']);
        expect(visit('امبارح')).toMatchObject({ value: '' });
        expect(codes(visit('امبارح'))).toEqual(['DATE_RELATIVE']);
    });

    it('flags unparseable text without discarding the raw', () => {
        const result = dob('next week');
        expect(result.value).toBe('');
        expect(codes(result)).toEqual(['VALUE_NOT_IN_SOURCE']);
        expect(result.issues[0].severity).toBe('warn');
        expect(result.raw).toBe('next week');
    });

    it('rejects impossible dates like 31/02', () => {
        expect(dob('31/2/1985').value).toBe('');
        expect(codes(dob('31/2/1985'))).toEqual(['VALUE_NOT_IN_SOURCE']);
    });

    it('treats empty tokens and null as empty input', () => {
        expect(dob('—').value).toBe('');
        expect(normalizeDate(null, { field: 'visit_date', today: TODAY }).value).toBe('');
    });

    it('reads two-digit years in month-name dates as well', () => {
        expect(dob('15 مايو 85')).toMatchObject({ value: '1985-05-15' });
        expect(codes(dob('15 مايو 85'))).toEqual(['DOB_TWO_DIGIT_YEAR']);
    });

    it('resolves a future two-digit dob year into the previous century', () => {
        expect(dob('15/5/55')).toMatchObject({ value: '1955-05-15' });
        expect(codes(dob('15/5/55'))).toEqual(['DOB_TWO_DIGIT_YEAR']);
        expect(dob('15/5/25')).toMatchObject({ value: '2025-05-15' });
    });

    it('falls back to the generic codes when no field is bound', () => {
        expect(codes(normalizeDate('15/5/85', { today: TODAY }))).toEqual(['DATE_TWO_DIGIT_YEAR']);
        expect(codes(normalizeDate('05/08/1990', { today: TODAY }))).toEqual(['DATE_AMBIGUOUS']);
    });

    it('computes whole-year ages (and never a negative one)', () => {
        expect(ageFromDob('1998-05-15', '2026-10-17')).toBe(28);
        expect(ageFromDob('1975-11-30', '2026-10-17')).toBe(50);
        expect(ageFromDob('2026-10-18', '2026-10-17')).toBeNull();
    });

    it('returns null for missing or malformed age inputs', () => {
        expect(ageFromDob(null, TODAY)).toBeNull();
        expect(ageFromDob('1998-05-15', null)).toBeNull();
        expect(ageFromDob('garbage', TODAY)).toBeNull();
        expect(ageFromDob('1998-05-15', 'garbage')).toBeNull();
    });

    it('uses the idDate only through the date_of_birth field binding', () => {
        const visitField = fieldByKey('visit_date');
        const result = normalizeField(visitField, '03/04/1985', { today: TODAY, idDate: '1985-03-04' });
        expect(result.value).toBe('1985-04-03');
        expect(codes(result)).toEqual(['DATE_AMBIGUOUS']);
    });
});

describe('normalizeAge, normalizeChildrenCount, normalizePrice', () => {
    it('reads ages with unit words; months/days become 0 with a flag', () => {
        expect(normalizeAge('35 سنة').value).toBe(35);
        expect(normalizeAge('35y').value).toBe(35);
        expect(normalizeAge('٤٠').value).toBe(40);
        expect(normalizeAge('6 شهور')).toMatchObject({ value: 0 });
        expect(codes(normalizeAge('10 days'))).toEqual(['AGE_UNIT']);
        expect(normalizeAge('').value).toBe('');
        expect(normalizeAge('كبير').value).toBe('');
    });

    it('maps explicit "none" words to 0 and leaves empty empty', () => {
        expect(normalizeChildrenCount('لا يوجد').value).toBe(0);
        expect(normalizeChildrenCount('بدون').value).toBe(0);
        expect(normalizeChildrenCount('none').value).toBe(0);
        expect(normalizeChildrenCount('3').value).toBe(3);
        expect(normalizeChildrenCount('').value).toBe('');
        expect(normalizeChildrenCount('NA').value).toBe('');
        expect(normalizeChildrenCount('   ').value).toBe('');
        expect(normalizeChildrenCount(undefined).value).toBe('');
        expect(normalizeChildrenCount('مش متأكد').value).toBe('');
        expect(normalizeChildrenCount(3).value).toBe(3);
    });

    it('strips currency words and separators, rounds to 2 places', () => {
        expect(normalizePrice('300 ج').value).toBe(300);
        expect(normalizePrice('300 جنيه').value).toBe(300);
        expect(normalizePrice('1,500').value).toBe(1500);
        expect(normalizePrice('١٢٠٠٫٥').value).toBe(1200.5);
        expect(normalizePrice('L.E 200').value).toBe(200);
        expect(normalizePrice('19.999').value).toBe(20);
        expect(normalizePrice('-0').value).toBe(0); // never negative zero
    });

    it('flags unparseable and negative prices', () => {
        expect(normalizePrice('abc')).toMatchObject({ value: null });
        expect(codes(normalizePrice('abc'))).toEqual(['VALUE_NOT_IN_SOURCE']);
        expect(codes(normalizePrice('-100'))).toEqual(['PRICE_RANGE']);
    });
});

describe('free text and notes', () => {
    it('keeps line breaks, collapses runs of spaces, strips controls', () => {
        expect(normalizeFreeText('a\u0000b\n  c\t d').value).toBe('ab\nc d');
        expect(normalizeNotes(['a', ' a ', 'b', 'a', '', '—']).value).toEqual(['a', 'b']);
        expect(normalizeNotes('').value).toEqual([]);
    });

    it('normalizes CRLF, accepts a single note string and empty input', () => {
        expect(normalizeFreeText('سطر واحد\r\nسطر اثنان').value).toBe('سطر واحد\nسطر اثنان');
        expect(normalizeFreeText(undefined).value).toBe('');
        expect(normalizeNotes('ملاحظة').value).toEqual(['ملاحظة']);
        expect(normalizeNotes(null).value).toEqual([]);
    });
});

describe('hasPartialNameHint', () => {
    it('detects both wordings and ignores text without tokens', () => {
        expect(hasPartialNameHint('باقي الاسم مش معايا')).toBe(true);
        expect(hasPartialNameHint('the rest of the name is missing')).toBe(true);
        expect(hasPartialNameHint('أحمد زكي')).toBe(false);
        expect(hasPartialNameHint('!!')).toBe(false);
    });
});

describe('normalizeEnum', () => {
    it('treats empty tokens and empty text as empty', () => {
        expect(normalizeEnum('—', { enumName: 'maritalStatus' }).value).toBe('');
        expect(normalizeEnum('', { enumName: 'maritalStatus' }).value).toBe('');
        expect(normalizeEnum(null, { enumName: 'maritalStatus' }).value).toBe('');
    });
});

describe('normalizeField (dispatcher)', () => {
    it('binds enum issues to the registry field and keeps the raw hint', () => {
        const field = fieldByKey('follower');
        const result = normalizeField(field, 'dr amr', { today: TODAY, snapshot: ENUM_SNAPSHOT });
        expect(result.value).toBe('');
        expect(result.issues[0]).toMatchObject({ code: 'ENUM_UNMATCHED', field: 'follower' });
        expect(result.issues[0].detail.raw).toBe('dr amr');
    });

    it('maps a fuzzy enum value and flags it', () => {
        const field = fieldByKey('governorate');
        const result = normalizeField(field, 'Dakahlya', { today: TODAY, snapshot: ENUM_SNAPSHOT });
        expect(result.value).toBe('Dakahlia');
        expect(result.issues[0]).toMatchObject({ code: 'ENUM_FUZZY', field: 'governorate' });
    });

    it('is idempotent for every normalizer (value-level)', () => {
        const cases = [
            ['name', 'Nour El-Din  '],
            ['national_id', '٢٩٩٠٣٢٢٠٢٠١٥٦٧'],
            ['mobile', '+20 111 234 5678'],
            ['date_of_birth', '23-12-85'],
            ['visit_date', '12/10/2026'],
            ['age', '35 سنة'],
            ['children_count', '3'],
            ['price', '300 ج'],
            ['address', 'طنطا'],
            ['notes', ['a', 'a', 'b']],
        ];
        for (const [key, raw] of cases) {
            const field = fieldByKey(key);
            const once = normalizeField(field, raw, { today: TODAY, snapshot: ENUM_SNAPSHOT });
            const twice = normalizeField(field, once.value, { today: TODAY, snapshot: ENUM_SNAPSHOT });
            expect(twice.value, key).toEqual(once.value);
        }
    });

    it('throws when a registry field points at an unknown normalizer', () => {
        expect(() => normalizeField({ key: 'x', normalize: 'nope' }, 'a', {})).toThrow(/nope/);
    });
});

describe('valueIsEmpty', () => {
    it('covers empty values of every shape', () => {
        expect(valueIsEmpty(undefined)).toBe(true);
        expect(valueIsEmpty(null)).toBe(true);
        expect(valueIsEmpty([])).toBe(true);
        expect(valueIsEmpty('  ')).toBe(true);
        expect(valueIsEmpty('x')).toBe(false);
        expect(valueIsEmpty(['x'])).toBe(false);
        expect(valueIsEmpty(0)).toBe(false);
    });
});
