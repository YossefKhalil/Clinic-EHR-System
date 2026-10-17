// Row status derivation (spec §8.5) and acknowledgement keys (§10.6).
//
//   error  — at least one error-severity issue.
//   review — at least one warn that is not acknowledged.
//   ready  — everything else. Info issues never change the status.
//
// "Mark reviewed" acknowledges the current warnings on a row. Acknowledgements
// are keyed by issue code, field and the cell value at acknowledgement time,
// so editing the cell invalidates the acknowledgement and a fresh review is
// required. Keys are plain strings so they can live in `import_rows`
// (`acknowledged jsonb`).

export const ROW_STATUSES = Object.freeze(['ready', 'review', 'error']);

function ackValue(cellValue) {
    if (cellValue === null || cellValue === undefined) return '';
    if (Array.isArray(cellValue)) return cellValue.join('\n');
    return String(cellValue);
}

/** The acknowledgement key for one issue entry at its current cell value. */
export function issueAckKey(entry, cellValue) {
    return `${entry.code}\u0000${entry.field ?? ''}\u0000${ackValue(cellValue)}`;
}

/**
 * Derive the row status.
 *
 * @param {object[]} issues
 * @param {{acknowledged?: string[], values?: Record<string, unknown>}} [options]
 *   `acknowledged` holds keys from `issueAckKey`; `values` maps field keys to
 *   cell values so row-level issues (field `null`) use the empty value.
 * @returns {'ready'|'review'|'error'}
 */
export function deriveStatus(issues, { acknowledged = [], values = {} } = {}) {
    if (issues.some((entry) => entry.severity === 'error')) return 'error';
    const acked = new Set(acknowledged);
    const unacknowledged = issues.some((entry) => entry.severity === 'warn'
        && !acked.has(issueAckKey(entry, entry.field ? values[entry.field] : undefined)));
    return unacknowledged ? 'review' : 'ready';
}

/** Count rows by status (for the review header and job counts). */
export function countStatuses(rows) {
    const counts = { ready: 0, review: 0, error: 0 };
    for (const row of rows) {
        if (counts[row.status] !== undefined) counts[row.status] += 1;
    }
    return counts;
}
