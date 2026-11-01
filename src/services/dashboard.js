import { supabase } from './supabase.js';
import { isMissingRpc, loadDashboardFallbackRows } from './patient-scan.js';

function countMap(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    Object.entries(value).forEach(([key, count]) => {
        const number = Number(count);
        if (key && Number.isFinite(number)) result[key] = number;
    });
    return result;
}

/**
 * Normalize the JSON the `dashboard_stats` RPC returns. Kept separate from the
 * query so the shape can be unit-tested without Supabase.
 */
export function normalizeDashboardStats(payload) {
    const total = Math.max(0, Number(payload?.total) || 0);
    const completed = Math.max(0, Number(payload?.completed) || 0);
    const pending = payload?.pending === undefined || payload?.pending === null
        ? Math.max(0, total - completed)
        : Math.max(0, Number(payload.pending) || 0);
    return {
        total,
        completed,
        pending,
        sections: countMap(payload?.sections),
        sources: countMap(payload?.sources),
    };
}

/** Aggregate the compatibility rows without a round trip for each count. */
export function aggregateDashboardRows(rows = []) {
    const sections = {};
    const sources = {};
    let completed = 0;

    rows.forEach((row) => {
        if (row?.is_completed) completed += 1;
        if (row?.section) sections[row.section] = (sections[row.section] || 0) + 1;
        if (row?.source_of_money) {
            sources[row.source_of_money] = (sources[row.source_of_money] || 0) + 1;
        }
    });

    return {
        total: rows.length,
        completed,
        pending: Math.max(0, rows.length - completed),
        sections,
        sources,
    };
}

export async function getDashboardStats() {
    // One aggregate on the server. Fetching the rows and counting in the
    // browser silently stopped at PostgREST's 1000-row cap (issue #44), and
    // transferring every row for a card was wasteful even below that cap.
    // The SQL function is SECURITY INVOKER, so section RLS still applies.
    const { data, error } = await supabase().rpc('dashboard_stats');
    if (!error) return normalizeDashboardStats(data);

    // A database that has not applied schema.sql yet (or whose PostgREST
    // cache is stale) must still show correct cards. This is a temporary
    // compatibility path: it reads a light projection in 1000-row pages,
    // rather than the old full-row fetch, and disappears once the RPC exists.
    if (!isMissingRpc(error)) throw error;
    console.warn('dashboard_stats RPC unavailable; using paged compatibility read.');
    return aggregateDashboardRows(await loadDashboardFallbackRows());
}

export async function getRecentPatients(limit = 5) {
    // Only the columns the dashboard row renders. Notes and attachments are
    // loaded when a record is opened, not on every dashboard visit.
    const { data, error } = await supabase()
        .from('patients')
        .select('id, name, problem, is_completed, visit_date, section, registered_by_name')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;

    // registered_by_name is denormalized onto the patient row (schema.sql) so
    // section staff can see a registrar even though RLS hides other users.
    return (data || []).map(p => ({
        ...p,
        user_name: p.registered_by_name || 'Unknown'
    }));
}
