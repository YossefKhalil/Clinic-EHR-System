import { describe, expect, it } from 'vitest';
import { orderColumnFor } from '../../src/features/import-agent/api.js';

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
});
