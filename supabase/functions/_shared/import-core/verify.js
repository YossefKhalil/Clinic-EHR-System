// Verification against the source (spec §8.2), misplaced-value repair (step 5),
// derivations and cross-checks (step 6), and reconciliation (8.2.4).
//
// Invariant I2 — the source wins: every value must be found in the cited
// lines. If it is not, the value is snapped to a close source candidate (and
// flagged) or blanked (and flagged). Nothing is silently discarded.

import {
    digitRuns, foldForMatch, foldTokens, mergedDigitRuns,
    canonicalizeText, toWesternDigits,
} from './canonicalize.js';
import { MONTHS, damerauLevenshtein } from './enums.js';
import { fieldByKey } from './field-registry.js';
import { issue } from './issues.js';
import { LIMITS } from './limits.js';
import {
    ageFromDob, decodeNationalId, hasPartialNameHint,
    normalizeField, normalizeMobile, toIso,
} from './normalizers.js';

// ---------------------------------------------------------------------------
// _src resolution (spec §8.2.1)
// ---------------------------------------------------------------------------

const SRC_REF = /^(?<prefix>[^:]+):(?<letters>[A-Za-z]*)(?<from>\d+)(?:-(?<toLetters>[A-Za-z]*)(?<to>\d+))?$/;

/**
 * Expand one `_src` value into concrete line ids.
 * Accepts "S1:L014-L016", "S1:R12", "L014", lists and comma/space separations.
 *
 * @param {unknown} srcValue
 * @param {string} sourceId default prefix when a ref has none
 * @returns {string[]}
 */
export function parseSrcRefs(srcValue, sourceId = 'S1') {
    const parts = (Array.isArray(srcValue) ? srcValue : [srcValue])
        .flatMap((entry) => String(entry ?? '').split(/[,;\s]+/))
        .map((entry) => entry.trim())
        .filter(Boolean);

    const ids = [];
    for (const part of parts) {
        const withPrefix = part.includes(':') ? part : `${sourceId}:${part}`;
        const match = withPrefix.match(SRC_REF);
        if (!match) {
            ids.push(withPrefix);
            continue;
        }
        const { prefix, letters, from, toLetters, to } = match.groups;
        if (to === undefined) {
            ids.push(`${prefix}:${letters}${from}`);
            continue;
        }
        const start = Number(from);
        const end = Number(to);
        const letterSet = toLetters || letters;
        if (letterSet !== letters || end < start || end - start > 500) {
            ids.push(`${prefix}:${letters}${from}`, `${prefix}:${letterSet}${to}`);
            continue;
        }
        const width = Math.max(from.length, to.length);
        for (let n = start; n <= end; n += 1) {
            ids.push(`${prefix}:${letters}${String(n).padStart(width, '0')}`);
        }
    }
    return [...new Set(ids)];
}

/**
 * Resolve `_src` to existing lines. Returns `{ ids, valid }` where `valid`
 * is false when the citation is missing or points to unknown lines.
 */
export function resolveSrc(srcValue, { sourceId = 'S1', linesById }) {
    if (srcValue === null || srcValue === undefined || String(srcValue).trim() === '') {
        return { ids: [], valid: false };
    }
    const ids = parseSrcRefs(srcValue, sourceId);
    const valid = ids.length > 0 && ids.every((id) => linesById.has(id));
    return { ids, valid };
}

// ---------------------------------------------------------------------------
// Grounding (spec §8.2.2)
// ---------------------------------------------------------------------------

const DIGIT_FIELDS = ['national_id', 'mobile', 'price', 'age', 'children_count'];
const DATE_FIELDS = ['date_of_birth', 'visit_date'];
const NAME_FIELDS = ['name'];
// Everything else is free text.

/** Digit string of a normalized value. */
function valueDigits(value) {
    return toWesternDigits(String(value ?? '')).replace(/\D/g, '');
}

