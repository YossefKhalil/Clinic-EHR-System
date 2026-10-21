// The local runner.
//
// The runner is the piece that puts the shared extractor in the browser, so
// the test checks that the module graph resolves and that the chunk sizes
// follow the model's context.

import { describe, it, expect } from 'vitest';
import { localLimits } from '../../src/features/import-agent/local/runner.js';
import { runChunk, maxTokensFor } from '../../supabase/functions/import-extract/run-chunk.js';
import { LIMITS } from '../../supabase/functions/_shared/import-core/limits.js';

describe('the module graph', () => {
    it('loads the shared extractor in the browser build', async () => {
        expect(typeof runChunk).toBe('function');
    });
});

describe('localLimits', () => {
    it('shapes the chunks so they fit the model context', () => {
        const limits = localLimits({ text: { textCharsPerChunk: 900, sheetRowsPerChunk: 3 } });
        expect(limits.TEXT_CHUNK_TARGET).toBe(900);
        expect(limits.TEXT_CHUNK_MAX).toBe(1350);
        expect(limits.SHEET_CHUNK_ROWS).toBe(3);
        // The storage limits do not change: they protect the database.
        expect(limits.MAX_ROWS).toBe(LIMITS.MAX_ROWS);
        expect(limits.MAX_FILES).toBe(LIMITS.MAX_FILES);
    });
});

describe('maxTokensFor', () => {
    it('uses the row-based budget by default', () => {
        expect(maxTokensFor(10)).toBe(10 * LIMITS.APPROX_TOKENS_PER_RECORD);
    });

    it('uses the caller budget when the caller has one', () => {
        expect(maxTokensFor(10, LIMITS, 512)).toBe(512);
    });

    it('keeps the floor and the ceiling for the default budget', () => {
        expect(maxTokensFor(1)).toBe(LIMITS.MAX_TOKENS_FLOOR);
        expect(maxTokensFor(10_000)).toBe(LIMITS.MAX_TOKENS_CEILING);
    });
});
