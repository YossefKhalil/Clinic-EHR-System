// The words that mean the same thing.
//
// The app stores the English name of a governorate and the key of an option
// (a follower, a section, a source of money), but the people who type in the
// search box write the Arabic name. So a search term is expanded into the
// words that mean the same thing and every one of them is looked for: a
// search for "القاهرة" finds the patients whose governorate is stored as
// "Cairo", and a search for "Cairo" finds them too.

import { GOVERNORATES, MARITAL_STATUS } from '@import-core/enums.js';
import { normalizeText } from './fuzzy.js';

const ARABIC = /[\u0600-\u06ff]/;

/**
 * The pairs of words that mean the same thing: the value that is stored in
 * the row and the name that the people read.
 *
 * The options (follower, section, source of money) come from the app, the
 * governorates and the marital status from the import tables.
 */
export function buildSearchDictionary(options = {}) {
    const pairs = [];

    for (const entry of GOVERNORATES) {
        if (entry?.value && entry?.ar) pairs.push({ value: entry.value, ar: entry.ar });
    }

    for (const entry of MARITAL_STATUS) {
        const ar = (entry.aliases || []).find((alias) => ARABIC.test(alias));
        if (entry?.value && ar) pairs.push({ value: entry.value, ar });
    }

    for (const kind of ['follower', 'section', 'source']) {
        for (const option of options[kind] || []) {
            if (option?.key && option?.label_ar) {
                pairs.push({ value: option.key, ar: option.label_ar });
            }
        }
    }

    return pairs;
}

/**
 * The terms a search runs with: the term itself and every word that means
 * the same thing.
 */
export function searchTermVariants(term, dictionary = []) {
    const text = String(term || '').trim();
    if (!text) return [];

    const variants = [text];
    const needle = normalizeText(text);

    for (const pair of dictionary) {
        const ar = normalizeText(pair.ar);
        const value = normalizeText(pair.value);
        // The Arabic name inside the term -> the value that is stored.
        if (ar.length >= 3 && needle.includes(ar) && !variants.includes(pair.value)) {
            variants.push(pair.value);
        }
        // The stored value inside the term -> the Arabic name.
        if (value.length >= 4 && needle.includes(value) && !variants.includes(pair.ar)) {
            variants.push(pair.ar);
        }
    }

    return variants;
}

/** The Arabic name of a marital status (the app stores 'married' and so on). */
export function maritalStatusLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    const entry = MARITAL_STATUS.find((item) => item.value === key);
    if (!entry) return '';
    return (entry.aliases || []).find((alias) => ARABIC.test(alias)) || '';
}
