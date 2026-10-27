// The local pump.
//
// The pump is the loop between the server's claim and the submit. The test
// drives it with a fake server and a fake extractor, so the contract between
// the two is pinned down.

import { describe, it, expect } from 'vitest';
import { localPump } from '../../src/features/import-agent/local/pump.js';

/** A server that hands out one chunk and then says it is done. */
function fakeApi(chunk, { submitError = null } = {}) {
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
            if (action === 'local_submit' && submitError) throw submitError;
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
        // The server classifies the code; the browser does not send a
        // retryable verdict it could lie about.
        expect(fail.payload.retryable).toBeUndefined();
    });

    it('sends the runtime message so the banner can explain the failure', async () => {
        const api = fakeApi({ id: 'chunk-1', idx: 0, payload: PAYLOAD });
        await localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            runChunk: async () => {
                const error = new Error('the model chat template is not supported by this runtime');
                error.code = 'MODEL_TEMPLATE_UNSUPPORTED';
                throw error;
            },
        });
        const fail = api.calls.find((call) => call.action === 'local_fail');
        expect(fail.payload.error_code).toBe('MODEL_TEMPLATE_UNSUPPORTED');
        expect(fail.payload.error_detail).toBe('the model chat template is not supported by this runtime');
    });

    it('submits a failed result unchanged and reports why', async () => {
        const api = fakeApi({ id: 'chunk-1', idx: 0, payload: PAYLOAD });
        const events = [];
        const result = {
            status: 'failed',
            errorCode: 'PROVIDER_ERROR',
            errorDetail: 'ggml_abort in common_chat_templates_get_caps',
        };
        await localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            onProgress: (event) => events.push(event),
            runChunk: async () => result,
        });
        const submit = api.calls.find((call) => call.action === 'local_submit');
        expect(submit.payload.result.errorCode).toBe('PROVIDER_ERROR');
        expect(submit.payload.result.errorDetail).toContain('common_chat_templates_get_caps');
        // The wizard shows this next to the failed chunk.
        const failed = events.find((event) => event.phase === 'result_failed');
        expect(failed).toMatchObject({ chunk: 'chunk-1', code: 'PROVIDER_ERROR' });
        expect(failed.detail).toContain('common_chat_templates_get_caps');
    });

    it('sends the job model identity and resolved config with every claim and submit', async () => {
        const lease = '2026-10-23T15:00:00.000000+00:00';
        const api = fakeApi({ id: 'chunk-1', idx: 0, payload: PAYLOAD, lease_until: lease });
        const model = { mode: 'single', name: 'model.gguf', sha256: 'A'.repeat(64) };
        const config = { text: { contextTokens: 4096 } };
        await localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            model,
            config,
            runChunk: async () => ({ status: 'ok', documents: [], rejected: [] }),
        });
        const claim = api.calls.find((call) => call.action === 'local_claim');
        expect(claim.payload.model).toEqual(model);
        expect(claim.payload.config.text.contextTokens).toBe(4096);
        const submit = api.calls.find((call) => call.action === 'local_submit');
        expect(submit.payload.model).toEqual(model);
        expect(submit.payload.config.text.contextTokens).toBe(4096);
        expect(submit.payload.lease_expires_at).toBe(lease);
    });

    it('hands the chunk back when the submit sees config drift', async () => {
        const drift = new Error('the model changed');
        drift.code = 'CONFIG_DRIFT';
        const api = fakeApi(
            { id: 'chunk-1', idx: 0, payload: PAYLOAD, lease_until: '2026-10-23T15:00:00.000000+00:00' },
            { submitError: drift },
        );
        const result = await localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            runChunk: async () => ({ status: 'ok', documents: [], rejected: [] }),
        });
        expect(api.calls.some((call) => call.action === 'local_release')).toBe(true);
        expect(api.calls.some((call) => call.action === 'local_fail')).toBe(false);
        // A drift stops the run: every later claim would be refused.
        expect(api.calls.filter((call) => call.action === 'local_claim')).toHaveLength(1);
        // The wizard still has to hear about it.
        expect(result.error).toBe(drift);
    });

    it('surfaces a refused claim instead of stopping silently', async () => {
        const drift = new Error('the model changed');
        drift.code = 'CONFIG_DRIFT';
        const api = {
            calls: [],
            async callJob(action, payload) {
                this.calls.push({ action, payload });
                throw drift;
            },
        };
        await expect(localPump({
            api,
            jobId: 'job-1',
            provider: {},
            mode: 'single',
            tier: 'mid',
            runChunk: async () => ({ status: 'ok', documents: [], rejected: [] }),
        })).rejects.toMatchObject({ code: 'CONFIG_DRIFT' });
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
