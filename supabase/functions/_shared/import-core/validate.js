// Validators (spec §8.1 step 8, §8.3 ranges) — required, range and length
// checks bound to registry fields by name. Validators run on NORMALIZED values
// so they never deal with raw formatting.
//
// Purely parse-time flags (character cleanup, structure, ambiguity, units)
// belong to normalizers.js; this module owns everything that needs `today`.

import { ageFromDob, decodeNationalId } from './normalizers.js';
import { issue } from './issues.js';
import { LIMITS } from './limits.js';

const isEmpty = (value) => value === null || value === undefined || String(value).trim() === '';

/**
 * All validators. Signature: (value, context) -> issues[].
 * `context.today` is an ISO date; nothing here reads the clock.
 */
export const VALIDATORS = {
    nameRequired(value) {
        return isEmpty(value) ? [issue('NAME_REQUIRED', { field: 'name' })] : [];
    },

    nidRequired(value) {
        return isEmpty(value) ? [issue('NID_REQUIRED', { field: 'national_id' })] : [];
    },

    nidDateRange(value, { today }) {
        // "Not in the future" needs the clock, so it lives here (spec §8.3).
        // Structural problems (length, century, impossible date) are already
        // flagged by the normalizer and decode to null here.
        if (isEmpty(value) || !today) return [];
        const decoded = decodeNationalId(value);
        if (decoded && decoded.date > today) {
            return [issue('NID_DATE_INVALID', {
                field: 'national_id', detail: { date: decoded.date, reason: 'future' },
            })];
        }
        return [];
    },

    sectionRequired(value, { requireSection = false } = {}) {
        // Section is required "at save" (spec §8.4): the review grid accepts a
        // blank section while the user is still working; the commit path and
        // the server-side re-run pass `requireSection: true`.
        if (!requireSection || !isEmpty(value)) return [];
        return [issue('SECTION_REQUIRED', { field: 'section' })];
    },

    dateOfBirthRange(value, { today }) {
        if (isEmpty(value)) return [];
        const issues = [];
        if (value > today) {
            issues.push(issue('DATE_RANGE', { field: 'date_of_birth', detail: { value, reason: 'future' } }));
            return issues;
        }
        const age = ageFromDob(value, today);
        if (age === null || age > LIMITS.DOB_MAX_AGE_YEARS) {
            issues.push(issue('DATE_RANGE', {
                field: 'date_of_birth', detail: { value, reason: 'too_old', age },
            }));
        }
        return issues;
    },

    visitDateRange(value, { today }) {
        if (isEmpty(value)) return [];
        const issues = [];
        const dayMs = 24 * 60 * 60 * 1000;
        const diffDays = (new Date(`${value}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / dayMs;
        if (diffDays > LIMITS.VISIT_DATE_MAX_FUTURE_DAYS) {
            issues.push(issue('DATE_RANGE', { field: 'visit_date', detail: { value, reason: 'future' } }));
        } else if (-diffDays > LIMITS.VISIT_DATE_MAX_AGE_YEARS * 365.25) {
            issues.push(issue('DATE_RANGE', { field: 'visit_date', detail: { value, reason: 'too_old' } }));
        }
        return issues;
    },

    ageRange(value) {
        if (value === null || value === undefined || value === '') return [];
        const age = Number(value);
        if (!Number.isFinite(age) || age < 0 || age > LIMITS.AGE_MAX) {
            return [issue('AGE_RANGE', { field: 'age', detail: { value } })];
        }
        return [];
    },

    childrenRange(value) {
        if (value === null || value === undefined || value === '') return [];
        const count = Number(value);
        if (!Number.isFinite(count) || count < 0 || count > LIMITS.CHILDREN_MAX) {
            return [issue('CHILDREN_RANGE', { field: 'children_count', detail: { value } })];
        }
        if (count > LIMITS.CHILDREN_WARN_ABOVE) {
            return [issue('CHILDREN_RANGE', {
                field: 'children_count', detail: { value, reason: 'above_expected' },
            })];
        }
        return [];
    },

    priceRange(value) {
        if (value === null || value === undefined || value === '') return [];
        const price = Number(value);
        if (!Number.isFinite(price) || price < 0) {
            return [issue('PRICE_RANGE', { field: 'price', detail: { value } })];
        }
        if (price > LIMITS.PRICE_WARN_ABOVE) {
            return [issue('PRICE_RANGE', {
                field: 'price', detail: { value, threshold: LIMITS.PRICE_WARN_ABOVE },
            })];
        }
        return [];
    },

    textLength(value, { field }) {
        if (isEmpty(value)) return [];
        if (String(value).length > LIMITS.TEXT_MAX_CHARS) {
            return [issue('TEXT_TOO_LONG', {
                field, detail: { length: String(value).length, max: LIMITS.TEXT_MAX_CHARS },
            })];
        }
        return [];
    },

    notesLimits(value) {
        if (!Array.isArray(value) || !value.length) return [];
        if (value.length > LIMITS.NOTES_MAX_ENTRIES) {
            return [issue('TEXT_TOO_LONG', {
                field: 'notes', detail: { count: value.length, max: LIMITS.NOTES_MAX_ENTRIES },
            })];
        }
        const overlong = value.find((entry) => String(entry).length > LIMITS.NOTES_MAX_CHARS);
        if (overlong !== undefined) {
            return [issue('TEXT_TOO_LONG', {
                field: 'notes', detail: { length: String(overlong).length, max: LIMITS.NOTES_MAX_CHARS },
            })];
        }
        return [];
    },
};

/**
 * Run the validators bound to a registry field.
 *
 * @param {import('./field-registry.js').FieldEntry} field
 * @param {unknown} value normalized value
 * @param {{today: string}} context
 */
export function validateField(field, value, context = {}) {
    const issues = [];
    for (const name of field.validate) {
        const validator = VALIDATORS[name];
        if (!validator) throw new Error(`No validator named ${name} for ${field.key}`);
        issues.push(...validator(value, { ...context, field: field.key }));
    }
    return issues;
}

export const VALIDATOR_NAMES = Object.keys(VALIDATORS);