/** The value's digits appear (as a substring) of a merged digit run. */
export function digitsGrounded(value, texts) {
    const digits = valueDigits(value);
    if (!digits) return true;
    return texts.some((text) => mergedDigitRuns(text).some((run) => run.includes(digits)));
}

/** Every folded name token appears in at least one text. */
export function nameGrounded(value, texts) {
    const tokens = foldTokens(value);
    if (!tokens.length) return true;
    const foldedTexts = texts.map((text) => foldForMatch(text));
    return tokens.every((token) => foldedTexts.some((text) => text.includes(token)));
}

function numericTokenSet(texts) {
    const tokens = new Set();
    for (const text of texts) {
        for (const run of digitRuns(text)) tokens.add(run);
    }
    return tokens;
}

function monthNameGrounded(value, texts) {
    const folded = foldForMatch(value);
    for (const [label, month] of Object.entries(MONTHS)) {
        const foldedLabel = foldForMatch(label);
        if (folded.includes(foldedLabel) && month > 0) {
            if (texts.some((text) => foldForMatch(text).includes(foldedLabel))) return true;
        }
    }
    return false;
}

/**
 * Dates: each numeric group of the ISO value must appear as its own token in
 * the source, or the raw writing must be found token by token (two-digit
 * years), or the month was written as a name present in the source.
 */
export function dateGrounded(isoValue, rawValue, texts) {
    if (!isoValue) return true;
    const match = String(isoValue).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const tokens = numericTokenSet(texts);
    const [, year, month, day] = match;
    const isoTokenHit = tokens.has(year)
        && (tokens.has(month) || tokens.has(String(Number(month))))
        && (tokens.has(day) || tokens.has(String(Number(day))));
    if (isoTokenHit) return true;

    const rawTokens = digitRuns(rawValue);
    const rawHit = rawTokens.length > 0 && rawTokens.every((token) => tokens.has(token));
    if (rawHit) return true;

    return monthNameGrounded(rawValue, texts);
}

/** Free text: at least GROUNDING_TEXT_THRESHOLD of folded tokens appear. */
export function textGrounded(value, texts) {
    const tokens = foldTokens(value);
    if (!tokens.length) return true;
    const foldedTexts = texts.map((text) => foldForMatch(text));
    const found = tokens.filter((token) => foldedTexts.some((text) => text.includes(token))).length;
    return found / tokens.length >= LIMITS.GROUNDING_TEXT_THRESHOLD;
}

/** Tokens of the value that were NOT found in the texts (for issue details). */
export function missingTokens(value, texts) {
    const foldedTexts = texts.map((text) => foldForMatch(text));
    return foldTokens(value).filter((token) => !foldedTexts.some((text) => text.includes(token)));
}

/**
 * Is a single cell's value grounded in the given texts?
 *
 * For digit-bearing fields the model's raw text counts too: normalization may
 * add a leading 0 to a mobile or read an `O` adjacent to digits as `0`, and
 * it is still the model's value that must be found (spec §8.2.2). Lists
 * (notes) are grounded entry by entry.
 *
 * @returns {boolean}
 */
export function isGrounded(fieldKey, value, raw, texts) {
    if (Array.isArray(value)) {
        if (!value.length) return true;
        return value.every((entry) => textGrounded(entry, texts));
    }
    const field = fieldByKey(fieldKey);
    if (field?.normalize === 'enumMatch') {
        // The cell holds the mapped code; the source can only contain the raw
        // text the model saw ("enum raw text", spec §8.2.2).
        return textGrounded(raw || value, texts);
    }
    if (DIGIT_FIELDS.includes(fieldKey)) {
        if (digitsGrounded(value ?? raw, texts)) return true;
        const isDistinctRaw = raw !== undefined && raw !== null && String(raw) !== String(value ?? '');
        return isDistinctRaw ? digitsGrounded(raw, texts) : false;
    }
    if (DATE_FIELDS.includes(fieldKey)) return dateGrounded(value, raw, texts);
    if (NAME_FIELDS.includes(fieldKey)) return nameGrounded(value || raw, texts);
    return textGrounded(value || raw, texts);
}

