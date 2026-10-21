/**
 * One place for the patients-filter state shape and the "which filters are
 * active" arithmetic (issue #13). The toolbar count badge, the removable
 * chips and the reset/clear flows all read from here, so a filter added to
 * the panel cannot silently miss the badge.
 */

export function emptyPatientFilters() {
    return {
        search: '',
        filter_by: 'all',
        section: '',
        source_of_money: '',
        follower: '',
        is_completed: '',
        date_from: '',
        date_to: '',
    };
}

// Stable display order for the chips row (search first, scope last).
export const PATIENT_FILTER_KEYS = [
    'search',
    'is_completed',
    'date_from',
    'date_to',
    'follower',
    'section',
    'source_of_money',
];

// The three admin-only fields grouped under the panel's "Scope" heading.
export const SCOPE_FILTER_KEYS = ['follower', 'section', 'source_of_money'];

/** A value counts as "set" when the user actually picked/typed something. */
export function filterValueIsSet(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * The active filter keys in display order.
 * `admin: false` hides the scoped keys, mirroring the panel: a section user
 * cannot see or change them, so they must not count or surface as chips.
 */
export function activeFilterKeys(filters, { admin = true } = {}) {
    const map = filters || {};
    return PATIENT_FILTER_KEYS.filter((key) => {
        if (!admin && SCOPE_FILTER_KEYS.includes(key)) return false;
        return filterValueIsSet(map[key]);
    });
}

export function activePatientFiltersCount(filters, options) {
    return activeFilterKeys(filters, options).length;
}
