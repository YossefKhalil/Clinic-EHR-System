// M4: the LLM layer (spec §7.1) — retry policy, request/response mapping and
// error classification for the three adapters, all with a fake fetch.
import { describe, expect, it } from 'vitest';
import { LlmError, parseRetryAfter, withRetries } from '../../supabase/functions/_shared/llm/provider.ts';
import {
    buildOpenAiBody, createOpenAiCompatibleProvider, mapOpenAiResult, openAiErrorFor,
} from '../../supabase/functions/_shared/llm/openai-compatible.ts';
import { createOpenRouterProvider, modelList, OPENROUTER_PROVIDER_PREFS } from '../../supabase/functions/_shared/llm/openrouter.ts';
import { buildCloudflareBody, createCloudflareProvider, mapCloudflareResult } from '../../supabase/functions/_shared/llm/cloudflare.ts';
import { LIMITS } from '../../supabase/functions/_shared/import-core/limits.js';

const REQUEST = { system: 'sys', user: [{ type: 'text', text: 'hi' }], maxTokens: 100, temperature: 0 };

const okResponse = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
});

const errorResponse = (status, text = '{}', headers = {}) => new Response(text, { status, headers });

describe('parseRetryAfter', () => {
    it('accepts seconds and HTTP dates', () => {
        expect(parseRetryAfter('2')).toBe(2000);
        expect(parseRetryAfter('0')).toBe(0);
        expect(parseRetryAfter(null)).toBeNull();
        expect(parseRetryAfter('soon')).toBeNull();
        const now = 1_700_000_000_000;
        const date = new Date(now + 5000).toUTCString();
        expect(parseRetryAfter(date, now)).toBe(5000);
    });
});

describe('withRetries (spec §7.1)', () => {
    const retryable = (retryAfterMs = null) => new LlmError('PROVIDER_ERROR', 'boom', { retryable: true, retryAfterMs });

    it('retries with exponential backoff plus jitter', async () => {
        const sleeps = [];
        let calls = 0;
        const result = await withRetries(async () => {
            calls += 1;
            if (calls < 3) throw retryable();
            return 'done';
        }, {
            maxAttempts: 3,
            baseDelayMs: 500,
            sleep: async (ms) => { sleeps.push(ms); },
            random: () => 1,
        });
        expect(result).toBe('done');
        expect(calls).toBe(3);
        expect(sleeps).toEqual([500, 1000]);
    });

    it('honours Retry-After over the computed delay', async () => {
        const sleeps = [];
        let calls = 0;
        await withRetries(async () => {
            calls += 1;
            if (calls === 1) throw retryable(5000);
            return 'done';
        }, {
            maxAttempts: 3,
            baseDelayMs: 500,
            sleep: async (ms) => { sleeps.push(ms); },
            random: () => 1,
        });
        expect(sleeps).toEqual([5000]);
    });

    it('gives up after the attempt budget', async () => {
        let calls = 0;
        const promise = withRetries(async () => {
            calls += 1;
            throw retryable();
        }, { maxAttempts: 3, sleep: async () => {} });
        await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
        expect(calls).toBe(3);
    });

    it('never retries non-retryable failures', async () => {
        let calls = 0;
        const promise = withRetries(async () => {
            calls += 1;
            throw new LlmError('PROVIDER_AUTH', 'nope');
        }, { maxAttempts: 3, sleep: async () => {} });
        await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
        expect(calls).toBe(1);
    });

    it('stops immediately when the signal is aborted', async () => {
        let calls = 0;
        const promise = withRetries(async () => {
            calls += 1;
            throw retryable();
        }, { maxAttempts: 3, signal: AbortSignal.abort(), sleep: async () => {} });
        await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
        expect(calls).toBe(1);
    });
});