/**
 * Find snapping candidates for a digit field inside the source texts.
 * Candidates are raw digit runs within [min, max] length.
 */
export function snapCandidates(texts, { min, max }) {
    const candidates = new Set();
    for (const text of texts) {
        for (const run of digitRuns(canonicalizeText(text))) {
            if (run.length >= min && run.length <= max) candidates.add(run);
        }
    }
    return [...candidates];
}

/**
 * Snap a digit value to the unique closest source candidate.
 * @returns {{candidate: string, distance: number}|null}
 */
export function findSnap(candidates, value, maxDistance) {
    const digits = valueDigits(value);
    if (!digits) return null;
    let best = null;
    let bestCount = 0;
    for (const candidate of candidates) {
        const distance = damerauLevenshtein(digits, candidate, maxDistance);
        if (distance > maxDistance) continue;
        if (best === null || distance < best.distance) {
            best = { candidate, distance };
            bestCount = 1;
        } else if (distance === best.distance && candidate !== best.candidate) {
            bestCount += 1;
        }
    }
    if (best && bestCount === 1 && best.candidate !== digits) return best;
    return null;
}

/** Snapping does nothing when the value is already grounded (property). */
export function snapToSource(spec, value, texts) {
    const candidates = snapCandidates(texts, spec);
    return findSnap(candidates, value, spec.maxEditDistance);
}

// ---------------------------------------------------------------------------
// Misplaced-value repair (spec §8.1 step 5, §8.3)
// ---------------------------------------------------------------------------

/**
 * Move values that are obviously in the wrong cell. Operates on cells
 * ({ value, origin, raw }); returns updated cells, MOVED_FIELD issues and the
 * field keys whose value was replaced.
 */
export function repairMisplacedValues(cells) {
    const issues = [];
    const nid = cells.national_id;
    const mobile = cells.mobile;
    if (!nid || !mobile) return { cells, issues, changedFields: [] };

    const nidDigits = toWesternDigits(String(nid.value ?? '')).replace(/\D/g, '');

    // national_id holds something mobile-shaped, mobile empty.
    if (nid.value && !mobile.value) {
        const looksMobileish = (nidDigits.length >= 10 && nidDigits.length <= 12)
            || /[Oo]/.test(String(nid.value));
        if (looksMobileish) {
            const normalized = normalizeMobile(nid.raw ?? nid.value);
            if (!normalized.issues.length && normalized.value) {
                cells.mobile = { value: normalized.value, origin: nid.origin, raw: nid.raw };
                cells.national_id = { value: '', origin: nid.origin, raw: nid.raw };
                issues.push(issue('MOVED_FIELD', {
                    field: 'mobile', detail: { from: 'national_id', to: 'mobile', value: normalized.value },
                }));
                return { cells, issues, changedFields: ['national_id', 'mobile'] };
            }
        }
    }

    // mobile holds a 14-digit ID, national_id empty.
    if (mobile.value && !nid.value) {
        const mobileDigits = toWesternDigits(String(mobile.value)).replace(/\D/g, '');
        if (/^\d{14}$/.test(mobileDigits)) {
            cells.national_id = { value: mobileDigits, origin: mobile.origin, raw: mobile.raw };
            cells.mobile = { value: '', origin: mobile.origin, raw: mobile.raw };
            issues.push(issue('MOVED_FIELD', {
                field: 'national_id', detail: { from: 'mobile', to: 'national_id', value: mobileDigits },
            }));
            return { cells, issues, changedFields: ['national_id', 'mobile'] };
        }
    }
    return { cells, issues, changedFields: [] };
}

// ---------------------------------------------------------------------------
// Derivations and cross-checks (spec §8.1 step 6)
// ---------------------------------------------------------------------------

