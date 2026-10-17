import { describe, expect, it } from 'vitest';
import {
    BORN_ABROAD_ID_CODE,
    GOVERNORATE_BY_ID_CODE,
    GOVERNORATES,
    MARITAL_STATUS,
    damerauLevenshtein,
    enumCandidates,
    fuzzyBudget,
    matchEnum,
    monthFromName,
} from '@import-core/enums.js';

const governorates = enumCandidates('governorate');
const marital = enumCandidates('maritalStatus');

describe('enum engine', () => {
    it('matches exact labels and aliases silently, with or without a leading ال', () => {
        expect(matchEnum('Cairo', governorates)).toMatchObject({ value: 'Cairo', fuzzy: false });
        expect(matchEnum('الإسكندرية', governorates)).toMatchObject({ value: 'Alexandria', fuzzy: false });
        expect(matchEnum('الاسكندرية', governorates)).toMatchObject({ value: 'Alexandria', fuzzy: false });
        expect(matchEnum('اسكندرية', governorates)).toMatchObject({ value: 'Alexandria', fuzzy: false });
        expect(matchEnum('متجوز', marital)).toMatchObject({ value: 'married', fuzzy: false });
        expect(matchEnum('single', marital)).toMatchObject({ value: 'single', fuzzy: false });
        expect(matchEnum('عزباء', marital)).toMatchObject({ value: 'single', fuzzy: false });
    });

    it('applies a unique fuzzy match and flags it', () => {
        expect(matchEnum('Dakahlya', governorates)).toMatchObject({
            value: 'Dakahlia', fuzzy: true, matchedLabel: 'dakahlia',
        });
        expect(matchEnum('القاهره', governorates)).toMatchObject({ value: 'Cairo', fuzzy: false });
    });

    it('refuses to guess when two candidates are equally close', () => {
        const candidates = [
            { value: 'one', labels: ['abcd'] },
            { value: 'two', labels: ['abce'] },
        ];
        expect(matchEnum('abcf', candidates)).toMatchObject({ value: '', fuzzy: false });
    });

    it('never fuzzes very short values and never matches empty text', () => {
        expect(matchEnum('abx', [{ value: 'x', labels: ['abc'] }])).toMatchObject({ value: '' });
        expect(matchEnum('', governorates)).toMatchObject({ value: '' });
        expect(matchEnum('غير معروف', governorates)).toMatchObject({ value: '' });
    });

    it('maps governorate-of-birth ID codes and knows code 88 is born abroad', () => {
        expect(GOVERNORATE_BY_ID_CODE['01']).toBe('Cairo');
        expect(GOVERNORATE_BY_ID_CODE['02']).toBe('Alexandria');
        expect(GOVERNORATE_BY_ID_CODE['35']).toBe('South Sinai');
        expect(GOVERNORATE_BY_ID_CODE[BORN_ABROAD_ID_CODE]).toBeUndefined();
        expect(GOVERNORATES).toHaveLength(27);
        expect(GOVERNORATES.filter((entry) => entry.value === 'Matrouh')).toHaveLength(1);
    });

    it('resolves month names in Egyptian, Levantine and English (Appendix C.3)', () => {
        expect(monthFromName('مارس')).toBe(3);
        expect(monthFromName('Mar')).toBe(3);
        expect(monthFromName('Oct.')).toBe(10);
        expect(monthFromName('كانون الأول')).toBe(12);
        expect(monthFromName('حزيران')).toBe(6);
        expect(monthFromName('شباط')).toBe(2);
        expect(monthFromName('nonsense')).toBeNull();
    });

    it('builds candidate lists from the app_options snapshot', () => {
        const snapshot = {
            follower: [{ key: 'hala', label_en: 'Dr. Hala', label_ar: 'د. هالة' }],
            sourceOfMoney: [{ key: 'insurance', label_en: 'Insurance', label_ar: 'تأمين' }],
        };
        expect(matchEnum('Dr. Hala', enumCandidates('follower', snapshot)))
            .toMatchObject({ value: 'hala', fuzzy: false });
        expect(matchEnum('د. هالة', enumCandidates('follower', snapshot)))
            .toMatchObject({ value: 'hala', fuzzy: false });
        expect(matchEnum('Insurance', enumCandidates('sourceOfMoney', snapshot)))
            .toMatchObject({ value: 'insurance', fuzzy: false });
        expect(() => enumCandidates('nope', snapshot)).toThrow(/Unknown enum source/);
    });

    it('computes Damerau-Levenshtein distance with a cap', () => {
        expect(damerauLevenshtein('', '')).toBe(0);
        expect(damerauLevenshtein('abc', 'abc')).toBe(0);
        expect(damerauLevenshtein('ab', 'ba')).toBe(1); // transposition
        expect(damerauLevenshtein('abc', 'abcd')).toBe(1);
        expect(damerauLevenshtein('abc', 'axc')).toBe(1);
        expect(damerauLevenshtein('abcd', 'wxyz', 2)).toBe(3); // capped at max + 1
        expect(damerauLevenshtein('abcd', 'wxyz')).toBe(4);
    });

    it('scales the fuzzy budget with length (4–7 → 1, 8+ → 2, shorter → 0)', () => {
        expect(fuzzyBudget('abc')).toBe(0);
        expect(fuzzyBudget('abcd')).toBe(1);
        expect(fuzzyBudget('abcdefg')).toBe(1);
        expect(fuzzyBudget('abcdefgh')).toBe(2);
    });

    it('knows all four marital statuses', () => {
        expect(MARITAL_STATUS.map((entry) => entry.value)).toEqual(['single', 'married', 'divorced', 'widowed']);
    });
});
