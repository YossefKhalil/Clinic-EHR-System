// Financial summary aggregation (#15): the dashboard card must show the same
// numbers the removed Prices page showed — totals per section, per source,
// the grand total, and the row count.

import { describe, expect, it } from 'vitest';
import { aggregatePriced } from '../../src/services/prices.js';

describe('aggregatePriced', () => {
    it('sums per section, per source, and the grand total', () => {
        const rows = [
            { section: 'agamy', source_of_money: 'country', price: 100 },
            { section: 'agamy', source_of_money: 'charity', price: '25.5' },
            { section: 'dekhila', source_of_money: 'country', price: 50 },
        ];

        const stats = aggregatePriced(rows);

        expect(stats.grandTotal).toBe(175.5);
        expect(stats.totalPatients).toBe(3);
        expect(stats.sectionTotals.agamy).toEqual({ total: 125.5, count: 2 });
        expect(stats.sectionTotals.dekhila).toEqual({ total: 50, count: 1 });
        expect(stats.sourceTotals.country).toEqual({ total: 150, count: 2 });
        expect(stats.sourceTotals.charity).toEqual({ total: 25.5, count: 1 });
    });

    it('treats missing or messy prices as 0 without losing the counts', () => {
        const rows = [
            { section: 'agamy', source_of_money: null, price: null },
            { section: 'agamy', source_of_money: '', price: 'not-a-number' },
            { section: '', source_of_money: 'country', price: undefined },
        ];

        const stats = aggregatePriced(rows);

        expect(stats.grandTotal).toBe(0);
        expect(stats.totalPatients).toBe(3);
        expect(stats.sectionTotals.agamy).toEqual({ total: 0, count: 2 });
        expect(stats.sectionTotals['']).toBeUndefined();
        expect(stats.sourceTotals.country).toEqual({ total: 0, count: 1 });
    });

    it('returns an empty, zero-valued summary for no rows', () => {
        expect(aggregatePriced([])).toEqual({
            sectionTotals: {},
            sourceTotals: {},
            grandTotal: 0,
            totalPatients: 0,
        });
    });
});