/**
 * Fill dob from the ID, age from the dob, and raise cross-check warnings.
 * Derived cells get `origin = 'derived'` and an info issue — a derived value
 * can never be mistaken for something written in the source.
 */
export function deriveFields(cells, { today }) {
    const issues = [];
    const nid = cells.national_id ? String(cells.national_id.value ?? '') : '';
    const decoded = decodeNationalId(nid);

    // DOB from the ID when empty.
    if (!cells.date_of_birth?.value && decoded?.date) {
        cells.date_of_birth = { value: decoded.date, origin: 'derived', raw: cells.date_of_birth?.raw ?? '' };
        issues.push(issue('DOB_DERIVED_FROM_NID', { field: 'date_of_birth' }));
    } else if (cells.date_of_birth?.value && decoded?.date && cells.date_of_birth.value !== decoded.date) {
        issues.push(issue('DOB_NID_MISMATCH', {
            field: 'date_of_birth', detail: { dob: cells.date_of_birth.value, nid: decoded.date },
        }));
    }

    // Age from the DOB when empty.
    const dob = cells.date_of_birth?.value || '';
    const currentAge = cells.age?.value;
    if ((currentAge === null || currentAge === undefined || currentAge === '') && dob) {
        const computed = ageFromDob(dob, today);
        if (computed !== null) {
            cells.age = { value: computed, origin: 'derived', raw: cells.age?.raw ?? '' };
            issues.push(issue('AGE_DERIVED', { field: 'age' }));
        }
    } else if (currentAge !== null && currentAge !== undefined && currentAge !== '' && dob) {
        const computed = ageFromDob(dob, today);
        if (computed !== null && Math.abs(Number(currentAge) - computed) > 1) {
            issues.push(issue('AGE_DOB_MISMATCH', {
                field: 'age', detail: { age: currentAge, dob, computed },
            }));
        }
    }

    // Visit before birth.
    const visit = cells.visit_date?.value || '';
    if (visit && dob && visit < dob) {
        issues.push(issue('DATE_RANGE', {
            field: 'visit_date', detail: { value: visit, reason: 'before_dob' },
        }));
    }

    return { cells, issues, decoded };
}

// ---------------------------------------------------------------------------
// Reconciliation (spec §8.2.4)
// ---------------------------------------------------------------------------

const ID_SHAPED = /\d{14}/;
const MOBILE_SHAPED = /(?:\+20|0020)?0?1[0125]\d{8}/;

/**
 * Find what the model missed.
 *
 * @param {{
 *   kind: 'sheet'|'text'|'image',
 *   lines: {id: string, text: string}[],
 *   dataLineIds?: string[],        // sheet data rows (every one must be cited)
 *   citedIds: Set<string>,         // lines cited by accepted or rejected records
 * }} input
 * @returns {{issues: object[], requeueSplit: boolean}}
 */
export function reconcileChunk({ kind, lines, dataLineIds = [], citedIds }) {
    const issues = [];

    if (kind === 'sheet') {
        let missing = 0;
        for (const lineId of dataLineIds) {
            if (!citedIds.has(lineId)) {
                missing += 1;
                issues.push(issue('ROW_MISSING', { detail: { lineId } }));
            }
        }
        const requeueSplit = dataLineIds.length > 0 && missing / dataLineIds.length >= 0.2;
        return { issues, requeueSplit };
    }

    for (const line of lines) {
        if (citedIds.has(line.id)) continue;
        const canonical = canonicalizeText(line.text);
        if (ID_SHAPED.test(toWesternDigits(canonical)) || MOBILE_SHAPED.test(toWesternDigits(canonical))) {
            issues.push(issue('POSSIBLE_MISSED_RECORD', {
                detail: { lineId: line.id, text: line.text },
            }));
        }
    }
    return { issues, requeueSplit: false };
}

// ---------------------------------------------------------------------------
// Prompt-injection detector (spec §7.6)
// ---------------------------------------------------------------------------

