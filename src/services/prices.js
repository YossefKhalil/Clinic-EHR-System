import { supabase } from './supabase.js';
import { isMissingRpc, loadDashboardFallbackRows } from './patient-scan.js';

// Aggregate a list of patient rows into the financial summary shape the
// dashboard card shows: totals per section, per source of money, plus the
// grand total and the row count. Rows without a price count as 0.00.
// Exported so the rules can be unit-tested without Supabase.
export function aggregatePriced(rows = []) {
    const sectionTotals = {};
    const sourceTotals = {};

    rows.forEach(p => {
        const price = parseFloat(p.price) || 0;

        if (p.section) {
            if (!sectionTotals[p.section]) {
                sectionTotals[p.section] = { total: 0, count: 0 };
            }
            sectionTotals[p.section].total += price;
            sectionTotals[p.section].count += 1;
        }

        if (p.source_of_money) {
            if (!sourceTotals[p.source_of_money]) {
                sourceTotals[p.source_of_money] = { total: 0, count: 0 };
            }
            sourceTotals[p.source_of_money].total += price;
            sourceTotals[p.source_of_money].count += 1;
        }
    });

    const grandTotal = rows.reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);

    return { sectionTotals, sourceTotals, grandTotal, totalPatients: rows.length };
}

export async function getPriceStats() {
    // The aggregate runs in Postgres (issue #44): the old fetch-all stopped at
    // PostgREST's 1000-row cap and quietly under-reported every total. The
    // function is SECURITY INVOKER, so the caller's section RLS still decides
    // which price rows are included.
    const { data, error } = await supabase().rpc('price_stats');
    if (!error) return normalizePriceStats(data);

    // Same compatibility path as the dashboard: an older database still gets
    // the true totals (including rows after PostgREST's 1000-row cap), using
    // the shared light-column scan rather than a second download.
    if (!isMissingRpc(error)) throw error;
    console.warn('price_stats RPC unavailable; using paged compatibility read.');
    return aggregatePriced(await loadDashboardFallbackRows());
}

function totalMap(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    Object.entries(value).forEach(([key, entry]) => {
        if (!key) return;
        const total = Number(entry?.total);
        const count = Number(entry?.count);
        result[key] = {
            total: Number.isFinite(total) ? total : 0,
            count: Number.isFinite(count) ? count : 0,
        };
    });
    return result;
}

/** Normalize the JSON the `price_stats` RPC returns; exported for tests. */
export function normalizePriceStats(payload) {
    const grandTotal = Number(payload?.grandTotal);
    const totalPatients = Number(payload?.totalPatients);
    return {
        sectionTotals: totalMap(payload?.sectionTotals),
        sourceTotals: totalMap(payload?.sourceTotals),
        grandTotal: Number.isFinite(grandTotal) ? grandTotal : 0,
        totalPatients: Number.isFinite(totalPatients) ? totalPatients : 0,
    };
}
