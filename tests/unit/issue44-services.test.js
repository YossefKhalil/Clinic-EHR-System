// Issue #44: normalize the JSON returned by the dashboard/price aggregate
// RPCs. The SQL is covered by tests/rls/06-issue44.sql; these tests pin the
// browser-side shape and its defensive defaults.
import { describe, expect, it } from 'vitest';
import { aggregateDashboardRows, normalizeDashboardStats } from '../../src/services/dashboard.js';
import { isMissingRpc } from '../../src/services/patient-scan.js';
import { normalizePriceStats } from '../../src/services/prices.js';

describe('normalizeDashboardStats', () => {
    it('keeps the aggregate shape', () => {
        expect(normalizeDashboardStats({
            total: 1234,
            completed: 1000,
            pending: 234,
            sections: { agamy: 800, dekhila: 434 },
            sources: { charity: 1000, country: 234 },
        })).toEqual({
            total: 1234,
            completed: 1000,
            pending: 234,
            sections: { agamy: 800, dekhila: 434 },
            sources: { charity: 1000, country: 234 },
        });
    });

    it('derives pending when an older payload omits it', () => {
        expect(normalizeDashboardStats({ total: 10, completed: 4 })).toMatchObject({
            total: 10,
            completed: 4,
            pending: 6,
        });
    });

    it('falls back to zero for missing or malformed values', () => {
        const stats = normalizeDashboardStats(null);
        expect(stats).toEqual({ total: 0, completed: 0, pending: 0, sections: {}, sources: {} });
        expect(normalizeDashboardStats({ total: '12', sections: { agamy: '7', bad: 'x' } })).toEqual({
            total: 12,
            completed: 0,
            pending: 12,
            sections: { agamy: 7 },
            sources: {},
        });
    });
});

describe('dashboard compatibility fallback', () => {
    it('counts the rows when the aggregate RPC is not deployed', () => {
        expect(aggregateDashboardRows([
            { is_completed: true, section: 'agamy', source_of_money: 'country' },
            { is_completed: false, section: 'agamy', source_of_money: 'charity' },
            { is_completed: false, section: 'dekhila', source_of_money: null },
        ])).toEqual({
            total: 3,
            completed: 1,
            pending: 2,
            sections: { agamy: 2, dekhila: 1 },
            sources: { country: 1, charity: 1 },
        });
    });

    it('handles an empty or partial row set', () => {
        expect(aggregateDashboardRows()).toEqual({
            total: 0,
            completed: 0,
            pending: 0,
            sections: {},
            sources: {},
        });
        expect(aggregateDashboardRows([{ is_completed: null, section: '', source_of_money: null }]))
            .toMatchObject({ total: 1, completed: 0, pending: 1, sections: {}, sources: {} });
    });

    it('only treats a missing function as a fallback signal', () => {
        expect(isMissingRpc({ code: 'PGRST202' })).toBe(true);
        expect(isMissingRpc({ code: '42883' })).toBe(true);
        expect(isMissingRpc({ message: 'function public.price_stats() does not exist' })).toBe(true);
        expect(isMissingRpc({ code: '42501', message: 'permission denied' })).toBe(false);
        expect(isMissingRpc(null)).toBe(false);
    });
});

describe('normalizePriceStats', () => {
    it('keeps totals, counts and the grand total', () => {
        expect(normalizePriceStats({
            sectionTotals: { agamy: { total: 150.5, count: 3 } },
            sourceTotals: { charity: { total: 150.5, count: 3 } },
            grandTotal: 150.5,
            totalPatients: 3,
        })).toEqual({
            sectionTotals: { agamy: { total: 150.5, count: 3 } },
            sourceTotals: { charity: { total: 150.5, count: 3 } },
            grandTotal: 150.5,
            totalPatients: 3,
        });
    });

    it('normalizes malformed entries to zero', () => {
        expect(normalizePriceStats({
            sectionTotals: { agamy: { total: 'oops' }, dekhila: null },
            grandTotal: '12.5',
            totalPatients: '2',
        })).toEqual({
            sectionTotals: { agamy: { total: 0, count: 0 }, dekhila: { total: 0, count: 0 } },
            sourceTotals: {},
            grandTotal: 12.5,
            totalPatients: 2,
        });
    });

    it('handles an empty payload', () => {
        expect(normalizePriceStats(null)).toEqual({
            sectionTotals: {},
            sourceTotals: {},
            grandTotal: 0,
            totalPatients: 0,
        });
    });
});
