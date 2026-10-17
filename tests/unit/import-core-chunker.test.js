// M4 moved the chunker into import-core so the Edge Function can reuse it;
// the browser keeps importing src/features/import-agent/chunker.js, which now
// re-exports the shared module. This test pins that identity and the §7.4
// split helper.
import { describe, expect, it } from 'vitest';
import * as core from '../../supabase/functions/_shared/import-core/chunker.js';
import * as shim from '../../src/features/import-agent/chunker.js';

describe('chunker moved to import-core', () => {
    it('re-exports identical bindings through the browser shim', () => {
        expect(shim.prepareSources).toBe(core.prepareSources);
        expect(shim.poolSources).toBe(core.poolSources);
        expect(shim.chunkPool).toBe(core.chunkPool);
        expect(shim.splitRecords).toBe(core.splitRecords);
        expect(shim.splitChunkPayload).toBe(core.splitChunkPayload);
    });

    it('splits a rows chunk in half and keeps the header', () => {
        const chunk = {
            chunk_id: 'c1',
            source_id: 'S1',
            kind: 'sheet',
            header: 'S1:R1 | Name',
            lines: [2, 3, 4, 5].map((row) => ({ id: `S1:R${row}`, text: `S1:R${row} | x` })),
            boundary_uncertain: false,
            image_ref: null,
        };
        const [first, second] = core.splitChunkPayload(chunk);
        expect(first.lines.map((line) => line.id)).toEqual(['S1:R2', 'S1:R3']);
        expect(second.lines.map((line) => line.id)).toEqual(['S1:R4', 'S1:R5']);
        expect(first.header).toBe('S1:R1 | Name');
        expect(second.header).toBe('S1:R1 | Name');
        // Row splits are always at row boundaries — never uncertain.
        expect(first.boundary_uncertain).toBe(false);
        expect(second.boundary_uncertain).toBe(false);
    });

    it('flags the continuation piece of a text split and refuses one-line chunks', () => {
        const chunk = {
            chunk_id: 'c2',
            source_id: 'S2',
            kind: 'text',
            header: null,
            lines: [
                { id: 'S2:L001', text: 'S2:L001 | first' },
                { id: 'S2:L002', text: 'S2:L002 | second' },
            ],
            boundary_uncertain: false,
            image_ref: null,
        };
        const [first, second] = core.splitChunkPayload(chunk);
        expect(first.boundary_uncertain).toBe(false);
        expect(second.boundary_uncertain).toBe(true);
        expect(core.splitChunkPayload({ ...chunk, lines: [chunk.lines[0]] })).toBeNull();
    });

    it('renumbers a fresh S1 pool to the job-s next source number (spec §6.2)', () => {
        const chunk = {
            chunk_id: 'c1',
            source_id: 'S1',
            kind: 'text',
            header: null,
            lines: [
                { id: 'S1:L001', text: 'S1:L001 | أحمد' },
                { id: 'S1:L002', text: 'S1:L002 | ثاني' },
            ],
            boundary_uncertain: false,
            image_ref: null,
        };
        const [shifted] = core.shiftSourceIds([chunk], 3);
        expect(shifted.source_id).toBe('S3');
        expect(shifted.lines[0]).toEqual({ id: 'S3:L001', text: 'S3:L001 | أحمد' });
        // No-op for the first source: the same payloads come back untouched.
        const fresh = [chunk];
        expect(core.shiftSourceIds(fresh, 1)).toBe(fresh);
        expect(fresh[0].source_id).toBe('S1');
        expect(fresh[0].lines[0].id).toBe('S1:L001');
    });
});
