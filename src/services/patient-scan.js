// Compatibility reads for databases that have not applied the issue #44
// aggregate functions yet (or whose PostgREST schema cache is still stale).
//
// The normal dashboard path is one small RPC. This module is only used when
// that RPC is reported missing. It pages the same way the export does, so a
// large clinic still gets correct totals instead of the first 1000 rows.
import { getCurrentUser, supabase } from './supabase.js';

const PAGE_SIZE = 1000;

// The smallest projection that can answer both dashboard and price totals.
// Attachments, notes and the rest of the record never leave the database.
const FALLBACK_COLUMNS = 'id, is_completed, section, source_of_money, price';

let fallbackState = null;

/**
 * True when PostgREST cannot find the RPC: either the SQL function has not
 * been applied or its schema cache has not been reloaded after applying it.
 * Real failures (permission denied, RLS, network) are not hidden by this.
 */
export function isMissingRpc(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    return code === 'PGRST202'
        || code === '42883'
        || /could not find the function|function .* does not exist/i.test(message);
}

/**
 * Read every patient row the caller may see, in stable id order. PostgREST
 * caps a response at 1000 rows, so ask again until a short page arrives.
 */
export async function scanPatients(columns, options = {}) {
    const pageSize = Math.min(1000, Math.max(1, Number(options.pageSize) || PAGE_SIZE));
    const rows = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase()
            .from('patients')
            .select(columns)
            .order('id', { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw error;
        const page = data ?? [];
        rows.push(...page);
        if (page.length < pageSize) break;
    }
    return rows;
}

/**
 * One shared scan for the dashboard and financial cards. They load in
 * parallel; without sharing, a missing RPC would download the same rows
 * twice. The promise is cleared after it settles so a later reload retries.
 */
export function loadDashboardFallbackRows() {
    // Key the shared scan by account: an in-flight read started under the
    // previous user must never be handed to the next user's dashboard.
    const key = getCurrentUser()?.id || 'signed-out';
    if (!fallbackState || fallbackState.key !== key) {
        const promise = scanPatients(FALLBACK_COLUMNS).finally(() => {
            if (fallbackState?.promise === promise) fallbackState = null;
        });
        fallbackState = { key, promise };
    }
    return fallbackState.promise;
}