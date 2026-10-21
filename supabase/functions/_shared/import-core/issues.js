// Issue catalogue (spec §8.4) — stable codes, severities and field binding.
//
// Every issue the pipeline can produce is declared here exactly once. The UI
// resolves bilingual messages through `importAgent.issue.<code>` keys (§10.10);
// code never contains an English string.
//
// Severities: error blocks the row, warn needs a look (and acknowledgement),
// info is shown quietly and never counts toward "needs attention".

export const SEVERITIES = ['error', 'warn', 'info'];

/**
 * Default severity per code. `VALUE_NOT_IN_SOURCE` is dynamic (error for the
 * national ID, warn otherwise) and must be called with an explicit severity.
 */
export const SEVERITY_BY_CODE = Object.freeze({
    NAME_REQUIRED: 'error',
    NID_REQUIRED: 'error',
    NID_LENGTH: 'error',
    NID_CHARS: 'error',
    NID_CENTURY: 'error',
    NID_DATE_INVALID: 'error',
    NID_GOV_UNKNOWN: 'warn',
    SNAPPED_TO_SOURCE: 'warn',
    SRC_REF_INVALID: 'warn',
    MOVED_FIELD: 'warn',
    MOBILE_FORMAT: 'warn',
    DOB_AMBIGUOUS: 'warn',
    DATE_AMBIGUOUS: 'warn',
    DOB_NID_MISMATCH: 'warn',
    AGE_DOB_MISMATCH: 'warn',
    AGE_UNIT: 'warn',
    AGE_RANGE: 'warn',
    DATE_RANGE: 'warn',
    DATE_NO_YEAR: 'info',
    DATE_RELATIVE: 'info',
    DOB_TWO_DIGIT_YEAR: 'info',
    DATE_TWO_DIGIT_YEAR: 'info',
    DOB_DERIVED_FROM_NID: 'info',
    AGE_DERIVED: 'info',
    AGE_NID_MISMATCH: 'info',
    PRICE_RANGE: 'warn',
    ENUM_UNMATCHED: 'warn',
    ENUM_FUZZY: 'warn',
    NAME_SINGLE_TOKEN: 'warn',
    NAME_PARTIAL_HINT: 'info',
    TEXT_TOO_LONG: 'warn',
    MODEL_UNCERTAIN: 'warn',
    LOW_CONFIDENCE_IMAGE: 'warn',
    UNMAPPED_TEXT: 'info',
    POSSIBLE_INJECTION: 'info',
    DUP_IN_BATCH: 'error',
    DUP_EXISTING_VISIBLE: 'warn',
    DUP_EXISTING_HIDDEN: 'error',
    DUP_POSSIBLE: 'warn',
    DUP_NAME_DOB_POSSIBLE: 'warn',
    DUP_OVERLAP_COLLAPSED: 'info',
    ROW_MISSING: 'warn',
    POSSIBLE_MISSED_RECORD: 'warn',
    CHUNK_TRUNCATED: 'info',
    ROW_CAP_REACHED: 'warn',
    SECTION_REQUIRED: 'error',
    CHILDREN_RANGE: 'warn',
});

// Codes added beyond the spec's table, with the spec rule that needs them:
//   AGE_RANGE           — §8.3 age: digits only, 0–120
//   DATE_TWO_DIGIT_YEAR — §8.3: "visit_date uses 20yy ... raise an info flag"
//   CHILDREN_RANGE      — §8.3 children_count: "warn above 15"
export const EXTRA_CODES = ['AGE_RANGE', 'DATE_TWO_DIGIT_YEAR', 'CHILDREN_RANGE'];

/**
 * Build an issue object. Throws on unknown codes so a typo can never ship.
 *
 * @param {string} code
 * @param {{field?: string|null, detail?: object|null, severity?: string}} [opts]
 */
export function issue(code, { field = null, detail = null, severity } = {}) {
    const resolved = severity || SEVERITY_BY_CODE[code];
    if (!resolved) throw new Error(`Unknown issue code: ${code}`);
    if (!SEVERITIES.includes(resolved)) throw new Error(`Bad severity for ${code}: ${resolved}`);
    return { code, severity: resolved, field, detail };
}

/** True when at least one issue blocks the row. */
export function hasBlockingIssue(issues) {
    return issues.some((entry) => entry.severity === 'error');
}