const INJECTION_PHRASES = [
    'ignore previous', 'ignore all previous', 'ignore the above',
    'system prompt', 'system message', 'you are now',
    '\u062A\u062C\u0627\u0647\u0644 \u0627\u0644\u062A\u0639\u0644\u064A\u0645\u0627\u062A', // تجاهل التعليمات
    '\u062A\u062C\u0627\u0647\u0644 \u0645\u0627 \u0633\u0628\u0642', // تجاهل ما سبق
    '\u0627\u062A\u0628\u0639 \u0627\u0644\u062A\u0639\u0644\u064A\u0645\u0627\u062A', // اتبع التعليمات
];

/** True when source text contains an instruction-like phrase (informational). */
export function containsInjectionPhrase(text) {
    const folded = foldForMatch(text);
    return INJECTION_PHRASES.some((phrase) => folded.includes(foldForMatch(phrase)));
}

// ---------------------------------------------------------------------------
// Per-record orchestration
// ---------------------------------------------------------------------------

/**
 * Ground every non-empty cell of one record against the cited lines, falling
 * back to the whole chunk (with SRC_REF_INVALID when a value is found only
 * there). Applies the snapping/blanking table of §8.2.3.
 *
 * @returns {{cells, issues, phantom: boolean, citedIds: string[], srcValid: boolean,
 *            foundInChunkOnly: boolean}}
 */
