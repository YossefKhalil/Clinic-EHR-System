// The local pump.
//
// The pump is the loop between the server's claim and the submit. The test
// drives it with a fake server and a fake extractor, so the contract between
// the two is pinned down.

import { describe, it, expect } from 'vitest';
import { localPump } from '../../src/features/import-agent/local/pump.js';

/** A server that hands out one chunk and then says it is done. */
function fakeApi(chunk) {
    const calls = [];
    let claims = 0;
    return {
        calls,
        async callJob(action, payload) {
            calls.push({ action, payload });
            if (action === 'local_claim') {
                claims += 1;
                if (claims > 1) return { ok: true, done: true, status: 'review' };
                return { ok: true, done: false, chunk, progress: { done: 0, total: 1 } };
            }
            return { ok: true };
        },
    };
}

const PAYLOAD = {
    source_id: 'S1',
    kind: 'text',
    header: null,
    lines: [{ id: 'L001', text: 'محمد علي 12345678901234' }],
};

describe('localPump', () => {
    it('hands the chunk payload to the extractor, not the chunk row', async () => {
        const api = fakeApi({ id: 'chunk-1', idx: 0, payload: PAYLOAD });
        const seen = [];
        await localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            runChunk: async ({ chunk }) => {
                seen.push(chunk);
                return { status: 'ok', documents: [], rejected: [] };
            },
        });
        expect(seen).toHaveLength(1);
        expect(seen[0].lines).toEqual(PAYLOAD.lines);
        expect(seen[0].kind).toBe('text');
    });

    it('claims, extracts and submits in that order', async () => {
        const api = fakeApi({ id: 'chunk-1', idx: 0, payload: PAYLOAD });
        await localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            runChunk: async () => ({ status: 'ok', documents: [], rejected: [] }),
        });
        const actions = api.calls.map((call) => call.action);
        expect(actions[0]).toBe('local_claim');
        expect(actions).toContain('local_submit');
        expect(actions.indexOf('local_claim')).toBeLessThan(actions.indexOf('local_submit'));
    });

    it('sends the result back with the pipeline kind', async () => {
        const api = fakeApi({ id: 'chunk-1', idx: 0, payload: PAYLOAD });
        const result = { status: 'ok', documents: [{ index: 1, record: {} }], rejected: [] };
        await localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            runChunk: async () => result,
        });
        const submit = api.calls.find((call) => call.action === 'local_submit');
        expect(submit.payload.chunk_id).toBe('chunk-1');
        expect(submit.payload.result).toBe(result);
        expect(submit.payload.pipeline_kind).toBe('text');
    });

    it('fails a chunk with a code the server understands', async () => {
        const api = fakeApi({ id: 'chunk-1', idx: 0, payload: PAYLOAD });
        await localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            runChunk: async () => {
                const error = new Error('boom');
                error.code = 'MODEL_NOT_MULTIMODAL';
                throw error;
            },
        });
        const fail = api.calls.find((call) => call.action === 'local_fail');
        expect(fail.payload.error_code).toBe('MODEL_NOT_MULTIMODAL');
        // A model that cannot be used fails again the same way.
        expect(fail.payload.retryable).toBe(false);
    });

    it('releases the chunk when the run is cancelled', async () => {
        const api = fakeApi({ id: 'chunk-1', idx: 0, payload: PAYLOAD });
        await localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            runChunk: async () => {
                const error = new Error('cancelled');
                error.code = 'CANCELLED';
                throw error;
            },
        });
        const release = api.calls.find((call) => call.action === 'local_release');
        expect(release).toBeTruthy();
        expect(api.calls.some((call) => call.action === 'local_fail')).toBe(false);
    });
});
