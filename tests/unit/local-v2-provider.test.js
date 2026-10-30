// The v2 provider.
//
// It has to look exactly like the v1 provider to `runChunk()`: same request
// shape, same return shape. The two things worth testing beyond that are the
// reasoning strip (the extractor must never parse a thought) and the text-only
// refusal (v2 has no vision path).

import { describe, it, expect, vi } from 'vitest';
import { createWebLlmProvider, stripReasoning } from '../../src/features/import-agent/local-v2/provider.js';

const model = {
    id: 'LFM2.5-8B-A1B-q4f16_1-MLC',
    contextWindow: 4096,
    sampling: { temperature: 0.7, topP: 0.95, frequencyPenalty: 0.5 },
};

function engineReturning(content, extra = {}) {
    const chat = vi.fn(async () => ({
        choices: [{ message: { content }, finish_reason: extra.finishReason ?? 'stop' }],
        usage: extra.usage,
    }));
    return { chat };
}

// The marker reasoning models emit around their thinking.
const M = '\uFF5C\uFF5C\uFF5C';

describe('stripReasoning', () => {
    it('removes a complete thinking block', () => {
        expect(stripReasoning(`${M}weighing the sheet${M}The answer`)).toBe('The answer');
        expect(stripReasoning('<thinking>step one\nstep two</thinking>{"rows":[]}')).toBe('{"rows":[]}');
        expect(stripReasoning('<|channel>thoughtinternal<channel|>final')).toBe('final');
    });

    it('returns nothing when the model never finished thinking', () => {
        expect(stripReasoning('<thinking>I should look at the sheet')).toBe('');
        expect(stripReasoning('<|channel>thoughtstill going')).toBe('');
        expect(stripReasoning(`${M}still thinking`)).toBe('');
    });

    it('leaves ordinary text alone', () => {
        expect(stripReasoning('rows:\n  - name: Ali')).toBe('rows:\n  - name: Ali');
        expect(stripReasoning('')).toBe('');
        expect(stripReasoning(null)).toBe('');
    });

    it('trims the leading whitespace the block leaves behind', () => {
        expect(stripReasoning(`${M}thinking${M}\n\n  {"rows":[]}`)).toBe('{"rows":[]}');
    });
});

describe('createWebLlmProvider', () => {
    it('sends the system and user text as an OpenAI chat request', async () => {
        const engine = engineReturning('done');
        const provider = createWebLlmProvider({ engine, model });

        const result = await provider.complete({
            system: 'you extract rows',
            user: [{ type: 'text', text: 'Name: Ali' }],
            maxTokens: 1200,
        });

        const request = engine.chat.mock.calls[0][0];
        expect(request.messages).toEqual([
            { role: 'system', content: 'you extract rows' },
            { role: 'user', content: 'Name: Ali' },
        ]);
        expect(request.max_tokens).toBe(1200);
        expect(request.temperature).toBe(0.7);
        expect(request.top_p).toBe(0.95);
        expect(request.frequency_penalty).toBe(0.5);
        expect(result).toEqual({
            text: 'done',
            finishReason: 'stop',
            usage: { in: 0, out: 1 },
            model: model.id,
            cost: 0,
        });
    });

    it('joins several text parts', async () => {
        const engine = engineReturning('ok');
        const provider = createWebLlmProvider({ engine, model });
        await provider.complete({ user: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] });
        expect(engine.chat.mock.calls[0][0].messages[1].content).toBe('a\nb');
    });

    it('caps the output at the ceiling the extractor relies on', async () => {
        const engine = engineReturning('ok');
        const provider = createWebLlmProvider({ engine, model });
        await provider.complete({ user: [{ type: 'text', text: 'a' }], maxTokens: 99_999 });
        expect(engine.chat.mock.calls[0][0].max_tokens).toBe(4096);
    });

    it('strips the reasoning block before the extractor sees it', async () => {
        const engine = engineReturning(`${M}counting rows${M}{"rows":[{"name":"Ali"}]}`);
        const provider = createWebLlmProvider({ engine, model });
        const result = await provider.complete({ user: [{ type: 'text', text: 'a' }] });
        expect(result.text).toBe('{"rows":[{"name":"Ali"}]}');
    });

    it('reports a truncated answer as length', async () => {
        const engine = engineReturning('half a row', { finishReason: 'length' });
        const provider = createWebLlmProvider({ engine, model });
        const result = await provider.complete({ user: [{ type: 'text', text: 'a' }] });
        expect(result.finishReason).toBe('length');
    });

    it('uses the provider token counts when the engine reports them', async () => {
        const engine = engineReturning('ok', { usage: { prompt_tokens: 320, completion_tokens: 48 } });
        const provider = createWebLlmProvider({ engine, model });
        const result = await provider.complete({ user: [{ type: 'text', text: 'a' }] });
        expect(result.usage).toEqual({ in: 320, out: 48 });
    });

    it('refuses a photo instead of dropping it', async () => {
        const engine = engineReturning('ok');
        const provider = createWebLlmProvider({ engine, model });
        await expect(provider.complete({
            user: [{ type: 'text', text: 'a' }, { type: 'image', dataUrl: 'data:image/png;base64,AA' }],
        })).rejects.toMatchObject({ code: 'MODEL_NOT_MULTIMODAL' });
        expect(engine.chat).not.toHaveBeenCalled();
    });

    it('names the model for the job payload', () => {
        const provider = createWebLlmProvider({ engine: engineReturning('ok'), model });
        expect(provider.model).toBe(model.id);
        expect(provider.multimodal).toBe(false);
    });

    it('falls back to the catalog defaults for an unknown sampling value', async () => {
        const engine = engineReturning('ok');
        const provider = createWebLlmProvider({ engine, model: { id: 'x' } });
        await provider.complete({ user: [{ type: 'text', text: 'a' }] });
        const request = engine.chat.mock.calls[0][0];
        expect(request.temperature).toBe(0.7);
        expect(request.top_p).toBe(0.95);
        expect(request.frequency_penalty).toBe(0.5);
    });
});
