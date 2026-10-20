import { describe, expect, it } from 'vitest';
import { orderColumnFor, orderTiebreakerFor } from '../../src/features/import-agent/api.js';

describe('import table ordering', () => {
    it('orders each table by a column that exists', () => {
        expect(orderColumnFor('import_sources')).toBe('idx');
        expect(orderColumnFor('import_chunks')).toBe('idx');
        expect(orderColumnFor('import_rows')).toBe('seq');
        expect(orderColumnFor('import_rejects')).toBe('created_at');
    });

    it('never falls back to seq for an unknown table', () => {
        expect(orderColumnFor('unknown_table')).toBe('id');
    });

    it('breaks ties with a unique column so the paging cannot drop rows', () => {
        // `seq` is unique per chunk only: paging over it alone duplicates and
        // drops rows once a job has more rows than one page.
        expect(orderTiebreakerFor('import_rows')).toBe('id');
        expect(orderTiebreakerFor('import_rejects')).toBe('id');
        expect(orderTiebreakerFor('unknown_table')).toBe('id');
    });
});
