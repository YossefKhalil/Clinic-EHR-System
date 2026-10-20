// Ordered fallback semantics: only a failed verdict moves down the chain,
// successful/truncated/cancelled results stop it, and usage from failed
// attempts is carried into the final result for token and cost accounting.
import { describe, expect, it } from 'vitest';
import { runChunkWithFallback } from '../../supabase/functions/_shared/llm/fallback.js';

const CHAIN = [
    { provider: 'openrouter', model: 'or/model' },
    { provider: 'cloudflare', model: '@cf/meta/llama' },
    { provider: 'openai', model: 'qwen2.5:7b' },
];

function result(status, extra = {}) {
    return {
        status,
        model: extra.model ?? 'model',
        documents: [],
        rejected: [],
        truncated: false,
        repairs: false,
        usage: { in: 0, out: 0 },
        cost: null,
        promptId: 'extractor@v1',
        errorCode: null,
        ...extra,
    };
}

describe('runChunkWithFallback', () => {
    it('stops on the first success and does not call later providers', async () => {
        const calls = [];
        const outcome = await runChunkWithFallback({
            chain: CHAIN,
            run: async (entry) => {
                calls.push(entry.provider);
                return result('ok', { model: entry.model, usage: { in: 10, out: 3 }, cost: 0.02 });
            },
        });
        expect(calls).toEqual(['openrouter']);
        expect(outcome.result).toMatchObject({ status: 'ok', model: 'or/model' });
        expect(outcome.result.usage).toEqual({ in: 10, out: 3 });
        expect(outcome.result.cost).toBe(0.02);
        expect(outcome.attempts).toHaveLength(1);
        expect(outcome.fallback).toEqual([]);
    });

    it('falls through provider failures and aggregates usage and cost', async () => {
        const calls = [];
        const outcome = await runChunkWithFallback({
            chain: CHAIN,
            run: async (entry) => {
                calls.push(entry.provider);
                if (entry.provider === 'openrouter') {
                    return result('failed', {
                        model: entry.model,
                        errorCode: 'PROVIDER_ERROR',
                        usage: { in: 100, out: 0 },
                        cost: 0.01,
                    });
                }
                if (entry.provider === 'cloudflare') {
                    return result('failed', {
                        model: entry.model,
                        errorCode: 'PROVIDER_REJECTED',
                        usage: { in: 50, out: 0 },
                        cost: null,
                    });
                }
                return result('ok', {
                    model: entry.model,
                    usage: { in: 20, out: 5 },
                    cost: 0.03,
                });
            },
        });
        expect(calls).toEqual(['openrouter', 'cloudflare', 'openai']);
        expect(outcome.result).toMatchObject({ status: 'ok', model: 'qwen2.5:7b' });
        expect(outcome.result.usage).toEqual({ in: 170, out: 5 });
        expect(outcome.result.cost).toBeCloseTo(0.04);
        expect(outcome.fallback.map((entry) => entry.provider)).toEqual(['openrouter', 'cloudflare']);
        expect(outcome.attempts.map((entry) => entry.status)).toEqual(['failed', 'failed', 'ok']);
    });

    it('returns the last error after every provider fails', async () => {
        const outcome = await runChunkWithFallback({
            chain: CHAIN,
            run: async (entry) => result('failed', {
                model: entry.model,
                errorCode: `ERR_${entry.provider}`,
                usage: { in: 1, out: 2 },
            }),
        });
        expect(outcome.result).toMatchObject({ status: 'failed', errorCode: 'ERR_openai' });
        expect(outcome.result.usage).toEqual({ in: 3, out: 6 });
        expect(outcome.attempts).toHaveLength(3);
        expect(outcome.fallback).toHaveLength(2);
    });

    it('treats truncated and cancelled results as terminal, not failures', async () => {
        for (const status of ['truncated', 'cancelled']) {
            const calls = [];
            const outcome = await runChunkWithFallback({
                chain: CHAIN,
                run: async (entry) => {
                    calls.push(entry.provider);
                    return result(status, { model: entry.model });
                },
            });
            expect(calls).toEqual(['openrouter']);
            expect(outcome.result.status).toBe(status);
        }
    });

    it('does not fall back when a successful result still has rejected documents', async () => {
        const calls = [];
        const outcome = await runChunkWithFallback({
            chain: CHAIN,
            run: async (entry) => {
                calls.push(entry.provider);
                return result('ok', {
                    model: entry.model,
                    rejected: [{ index: 1, error: 'BAD_FIELD' }],
                });
            },
        });
        expect(calls).toEqual(['openrouter']);
        expect(outcome.fallback).toEqual([]);
        expect(outcome.result.rejected).toHaveLength(1);
    });

    it('moves on after an unexpected thrown error', async () => {
        const outcome = await runChunkWithFallback({
            chain: CHAIN,
            run: async (entry) => {
                if (entry.provider === 'openrouter') throw Object.assign(new Error('boom'), { code: 'PROVIDER_ERROR' });
                return result('ok', { model: entry.model, usage: { in: 4, out: 6 } });
            },
        });
        expect(outcome.result).toMatchObject({ status: 'ok', model: '@cf/meta/llama' });
        expect(outcome.result.usage).toEqual({ in: 4, out: 6 });
        expect(outcome.attempts[0]).toMatchObject({ provider: 'openrouter', status: 'failed', errorCode: 'PROVIDER_ERROR' });
    });

    it('carries the provider error detail and retry-after to the UI', async () => {
        const outcome = await runChunkWithFallback({
            chain: [CHAIN[0]],
            run: async () => {
                throw Object.assign(new Error('Rate limited (429): free model limit exceeded'), {
                    code: 'PROVIDER_RATE_LIMITED',
                    retryAfterMs: 60_000,
                });
            },
        });
        expect(outcome.result).toMatchObject({
            status: 'failed',
            errorCode: 'PROVIDER_RATE_LIMITED',
            errorDetail: 'Rate limited (429): free model limit exceeded',
            retryAfterMs: 60_000,
        });
        expect(outcome.attempts[0]).toMatchObject({
            provider: 'openrouter',
            errorCode: 'PROVIDER_RATE_LIMITED',
            retryAfterMs: 60_000,
        });
    });

    it('fails cleanly when the chain is empty', async () => {
        const outcome = await runChunkWithFallback({ chain: [], run: async () => result('ok') });
        expect(outcome.result.status).toBe('failed');
        expect(outcome.result.errorCode).toBe('PROVIDER_ERROR');
        expect(outcome.attempts).toEqual([]);
    });
});
