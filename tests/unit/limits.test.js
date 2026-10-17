import { describe, expect, it } from 'vitest';
import { LIMITS, resolveLimits } from '@import-core/limits.js';

describe('limits', () => {
    it('matches the defaults of the design spec', () => {
        expect(LIMITS.MAX_FILES).toBe(10);
        expect(LIMITS.MAX_FILE_BYTES).toBe(8 * 1024 * 1024);
        expect(LIMITS.MAX_ROWS).toBe(500);
        expect(LIMITS.MAX_CHUNKS).toBe(120);
        expect(LIMITS.SHEET_CHUNK_ROWS).toBe(15);
        expect(LIMITS.PUMP_PARALLEL).toBe(3);
        expect(LIMITS.LEASE_SECONDS).toBe(90);
        expect(LIMITS.MAX_ATTEMPTS).toBe(3);
        expect(LIMITS.COMMIT_BATCH_SIZE).toBe(50);
        expect(LIMITS.UNDO_WINDOW_DAYS).toBe(7);
        expect(LIMITS.PHONE_STORAGE_FORMAT).toBe('local');
    });

    it('resolves overrides over the defaults', () => {
        const resolved = resolveLimits({ MAX_ROWS: 100, PRICE_WARN_ABOVE: 5000 });
        expect(resolved.MAX_ROWS).toBe(100);
        expect(resolved.PRICE_WARN_ABOVE).toBe(5000);
        expect(resolved.MAX_FILES).toBe(LIMITS.MAX_FILES);
        expect(LIMITS.MAX_ROWS).toBe(500); // defaults are untouched
    });

    it('ignores empty override values and rejects unknown keys', () => {
        expect(resolveLimits({ MAX_ROWS: null, MAX_CHUNKS: '' }).MAX_ROWS).toBe(500);
        expect(() => resolveLimits({ NOT_A_LIMIT: 1 })).toThrow(/Unknown import limit override/);
    });
});
