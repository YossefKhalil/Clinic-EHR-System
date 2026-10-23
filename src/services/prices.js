import { supabase } from './supabase.js';

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
    // RLS already restricts the rows to the sections this account may read.
    const { data, error } = await supabase()
        .from('patients')
        .select('section, source_of_money, price');
    if (error) throw error;

    return aggregatePriced(data || []);
}
