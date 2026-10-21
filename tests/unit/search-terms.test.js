// The search that understands both languages.
//
// The rows carry the English name of the governorate and the key of an
// option; the people type the Arabic name. The terms of a search are
// expanded into the words that mean the same thing, so both are found.

import { describe, expect, it } from 'vitest';
import {
    buildSearchDictionary, searchTermVariants, maritalStatusLabel,
} from '../../src/services/search-terms.js';

const options = {
    follower: [{ key: 'ahmed', label_ar: 'أحمد', label_en: 'Ahmed' }],
    section: [{ key: 'agamy', label_ar: 'أعمى', label_en: 'Agamy' }],
    source: [{ key: 'charity', label_ar: 'جمعيات', label_en: 'Charity' }],
};

describe('the dictionary of the search', () => {
    it('holds the governorates, the marital status and the options', () => {
        const pairs = buildSearchDictionary(options);
        const find = (value) => pairs.find((pair) => pair.value === value);

        expect(find('Cairo')?.ar).toBe('القاهرة');
        expect(find('Alexandria')?.ar).toBe('الإسكندرية');
        expect(find('Qena')?.ar).toBe('قنا');
        expect(find('married')?.ar).toBeTruthy();
        expect(find('ahmed')?.ar).toBe('أحمد');
        expect(find('agamy')?.ar).toBe('أعمى');
    });

    it('works without the options of the clinic', () => {
        const pairs = buildSearchDictionary();
        expect(pairs.some((pair) => pair.value === 'Cairo')).toBe(true);
    });
});

describe('the terms of a search', () => {
    const dictionary = buildSearchDictionary(options);

    it('keeps the word that was typed', () => {
        expect(searchTermVariants('مريض', dictionary)).toEqual(['مريض']);
    });

    it('adds the stored name of an option behind its Arabic label', () => {
        expect(searchTermVariants('أحمد', dictionary)).toContain('ahmed');
    });

    it('finds the stored name of a governorate behind the Arabic one', () => {
        expect(searchTermVariants('القاهرة', dictionary)).toContain('Cairo');
    });

    it('finds the Arabic name behind the stored one', () => {
        expect(searchTermVariants('Cairo', dictionary)).toContain('القاهرة');
    });

    it('looks inside a longer text', () => {
        const terms = searchTermVariants(' paciente in القاهرة', dictionary);
        expect(terms).toContain('Cairo');
    });

    it('does not need the stored name when the term already is it', () => {
        // "Minya" is the name that is stored: the term finds the row as it
        // is, and the Arabic name is added for the free text of the row.
        const terms = searchTermVariants('minya', dictionary);
        expect(terms).toContain('minya');
        expect(terms).toContain('المنيا');
    });

    it('is empty for an empty term', () => {
        expect(searchTermVariants('   ', dictionary)).toEqual([]);
    });
});

describe('the name of a marital status', () => {
    it('is the Arabic word', () => {
        expect(maritalStatusLabel('married')).toBeTruthy();
        expect(maritalStatusLabel('single')).toBeTruthy();
    });

    it('is empty for a value that is not known', () => {
        expect(maritalStatusLabel('unknown')).toBe('');
        expect(maritalStatusLabel('')).toBe('');
    });
});
