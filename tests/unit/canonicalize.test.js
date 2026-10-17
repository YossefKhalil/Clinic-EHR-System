import { describe, expect, it } from 'vitest';
import {
    EMPTY_TOKENS,
    canonicalizeBlock,
    canonicalizeText,
    collapseSpaces,
    digitRuns,
    foldForMatch,
    foldTokens,
    isEmptyToken,
    mergedDigitRuns,
    stripLeadingAl,
    toWesternDigits,
} from '@import-core/canonicalize.js';

describe('canonicalize', () => {
    it('converts Arabic-Indic and Persian digits (and nothing else)', () => {
        expect(toWesternDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
        expect(toWesternDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
        expect(toWesternDigits('مريض ١٢')).toBe('مريض 12');
        expect(toWesternDigits('29805151201234')).toBe('29805151201234');
    });

    it('removes invisible characters and maps Arabic separators', () => {
        expect(canonicalizeText('a\u200Bb\u202Ec\uFEFFd')).toBe('abcd');
        expect(canonicalizeText('3،5')).toBe('3,5');
        expect(canonicalizeText('1٬500')).toBe('1,500');
        expect(canonicalizeText('2٫5')).toBe('2.5');
        // Letters are never altered by canonicalization (folding is match-only).
        expect(canonicalizeText('أحمد')).toBe('أحمد');
    });

    it('canonicalizes blocks while keeping line structure', () => {
        expect(canonicalizeBlock('مريض ١٢  -  القاهرة\n\n\n\nسطر'))
            .toBe('مريض 12 - القاهرة\n\nسطر');
        expect(canonicalizeBlock('a   b\tc')).toBe('a b c');
    });

    it('folds letters for matching: diacritics, tatweel, variants, case', () => {
        expect(foldForMatch('أحمد')).toBe('احمد');
        expect(foldForMatch('إبراهيم')).toBe('ابراهيم');
        expect(foldForMatch('مُحَمَّد')).toBe('محمد');
        expect(foldForMatch('مـحمد')).toBe('محمد');
        expect(foldForMatch('فاطمة')).toBe('فاطمه');
        expect(foldForMatch('مصطفى')).toBe('مصطفي');
        expect(foldForMatch('Dr. Hala')).toBe('dr hala');
        expect(foldForMatch('Nour El-Din')).toBe('nour el din');
        expect(foldTokens('Dr. Hala')).toEqual(['dr', 'hala']);
        expect(foldTokens('')).toEqual([]);
    });

    it('strips a single leading definite article', () => {
        expect(stripLeadingAl('القاهره')).toBe('قاهره');
        expect(stripLeadingAl('الدقهليه')).toBe('دقهليه');
        expect(stripLeadingAl('ال')).toBe('ال');
        expect(stripLeadingAl('بلا')).toBe('بلا');
    });

    it('treats exactly the Appendix C.5 tokens as empty', () => {
        for (const token of ['null', 'None', 'n/a', 'NA', 'nil', '-', '--', '—', '?', 'لا يوجد', 'غير معروف']) {
            expect(isEmptyToken(token), token).toBe(true);
        }
        // Only whole-value matches count.
        expect(isEmptyToken('allergic to aspirin ??')).toBe(false);
        expect(isEmptyToken('')).toBe(false);
        expect(EMPTY_TOKENS).toContain('مش معروف');
    });

    it('finds digit runs, with and without in-number separators', () => {
        expect(digitRuns('مريض 1: 29805151201234')).toEqual(['1', '29805151201234']);
        expect(digitRuns('٢٩٩٠٣٢٢٠٢٠١٥٦٧')).toEqual(['29903220201567']);
        expect(mergedDigitRuns('01234 56789')).toEqual(['0123456789']);
        expect(mergedDigitRuns('0111-222-3344')).toEqual(['01112223344']);
        expect(mergedDigitRuns('015.123.45670')).toEqual(['01512345670']);
        // A single separator between digits merges; letters never join numbers.
        expect(mergedDigitRuns('ج 300')).toEqual(['300']);
        expect(mergedDigitRuns('12 - 15')).toEqual(['12', '15']);
        // Newlines never merge numbers from different lines.
        expect(mergedDigitRuns('100\n200')).toEqual(['100', '200']);
    });

    it('collapses spaces without touching other content', () => {
        expect(collapseSpaces('  a \t b  ')).toBe('a b');
        expect(collapseSpaces('a\nb')).toBe('a\nb');
    });
});
