// Canonicalization (spec §5.5) and matching-only folding.
//
// Canonicalization produces the derived text that is sent to the LLM and used
// by the verifier. The ORIGINAL line is always kept for display.
// Folding is used only in matching (grounding, enums, dedupe) and never in a
// stored value.

// Invisible characters: zero-width and bidi controls.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// Arabic-Indic (U+0660–U+0669) and Persian/Urdu (U+06F0–U+06F9) digits.
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669]/g;
const PERSIAN_DIGITS = /[\u06F0-\u06F9]/g;

// Arabic separators: comma ،, decimal ٫, thousands ٬.
const ARABIC_COMMA = /\u060C/g;
const ARABIC_DECIMAL = /\u066B/g;
const ARABIC_THOUSANDS = /\u066C/g;

// Diacritics (harakat) and tatweel — removed for matching only.
const DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g;

function arabicDigitValue(ch) {
    const code = ch.codePointAt(0);
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    return String(code - 0x06F0);
}

/** Arabic-Indic and Persian digits → Western digits. */
export function toWesternDigits(text) {
    return String(text ?? '')
        .replace(ARABIC_INDIC_DIGITS, arabicDigitValue)
        .replace(PERSIAN_DIGITS, arabicDigitValue);
}

/**
 * Canonical form of a source line: invisible characters removed, NFC,
 * digits Western, Arabic separators mapped to ASCII, whitespace collapsed.
 * Letters are NOT altered (no folding, no case changes).
 *
 * Invisibles are removed before NFC so a zero-width character between a base
 * letter and a combining mark cannot block composition.
 */
export function canonicalizeText(text) {
    return String(text ?? '')
        .replace(INVISIBLE, '')
        .normalize('NFC')
        .replace(ARABIC_COMMA, ',')
        .replace(ARABIC_DECIMAL, '.')
        .replace(ARABIC_THOUSANDS, ',');
}

/** Canonicalize a whole block while keeping line structure. */
export function canonicalizeBlock(text) {
    const withDigits = toWesternDigits(canonicalizeText(text));
    return withDigits
        .split('\n')
        .map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
}

/**
 * Matching-only fold: lowercase, diacritics and tatweel removed, letter
 * variants unified (أ إ آ → ا, ى → ي, ة → ه, ؤ → و, ئ → ي), punctuation
 * removed, digits Western, whitespace collapsed.
 */
export function foldForMatch(text) {
    return toWesternDigits(String(text ?? '').replace(INVISIBLE, '').normalize('NFC'))
        .replace(INVISIBLE, '')
        .toLowerCase()
        .replace(DIACRITICS, '')
        .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627') // أ إ آ ٱ → ا
        .replace(/\u0649/g, '\u064A') // ى → ي
        .replace(/\u0629/g, '\u0647') // ة → ه
        .replace(/\u0624/g, '\u0648') // ؤ → و
        .replace(/\u0626/g, '\u064A') // ئ → ي
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Folded tokens of a text, for token-level grounding. */
export function foldTokens(text) {
    const folded = foldForMatch(text);
    return folded ? folded.split(' ') : [];
}

/**
 * Remove a single leading definite article (ال) from one folded token — used
 * by the enum engine's "also try with a leading ال removed" rule (§8.3).
 */
export function stripLeadingAl(folded) {
    return folded.startsWith('\u0627\u0644') && folded.length > 2
        ? folded.slice(2)
        : folded;
}

/** Whole-value empty tokens (Appendix C.5). Only exact matches count. */
export const EMPTY_TOKENS = Object.freeze([
    'null', 'none', 'n/a', 'na', 'nil', '-', '--', '\u2014', '?',
    '\u0644\u0627 \u064A\u0648\u062C\u062F', // لا يوجد
    '\u0644\u0627 \u0634\u064A\u0621', // لا شيء
    '\u063A\u064A\u0631 \u0645\u0639\u0631\u0648\u0641', // غير معروف
    '\u063A\u064A\u0631 \u0645\u0630\u0643\u0648\u0631', // غير مذكور
    '\u0645\u0634 \u0645\u0639\u0631\u0648\u0641', // مش معروف
]);

/** True when the whole value is one of the "empty" tokens. */
export function isEmptyToken(raw) {
    // An actually-empty value is not a "token": emptiness is decided by the
    // caller's own trim check, not here.
    const text = toWesternDigits(String(raw ?? '').normalize('NFC')).trim();
    if (!text) return false;
    const folded = foldForMatch(text);
    return EMPTY_TOKENS.some((token) => foldForMatch(token) === folded);
}

/** All contiguous digit runs in a text (after canonicalization). */
export function digitRuns(text) {
    const canonical = toWesternDigits(String(text ?? ''));
    return canonical.match(/\d+/g) || [];
}

// Characters that may sit *between* digits inside one number: space, dash,
// dot, parentheses. Used to merge "01234 56789" and "0111-222-3344".
// Only a single space/tab is merged — never a newline — so grounding cannot
// join numbers from different lines.
const BETWEEN_DIGITS = /(?<=\d)[ \t\-\u2010-\u2015.()\u060C,](?=\d)/g;

/**
 * Digit runs with in-number separators removed. `01234 56789` becomes one run
 * `0123456789`; `ج 300` is unaffected because the separator is not between two
 * digits. Commas are included because Arabic thousands separators were mapped
 * to `,` by canonicalization.
 */
export function mergedDigitRuns(text) {
    const canonical = toWesternDigits(String(text ?? ''));
    return canonical.replace(BETWEEN_DIGITS, '').match(/\d+/g) || [];
}

/** Collapse runs of spaces/tabs and trim — for normalizer output. */
export function collapseSpaces(text) {
    return String(text ?? '').replace(/[ \t\u00A0]+/g, ' ').trim();
}