export function groundRecord({ cells, srcValue, sourceId, linesById, chunkLineIds }) {
    const issues = [];
    const changedFields = [];
    const cited = resolveSrc(srcValue, { sourceId, linesById });
    let citedIds = cited.ids;
    let srcValid = cited.valid;

    const citedTexts = citedIds.filter((id) => linesById.has(id)).map((id) => linesById.get(id).text);
    const chunkTexts = chunkLineIds.filter((id) => linesById.has(id)).map((id) => linesById.get(id).text);
    let foundInChunkOnly = false;

    if (!srcValid) {
        issues.push(issue('SRC_REF_INVALID', { detail: { src: srcValue } }));

        // Fallback search: the record's ID, then mobile, then name (§8.2.1).
        const searchTexts = chunkTexts;
        const hitField = ['national_id', 'mobile', 'name'].find((field) => {
            const value = cells[field]?.value;
            if (!value || Array.isArray(value)) return false;
            return DIGIT_FIELDS.includes(field)
                ? digitsGrounded(value, searchTexts)
                : nameGrounded(value, searchTexts);
        });
        if (hitField) {
            const needle = String(cells[hitField].value);
            const matchedIds = chunkLineIds.filter((id) => {
                const text = linesById.get(id)?.text ?? '';
                return DIGIT_FIELDS.includes(hitField)
                    ? digitsGrounded(needle, [text])
                    : foldForMatch(text).includes(foldForMatch(needle));
            });
            citedIds = matchedIds;
            srcValid = matchedIds.length > 0;
        } else {
            return { cells, issues, changedFields, phantom: true, citedIds, srcValid: false, foundInChunkOnly: false };
        }
    }

    const effectiveTexts = citedTexts.length
        ? citedTexts
        : citedIds.filter((id) => linesById.has(id)).map((id) => linesById.get(id).text);

    // Phantom-record rule: neither name tokens nor ID/mobile digits found.
    const nameOk = cells.name?.value ? nameGrounded(cells.name.value, [...effectiveTexts, ...chunkTexts]) : false;
    const idOk = cells.national_id?.value ? digitsGrounded(cells.national_id.value, [...effectiveTexts, ...chunkTexts]) : false;
    const mobileOk = cells.mobile?.value ? digitsGrounded(cells.mobile.value, [...effectiveTexts, ...chunkTexts]) : false;
    if (cells.name?.value || cells.national_id?.value || cells.mobile?.value) {
        if (!nameOk && !idOk && !mobileOk) {
            return { cells, issues, changedFields, phantom: true, citedIds, srcValid, foundInChunkOnly: false };
        }
    }

    // An incomplete-name hint in the source itself (§8.4, field `name`).
    if (cells.name?.value && effectiveTexts.some((text) => hasPartialNameHint(text))) {
        issues.push(issue('NAME_PARTIAL_HINT', { field: 'name' }));
    }

    for (const [fieldKey, cell] of Object.entries(cells)) {
        if (!cell || cell.value === '' || cell.value === null || cell.value === undefined) continue;
        if (Array.isArray(cell.value) && cell.value.length === 0) continue;
        // Only extracted values are verified against the source; derived,
        // default and user values have their own origins (spec §8.5).
        if (cell.origin && cell.origin !== 'extracted') continue;

        const raw = cell.raw ?? cell.value;
        const inCited = isGrounded(fieldKey, cell.value, raw, effectiveTexts);
        if (inCited) continue;

        const inChunk = isGrounded(fieldKey, cell.value, raw, chunkTexts);
        if (inChunk) {
            foundInChunkOnly = true;
            continue;
        }

        // Not found anywhere — snap or blank (table in §8.2.3). The registry's
        // `snapToSource` decides: national_id and mobile snap; everything else
        // below blanks or keeps its value.
        const field = fieldByKey(fieldKey);
        if (field?.snapToSource) {
            const best = snapToSource(
                field.snapToSource,
                cell.value,
                effectiveTexts.length ? effectiveTexts : chunkTexts,
            );
            if (best) {
                // Store the normalized form of the source candidate (a source
                // that wrote `1012345679` means the mobile `01012345679`); the
                // candidate's own flags replace the stale parse-time ones.
                const renorm = normalizeField(field, best.candidate, {});
                const newValue = renorm.value || best.candidate;
                issues.push(issue('SNAPPED_TO_SOURCE', {
                    field: fieldKey, detail: { old: String(cell.value), new: newValue, distance: best.distance },
                }));
                issues.push(...renorm.issues);
                cells[fieldKey] = { value: newValue, origin: 'snapped', raw: cell.raw };
                changedFields.push(fieldKey);
            } else {
                issues.push(issue('VALUE_NOT_IN_SOURCE', {
                    field: fieldKey,
                    severity: fieldKey === 'national_id' ? 'error' : 'warn',
                    detail: { value: String(cell.value) },
                }));
                cells[fieldKey] = { value: '', origin: cell.origin, raw: cell.raw };
                changedFields.push(fieldKey);
            }
            continue;
        }

        if (DIGIT_FIELDS.includes(fieldKey)) {
            issues.push(issue('VALUE_NOT_IN_SOURCE', {
                field: fieldKey, severity: 'warn', detail: { value: String(cell.value) },
            }));
            cells[fieldKey] = { value: '', origin: cell.origin, raw: cell.raw };
            changedFields.push(fieldKey);
            continue;
        }

        if (DATE_FIELDS.includes(fieldKey)) {
            issues.push(issue('VALUE_NOT_IN_SOURCE', {
                field: fieldKey, severity: 'warn', detail: { value: String(cell.value) },
            }));
            continue; // a human must look; value kept
        }

        // Names and text: keep, flag the missing tokens.
        const missing = Array.isArray(cell.value)
            ? cell.value.flatMap((entry) => missingTokens(entry, [...effectiveTexts, ...chunkTexts]))
            : missingTokens(cell.value, [...effectiveTexts, ...chunkTexts]);
        issues.push(issue('VALUE_NOT_IN_SOURCE', {
            field: fieldKey, severity: 'warn', detail: { missing },
        }));
    }

    if (foundInChunkOnly) {
        issues.push(issue('SRC_REF_INVALID', { detail: { src: srcValue, reason: 'found_in_chunk_only' } }));
    }

    return { cells, issues, changedFields, phantom: false, citedIds, srcValid, foundInChunkOnly };
}
