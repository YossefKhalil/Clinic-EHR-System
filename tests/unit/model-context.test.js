import { beforeEach, describe, expect, it } from 'vitest';
import {
    clearModelContextCache,
    contextWindowOf,
    jobTokenCapForContext,
    resolveModelContext,
} from '../../supabase/functions/_shared/llm/model-context.ts';
import { LIMITS } from '../../supabase/functions/_shared/import-core/limits.js';

const jsonResponse = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
    clearModelContextCache();
});

describe('contextWindowOf', () => {
    it('reads top-level, nested and provider-specific field names', () => {
        expect(contextWindowOf({ context_length: 262144 })).toBe(262144);
        expect(contextWindowOf({ properties: { max_input_tokens: 131072 } })).toBe(131072);
        expect(contextWindowOf({ meta: { max_model_len: 32768 } })).toBe(32768);
        expect(contextWindowOf({ context_length: '0' })).toBeNull();
        expect(contextWindowOf(null)).toBeNull();
    });
});

describe('resolveModelContext', () => {
    it('reads OpenRouter context_length for the exact model', async () => {
        const model = 'xingchen-agi/xing4.0-29b-a4b:free';
        const fetchImpl = async () => jsonResponse({
            data: [
                { id: 'another/model', context_length: 8192 },
                { id: model, context_length: 262144 },
            ],
        });
        await expect(resolveModelContext({ provider: 'openrouter', model }, { fetchImpl }))
            .resolves.toBe(262144);
    });

    it('reads an OpenAI-compatible max_model_len', async () => {
        const fetchImpl = async (url) => {
            expect(url).toBe('https://example.test/v1/models');
            return jsonResponse({ data: [{ id: 'local-model', max_model_len: 131072 }] });
        };
        await expect(resolveModelContext({
            provider: 'openai',
            model: 'local-model',
            baseUrl: 'https://example.test/v1/',
            apiKey: 'secret',
        }, { fetchImpl })).resolves.toBe(131072);
    });

    it('reads Groq model metadata through the OpenAI-compatible lookup', async () => {
        const fetchImpl = async (url, init) => {
            expect(url).toBe('https://api.groq.com/openai/v1/models');
            expect(init.headers.authorization).toBe('Bearer gsk-test');
            return jsonResponse({
                data: [{ id: 'llama-3.3-70b-versatile', context_window: 131072 }],
            });
        };
        await expect(resolveModelContext({
            provider: 'groq',
            model: 'llama-3.3-70b-versatile',
            baseUrl: 'https://api.groq.com/openai/v1',
            apiKey: 'gsk-test',
        }, { fetchImpl })).resolves.toBe(131072);
    });

    it('reads Cloudflare model properties', async () => {
        const model = '@cf/meta/llama-3.1-8b-instruct';
        const fetchImpl = async (url, init) => {
            expect(url).toContain('/ai/models/search?search=');
            expect(init.headers.authorization).toBe('Bearer token');
            return jsonResponse({
                result: [{ id: model, properties: { max_input_tokens: 65536 } }],
            });
        };
        await expect(resolveModelContext({
            provider: 'cloudflare',
            model,
            accountId: 'a'.repeat(32),
            apiKey: 'token',
        }, { fetchImpl })).resolves.toBe(65536);
    });

    it('returns null instead of throwing when the provider rejects the lookup', async () => {
        const fetchImpl = async () => new Response('nope', { status: 500 });
        await expect(resolveModelContext(
            { provider: 'openrouter', model: 'missing/model' },
            { fetchImpl },
        )).resolves.toBeNull();
    });

    it('caches a successful lookup and a negative result', async () => {
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            return jsonResponse({ data: [{ id: 'm', context_length: 32000 }] });
        };
        const entry = { provider: 'openrouter', model: 'm' };
        await expect(resolveModelContext(entry, { fetchImpl })).resolves.toBe(32000);
        await expect(resolveModelContext(entry, { fetchImpl })).resolves.toBe(32000);
        expect(calls).toBe(1);

        clearModelContextCache();
        const missing = async () => {
            calls += 1;
            return new Response('{}', { status: 404 });
        };
        await expect(resolveModelContext(entry, { fetchImpl: missing })).resolves.toBeNull();
        await expect(resolveModelContext(entry, { fetchImpl: missing })).resolves.toBeNull();
        expect(calls).toBe(2);
    });
});

describe('jobTokenCapForContext', () => {
    it('uses the model context window within safe bounds', () => {
        expect(jobTokenCapForContext(262144, LIMITS)).toBe(262144);
        expect(jobTokenCapForContext(1000, LIMITS)).toBe(LIMITS.JOB_TOKEN_CAP_MIN);
        expect(jobTokenCapForContext(10_000_000, LIMITS)).toBe(LIMITS.JOB_TOKEN_CAP_MAX);
    });

    it('keeps the deployment fallback when the context is unknown', () => {
        expect(jobTokenCapForContext(null, LIMITS)).toBe(LIMITS.JOB_TOKEN_CAP);
    });
});