describe('openai-compatible adapter', () => {
    it('builds the chat-completions body with text and image parts', () => {
        const body = buildOpenAiBody('m1', {
            ...REQUEST,
            user: [{ type: 'text', text: 'hello' }, { type: 'image', dataUrl: 'data:image/png;base64,AAAA' }],
        });
        expect(body.model).toBe('m1');
        expect(body.temperature).toBe(0);
        expect(body.max_tokens).toBe(100);
        expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
        expect(body.messages[1].content).toEqual([
            { type: 'text', text: 'hello' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ]);
    });

    it('maps results: content, join of parts, finish reason, usage, model, cost', () => {
        expect(mapOpenAiResult({
            model: 'm9',
            choices: [{ message: { content: 'hi' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.03 },
        }, 'fallback')).toEqual({
            text: 'hi', finishReason: 'length', usage: { in: 1, out: 2 }, model: 'm9', cost: 0.03,
        });
        const joined = mapOpenAiResult({
            choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] }, finish_reason: 'stop' }],
        }, 'fallback');
        expect(joined.text).toBe('ab');
        expect(joined.model).toBe('fallback');
        expect(joined.cost).toBeNull();
        expect(() => mapOpenAiResult({ choices: [] }, 'm')).toThrowError(/no message content/);
    });

    it('reads the answer of a reasoning model (content is null)', () => {
        // Reasoning models answer in `reasoning_content`; a provider that
        // only looks at `content` reports "no text" for a good answer.
        expect(mapOpenAiResult({
            choices: [{ message: { content: null, reasoning_content: 'the answer' }, finish_reason: 'stop' }],
        }, 'm').text).toBe('the answer');
        expect(mapOpenAiResult({
            choices: [{ message: { content: null, reasoning: 'also the answer' }, finish_reason: 'stop' }],
        }, 'm').text).toBe('also the answer');
        expect(mapOpenAiResult({
            choices: [{ delta: { content: 'streamed answer' } }],
        }, 'm').text).toBe('streamed answer');
    });

    it('sends the parameters the model accepts (Groq, OpenAI reasoning models)', () => {
        // Groq and the o-series reject `max_tokens` with HTTP 400.
        const groq = buildOpenAiBody('llama-3.3-70b-versatile', REQUEST, {}, { preferMaxCompletionTokens: true });
        expect(groq.max_completion_tokens).toBe(100);
        expect(groq.max_tokens).toBeUndefined();
        expect(groq.temperature).toBe(0);

        // A reasoning model rejects `temperature` and needs the effort.
        const reasoning = buildOpenAiBody('deepseek-r1-distill-llama-70b', REQUEST);
        expect(reasoning.max_completion_tokens).toBe(LIMITS.REASONING_MIN_TOKENS);
        expect(reasoning.max_tokens).toBeUndefined();
        expect(reasoning.temperature).toBeUndefined();
        expect(reasoning.reasoning_effort).toBe('low');

        // A plain model keeps the classic shape.
        const plain = buildOpenAiBody('llama-3.1-8b-instant', REQUEST);
        expect(plain.max_tokens).toBe(100);
        expect(plain.max_completion_tokens).toBeUndefined();
    });

    it('classifies HTTP errors: 429/5xx retryable, 401 not, Retry-After honoured', () => {
        const rate = openAiErrorFor(429, 'slow down', '3');
        expect(rate.retryable).toBe(true);
        expect(rate.retryAfterMs).toBe(3000);
        expect(openAiErrorFor(503, 'down', null).retryable).toBe(true);
        expect(openAiErrorFor(401, 'bad key', null)).toMatchObject({ code: 'PROVIDER_AUTH', retryable: false });
        expect(openAiErrorFor(400, 'bad request', null)).toMatchObject({ code: 'PROVIDER_REJECTED', retryable: false });
    });

    it('retries a 429 and completes, sending bearer auth and the endpoint URL', async () => {
        const responses = [
            errorResponse(429, '{"error":"rate"}', { 'retry-after': '1' }),
            okResponse({
                model: 'm1',
                choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 7 },
            }),
        ];
        const calls = [];
        const sleeps = [];
        const provider = createOpenAiCompatibleProvider({
            baseUrl: 'https://api.example.com/v1/',
            apiKey: 'k',
            model: 'm1',
            fetchImpl: async (url, init) => { calls.push({ url, init }); return responses.shift(); },
            maxAttempts: 3,
            timeoutMs: 1000,
            sleep: async (ms) => { sleeps.push(ms); },
            random: () => 1,
        });
        const result = await provider.complete(REQUEST);
        expect(result.text).toBe('hello');
        expect(result.usage).toEqual({ in: 5, out: 7 });
        expect(calls).toHaveLength(2);
        expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions');
        expect(calls[0].init.headers.authorization).toBe('Bearer k');
        expect(sleeps).toEqual([1000]);
    });

    it('does not retry a 401 and wraps network failures as retryable timeouts', async () => {
        let calls = 0;
        const unauthorized = createOpenAiCompatibleProvider({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'k',
            model: 'm1',
            fetchImpl: async () => { calls += 1; return errorResponse(401, 'no'); },
            maxAttempts: 3,
            sleep: async () => {},
        });
        await expect(unauthorized.complete(REQUEST)).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
        expect(calls).toBe(1);

        const down = createOpenAiCompatibleProvider({
            baseUrl: 'https://api.example.com/v1',
            model: 'm1',
            fetchImpl: async () => { throw new TypeError('fetch failed'); },
            maxAttempts: 1,
        });
        await expect(down.complete(REQUEST)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true });
    });
});

