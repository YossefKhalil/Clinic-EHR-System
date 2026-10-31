import { supabase } from './supabase.js';

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

export async function getDashboardStats() {
    // One aggregate on the server. Fetching the rows and counting in the
    // browser silently stopped at PostgREST's 1000-row cap (issue #44), and
    // transferring every row for a card was wasteful even below that cap.
    // The SQL function is SECURITY INVOKER, so section RLS still applies.
    const { data, error } = await supabase().rpc('dashboard_stats');
    if (error) throw error;
    return normalizeDashboardStats(data);
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
