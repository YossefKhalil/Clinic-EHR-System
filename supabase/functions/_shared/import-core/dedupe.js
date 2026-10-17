// Dedupe (spec §8.6): inside the batch and against the database.
//
// In-batch: keyed by the normalized 14-digit national ID; the first row in
// source order is kept, later rows get DUP_IN_BATCH (error). Rows without a
// valid ID are compared on (folded name, normalized mobile) and an exact pair
// raises DUP_POSSIBLE. Tile/chunk overlap copies of the same person
// (boundary_uncertain chunks) collapse into one row with
// DUP_OVERLAP_COLLAPSED (info).
//
// Against the database the server passes compact results in: `existing` maps
// a national ID to `{ visible }` (the existence RPC only returns matching
// IDs), and `nameDobMatches` holds keys built with `nameDobKey()` for visible
// patients whose folded name + DOB equal a row's — this catches a mistyped ID.
//
// Every row with a duplicate gets `dup = { kind, action, ... }` (spec §8.5);
// `action` defaults to `skip` and is changed by the user (skip | fill |
// keep). Collapsed overlap copies are marked `collapsed: true`.

import { foldForMatch } from './canonicalize.js';
import { issue } from './issues.js';

const VALID_ID = /^\d{14}$/;

/** The row's normalized ID when it is a full 14-digit national ID, else null. */
export function validNationalId(value) {
    const digits = String(value ?? '');
    return VALID_ID.test(digits) ? digits : null;
}

/** Stable key for the database's visible name + DOB check. */
export function nameDobKey(name, dob) {
    const folded = foldForMatch(name);
    if (!folded || !dob) return null;
    return `${folded}\u0000${dob}`;
}

/**
 * Mutates the rows in source order: appends issues, sets `dup`, and marks
 * overlap copies `collapsed`.
 *
 * @param {object[]} rows pipeline rows (need `index`, `cells`, `issues`)
 * @param {{
 *   existing?: Map<string, {visible?: boolean}>,
 *   nameDobMatches?: Set<string>,
 *   collapseOverlaps?: ((earlier: object, later: object) => boolean) | null,
 * }} [options]
 */
export function dedupeBatch(rows, {
    existing = new Map(),
    nameDobMatches = new Set(),
    collapseOverlaps = null,
} = {}) {
    const byId = new Map();
    const byNameMobile = new Map();

    for (const row of rows) {
        if (row.rejected) continue;
        const cells = row.cells || {};
        const id = validNationalId(cells.national_id?.value);

        // 1. Against the database, by ID (skip takes precedence over
        //    in-batch reporting: the row cannot be imported either way).
        if (id && existing.has(id)) {
            const visible = existing.get(id)?.visible !== false;
            row.dup = {
                kind: visible ? 'existing_visible' : 'existing_hidden',
                action: 'skip',
                existing_id: id,
            };
            row.issues.push(visible
                ? issue('DUP_EXISTING_VISIBLE', { detail: { existing_id: id } })
                : issue('DUP_EXISTING_HIDDEN', { detail: { existing_id: id } }));
            continue;
        }

        // 2. Inside the batch, by ID.
        if (id) {
            if (byId.has(id)) {
                const earlier = byId.get(id);
                if (collapseOverlaps && collapseOverlaps(earlier, row)) {
                    row.collapsed = true;
                    row.dup = { kind: 'overlap', action: 'skip', duplicateOf: earlier.index };
                    const detail = { duplicateOf: earlier.index };
                    earlier.issues.push(issue('DUP_OVERLAP_COLLAPSED', { detail }));
                    row.issues.push(issue('DUP_OVERLAP_COLLAPSED', { detail }));
                } else {
                    row.dup = { kind: 'in_batch', action: 'skip', duplicateOf: earlier.index };
                    row.issues.push(issue('DUP_IN_BATCH', { detail: { duplicateOf: earlier.index } }));
                }
                continue;
            }
            byId.set(id, row);
        }

        // 3. Rows without a valid ID: exact (folded name, mobile) pair.
        if (!id) {
            const name = foldForMatch(cells.name?.value);
            const mobile = String(cells.mobile?.value ?? '');
            if (name && mobile) {
                const key = `${name}\u0000${mobile}`;
                if (byNameMobile.has(key)) {
                    const earlier = byNameMobile.get(key);
                    row.dup = { kind: 'possible', action: 'skip', duplicateOf: earlier.index };
                    row.issues.push(issue('DUP_POSSIBLE', { detail: { duplicateOf: earlier.index } }));
                    continue;
                }
                byNameMobile.set(key, row);
            }
        }

        // 4. Against the database by folded name + DOB (mistyped-ID catcher).
        const key = nameDobKey(cells.name?.value, cells.date_of_birth?.value);
        if (key && nameDobMatches.has(key)) {
            row.dup = { kind: 'name_dob', action: 'skip' };
            row.issues.push(issue('DUP_NAME_DOB_POSSIBLE', {
                detail: { name: cells.name?.value ?? null, dob: cells.date_of_birth?.value ?? null },
            }));
        }
    }

    return rows;
}