describe('openrouter adapter (spec §7.1)', () => {
    it('parses the ordered model list', () => {
        expect(modelList('a, b c')).toEqual(['a', 'b', 'c']);
        expect(modelList(['a', 'b'])).toEqual(['a', 'b']);
        expect(() => modelList('  ')).toThrowError(/no model/i);
    });

    it('denies data collection and only falls back after repeated transient failure', async () => {
        const calls = [];
        const responses = [
            errorResponse(500, '{"error":"down"}'),
            errorResponse(500, '{"error":"down"}'),
            okResponse({ model: 'm2', choices: [{ message: { content: 'ok' } }] }),
        ];
        const provider = createOpenRouterProvider({
            apiKey: 'k',
            model: 'm1, m2',
            appUrl: 'https://app.example.com',
            appTitle: 'Clinic EHR',
            fetchImpl: async (url, init) => { calls.push({ url, init }); return responses.shift(); },
            maxAttempts: 2,
            sleep: async () => {},
        });
        const result = await provider.complete(REQUEST);
        expect(result.text).toBe('ok');
        expect(calls).toHaveLength(3);

        const bodies = calls.map((call) => JSON.parse(call.init.body));
        expect(bodies.map((body) => body.model)).toEqual(['m1', 'm1', 'm2']);
        expect(bodies[0].provider).toEqual(OPENROUTER_PROVIDER_PREFS);
        expect(bodies[0].provider.data_collection).toBe('deny');
        expect(calls[0].init.headers['HTTP-Referer']).toBe('https://app.example.com');
        expect(calls[0].init.headers['X-Title']).toBe('Clinic EHR');
    });

    it('fails immediately on auth errors without trying the fallback model', async () => {
        const calls = [];
        const provider = createOpenRouterProvider({
            apiKey: 'bad',
            model: 'm1, m2',
            fetchImpl: async (url, init) => { calls.push({ url, init }); return errorResponse(401, 'no'); },
            maxAttempts: 3,
            sleep: async () => {},
        });
        await expect(provider.complete(REQUEST)).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
        expect(calls).toHaveLength(1);
    });
});

