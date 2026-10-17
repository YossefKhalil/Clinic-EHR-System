// Property tests (fast-check) over the import-core rules engine.
//
// These guard the invariants that must hold for every input, not just the
// golden fixture:
//   - canonicalization and folding are idempotent (a canonical value stays
//     canonical — grounding and stored values depend on it);
//   - normalizer output is stable under re-normalization (editing a value to
//     its normalized form must never change it again);
//   - snapping never touches a national ID that is present in the source;
//   - a decoded national ID always carries a real calendar date.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
    canonicalizeBlock,
    canonicalizeText,
    foldForMatch,
} from '@import-core/canonicalize.js';
import {
    decodeNationalId,
    isRealDate,
    normalizeFreeText,
    normalizeMobile,
    normalizeName,
    normalizeNationalId,
    normalizePrice,
} from '@import-core/normalizers.js';
import { digitsGrounded, snapToSource } from '@import-core/verify.js';

const NUM_RUNS = 300;

/** Strings built from a fixed character palette. */
const fromChars = (chars, maxLength = 40) => fc
    .array(fc.constantFrom(...chars), { maxLength })
    .map((parts) => parts.join(''));

// Characters that exercise every canonicalization branch: Arabic letter
// variants, diacritics, tatweel, Arabic-Indic digits and separators,
// invisibles, punctuation, whitespace and line breaks.
const MESSY_CHARS = [...'أإآاةىيؤئءَُّـ٠١٢٩٥ abcXYZ0123.,;:-—\u200B\u202E\uFEFF،٬٫؟!\n\t'];
const DIGIT_FRAGMENTS = ['0', '1', '2', '5', '9', '+', '-', ' ', '(', ')', '.', ',', '٢', '٠', '٥', 'O', 'x', 'ج'];

const messyText = fromChars(MESSY_CHARS);
const digitText = fromChars(DIGIT_FRAGMENTS);

const digits14 = fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 14, maxLength: 14 })
    .map((digits) => digits.join(''));

describe('canonicalization properties', () => {
    it('canonical text is idempotent (removing invisibles before NFC)', () => {
        fc.assert(fc.property(messyText, (text) => {
            const canonical = canonicalizeText(text);
            expect(canonicalizeText(canonical)).toBe(canonical);
        }), { numRuns: NUM_RUNS });

        // Plain unicode/ASCII, from fast-check's grapheme generator.
        fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (text) => {
            const canonical = canonicalizeText(text);
            expect(canonicalizeText(canonical)).toBe(canonical);
        }), { numRuns: NUM_RUNS });
    });

    it('block canonicalization is idempotent', () => {
        fc.assert(fc.property(messyText, (text) => {
            const block = canonicalizeBlock(text);
            expect(canonicalizeBlock(block)).toBe(block);
        }), { numRuns: NUM_RUNS });
    });

    it('matching folds are idempotent', () => {
        fc.assert(fc.property(messyText, (text) => {
            const folded = foldForMatch(text);
            expect(foldForMatch(folded)).toBe(folded);
        }), { numRuns: NUM_RUNS });

        fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (text) => {
            const folded = foldForMatch(text);
            expect(foldForMatch(folded)).toBe(folded);
        }), { numRuns: NUM_RUNS });
    });

    it('composes across removed zero-width characters', () => {
        // Without the removal-before-NFC order this stays "e◌́" and a second
        // canonicalization pass would change it.
        expect(canonicalizeText('e\u200B\u0301')).toBe('\u00E9');
    });
});

describe('normalizer idempotence', () => {
    it('mobile values are stable under re-normalization', () => {
        fc.assert(fc.property(digitText, (raw) => {
            const once = normalizeMobile(raw).value;
            expect(normalizeMobile(once).value).toBe(once);
        }), { numRuns: NUM_RUNS });
    });

    it('national IDs are stable under re-normalization', () => {
        fc.assert(fc.property(digitText, (raw) => {
            const once = normalizeNationalId(raw).value;
            expect(normalizeNationalId(once).value).toBe(once);
        }), { numRuns: NUM_RUNS });
    });

    it('names and free text are stable under re-normalization', () => {
        fc.assert(fc.property(messyText, (raw) => {
            const name = normalizeName(raw).value;
            expect(normalizeName(name).value).toBe(name);
            const text = normalizeFreeText(raw).value;
            expect(normalizeFreeText(text).value).toBe(text);
        }), { numRuns: NUM_RUNS });
    });

    it('prices are stable under re-normalization', () => {
        const priceText = fromChars(DIGIT_FRAGMENTS, 12);
        fc.assert(fc.property(priceText, (raw) => {
            const once = normalizePrice(raw);
            if (typeof once.value !== 'number') return;
            expect(normalizePrice(once.value).value).toBe(once.value);
        }), { numRuns: NUM_RUNS });
    });

    it('cleans chained O-as-zero neighbours in one pass', () => {
        expect(normalizeMobile('1OO').value).toBe('100');
        expect(normalizeNationalId('29805151201O3O').value).toBe('29805151201030');
    });
});

describe('snapping and decoding properties', () => {
    it('a 14-digit value written in the source is never snapped', () => {
        const spec = { min: 14, max: 14, maxEditDistance: 2 };
        fc.assert(fc.property(digits14, (id) => {
            expect(digitsGrounded(id, [`الرقم القومي ${id}`])).toBe(true);
            expect(snapToSource(spec, id, [`الرقم القومي ${id}`])).toBeNull();
        }), { numRuns: NUM_RUNS });
    });

    it('decoded national IDs always carry a real calendar date', () => {
        fc.assert(fc.property(digits14, (id) => {
            const decoded = decodeNationalId(id);
            if (!decoded) return;
            const [year, month, day] = decoded.date.split('-').map(Number);
            expect(year).toBeGreaterThanOrEqual(1900);
            expect(year).toBeLessThanOrEqual(2099);
            expect(isRealDate(year, month, day)).toBe(true);
        }), { numRuns: NUM_RUNS });
    });

    it('a constructed valid ID round-trips to its written date', () => {
        const pad2 = (value) => String(value).padStart(2, '0');
        const idArb = fc.record({
            century: fc.constantFrom('2', '3'),
            yy: fc.integer({ min: 0, max: 99 }),
            month: fc.integer({ min: 1, max: 12 }),
            day: fc.integer({ min: 1, max: 28 }),
            tail: fc.stringMatching(/^\d{5}$/),
        }).map(({ century, yy, month, day, tail }) => (
            `${century}${pad2(yy)}${pad2(month)}${pad2(day)}12${tail}`
        ));

        fc.assert(fc.property(idArb, (id) => {
            const century = id[0] === '2' ? 1900 : 2000;
            const decoded = decodeNationalId(id);
            expect(decoded).not.toBeNull();
            expect(decoded.date)
                .toBe(`${century + Number(id.slice(1, 3))}-${id.slice(3, 5)}-${id.slice(5, 7)}`);
            expect(decoded.governorateCode).toBe('12');
        }), { numRuns: NUM_RUNS });
    });
});