describe('cloudflare adapter (spec §7.1)', () => {
    it('refuses an image for a text-only model and sends it for a vision model', () => {
        const request = {
            ...REQUEST,
            user: [{ type: 'text', text: 'read this' }, { type: 'image', dataUrl: 'data:image/png;base64,AAAA' }],
        };
        // A model that cannot look at an image: the chain moves on and the
        // user gets "no vision model" instead of a provider error.
        expect(() => buildCloudflareBody(request, '@cf/meta/llama-3.3-70b-instruct'))
            .toThrowError(/cannot read images/);
        // A vision model: the image travels with the message.
        const body = buildCloudflareBody(request, '@cf/meta/llama-3.2-11b-vision-instruct');
        expect(body.messages[1].content).toEqual([
            { type: 'text', text: 'read this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ]);
    });

    it('maps the Workers AI envelope and its failure shape', () => {
        const result = mapCloudflareResult({
            success: true,
            result: { response: 'ok', finish_reason: 'length', usage: { prompt_tokens: 3, completion_tokens: 4 } },
        }, '@cf/model');
        expect(result).toMatchObject({
            text: 'ok', finishReason: 'length', usage: { in: 3, out: 4 }, model: '@cf/model',
        });
        expect(() => mapCloudflareResult({ success: false, errors: [{ message: 'nope' }] }, 'm'))
            .toThrowError(/nope/);
    });

    it('maps the newer OpenAI-style Workers AI response', () => {
        const result = mapCloudflareResult({
            success: true,
            result: {
                model: '@cf/qwen/qwen3.8-27b',
                choices: [{ message: { content: 'hello from qwen' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 7 },
            },
        }, '@cf/fallback');
        expect(result).toEqual({
            text: 'hello from qwen',
            finishReason: 'stop',
            usage: { in: 5, out: 7 },
            model: '@cf/qwen/qwen3.8-27b',
        });
    });

    it('accepts a direct OpenAI-style body and joins content parts', () => {
        const result = mapCloudflareResult({
            choices: [{
                message: { content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] },
                finish_reason: 'length',
            }],
            usage: { input_tokens: 2, output_tokens: 3 },
        }, '@cf/fallback');
        expect(result).toMatchObject({
            text: 'part one part two',
            finishReason: 'length',
            usage: { in: 2, out: 3 },
            model: '@cf/fallback',
        });
    });

    it('reports the response keys when Workers AI sends no text', () => {
        expect(() => mapCloudflareResult({
            success: true,
            result: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } },
        }, 'm')).toThrowError(/no text \(result keys: choices, usage/);
    });

    it('uses Qwen reasoning content when content is null', () => {
        const result = mapCloudflareResult({
            success: true,
            result: {
                choices: [{
                    message: { content: null, reasoning_content: 'answer from reasoning' },
                    finish_reason: 'stop',
                }],
            },
        }, 'm');
        expect(result.text).toBe('answer from reasoning');
    });

    it('reads the answer of a reasoning model on Workers AI (content is null)', () => {
        // The shape Cloudflare returned for @cf/qwen/qwen3.8-27b: an
        // OpenAI-style answer whose `content` is null because the model spent
        // its budget on reasoning. The old code reported "returned no text".
        const reasoningAnswer = {
            id: 'chat-1',
            object: 'chat.completion',
            created: 1,
            model: '@cf/qwen/qwen3.8-27b',
            choices: [{
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: null, reasoning_content: '---\nname: "Youssef"\n' },
            }],
            service_tier: 'default',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        };
        const result = mapCloudflareResult({ success: true, result: reasoningAnswer }, '@cf/qwen/qwen3.8-27b');
        expect(result.text).toContain('Youssef');
        expect(result.model).toBe('@cf/qwen/qwen3.8-27b');

        // The same answer without the envelope.
        expect(mapCloudflareResult(reasoningAnswer, 'm').text).toContain('Youssef');
    });

    it('names an exhausted completion budget instead of "no text"', () => {
        const truncated = {
            choices: [{
                finish_reason: 'length',
                message: { content: null, reasoning_content: 'thinking...' },
            }],
        };
        // The reasoning is only the model's thinking when it ran out of
        // budget: it must not be parsed as data.
        expect(() => mapCloudflareResult({ success: true, result: truncated }, 'm'))
            .toThrowError(/completion budget/);
        expect(() => mapOpenAiResult(truncated, 'm')).toThrowError(/completion budget/);
    });

    it('gives Qwen 3.8 a low reasoning budget and the completion-token field', () => {
        const body = buildCloudflareBody(REQUEST, '@cf/qwen/qwen3.8-27b');
        expect(body).toMatchObject({
            // The reasoning floor: the hidden reasoning is billed against the
            // same budget, so a small chunk must not be spent on reasoning
            // alone (the model then answers nothing).
            max_completion_tokens: LIMITS.REASONING_MIN_TOKENS,
            reasoning_effort: 'low',
        });
        expect(body.max_tokens).toBeUndefined();
        expect(buildCloudflareBody(REQUEST, '@cf/meta/llama-3.1-8b-instruct')).toMatchObject({
            max_tokens: 100,
        });
    });

    it('calls the account endpoint with the model path and maps the result', async () => {
        const calls = [];
        const provider = createCloudflareProvider({
            accountId: 'acc1',
            apiKey: 'tok',
            model: '@cf/meta/llama-3.1-8b-instruct',
            fetchImpl: async (url, init) => {
                calls.push({ url, init });
                return okResponse({
                    success: true,
                    result: { response: 'hello', usage: { prompt_tokens: 1, completion_tokens: 2 } },
                });
            },
            maxAttempts: 1,
            timeoutMs: 1000,
        });
        const result = await provider.complete(REQUEST);
        expect(result.text).toBe('hello');
        expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc1/ai/run/@cf/meta/llama-3.1-8b-instruct');
        expect(calls[0].init.headers.authorization).toBe('Bearer tok');
        expect(JSON.parse(calls[0].init.body)).toMatchObject({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
            max_tokens: 100,
            temperature: 0,
        });
    });
});
