// M4: per-chunk extraction orchestration (spec §7) — happy path, repair loop,
// truncation, provider failures and cancellation, driven by a fake provider.
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { runChunk, maxTokensFor } from '../../supabase/functions/import-extract/run-chunk.js';
import { LlmError } from '../../supabase/functions/_shared/llm/provider.ts';
import { LIMITS } from '../../supabase/functions/_shared/import-core/limits.js';

const CHUNK = {
    source_id: 'S1',
    kind: 'sheet',
    header: 'S1:R1 | Name | National ID',
    lines: [
        { id: 'S1:R2', text: 'S1:R2 | Ahmed | 29805151201234' },
        { id: 'S1:R3', text: 'S1:R3 | Mona | 29903220201567' },
    ],
};

const DOC = `---\nname: "Ahmed"\nnational_id: "29805151201234"\nnotes: []\nunmapped: []\n_uncertain: []\n_src: "S1:R2"`;

function fakeProvider(responses) {
    const calls = [];
    let index = 0;
    return {
        model: 'fake/model',
        calls,
        async complete(request) {
            calls.push(request);
            const next = responses[index];
            index += 1;
            if (typeof next === 'function') return next(request);
            if (next instanceof Error) throw next;
            return {
                text: '', finishReason: 'stop', usage: { in: 10, out: 20 }, model: 'fake/model', ...next,
            };
        },
    };
}

const run = (provider, options = {}) => runChunk({
    provider,
    chunk: { ...CHUNK, ...(options.chunk ?? {}) },
    hints: options.hints ?? '',
    yaml,
    limits: options.limits ?? LIMITS,
    signal: options.signal ?? null,
    delimiter: '<<<SRC-fixed1>>>',
    repairDelimiter: '<<<BAD-fixed1>>>',
});

describe('maxTokensFor (spec §7.2)', () => {
    it('sizes from the chunk with the floor and the ceiling', () => {
        expect(maxTokensFor(2)).toBe(LIMITS.MAX_TOKENS_FLOOR);
        expect(maxTokensFor(10)).toBe(3000);
        expect(maxTokensFor(100)).toBe(LIMITS.MAX_TOKENS_CEILING);
    });
});

describe('runChunk', () => {
    it('extracts documents, reports usage and sends the wrapped request', async () => {
        const provider = fakeProvider([{ text: DOC }]);
        const result = await run(provider, { hints: 'check the mobile column' });
        expect(result.status).toBe('ok');
        expect(result.documents).toHaveLength(1);
        expect(result.documents[0].record.name).toBe('Ahmed');
        expect(result.usage).toEqual({ in: 10, out: 20 });
        expect(result.repairs).toBe(false);
        expect(result.promptId).toBe('extractor@2026-10-17.1');

        const request = provider.calls[0];
        expect(request.temperature).toBe(0);
        expect(request.maxTokens).toBe(maxTokensFor(CHUNK.lines.length));
        expect(request.system).toContain('extraction engine');
        expect(request.user[0].text).toContain('check the mobile column');
        expect(request.user[0].text).toContain('<<<SRC-fixed1>>>');
        expect(request.user[0].text).toContain('S1:R2 | Ahmed | 29805151201234');
    });

    it('runs exactly one repair call and merges the repaired documents', async () => {
        const first = `---\nname: [broken\n${DOC}`;
        const repaired = '---\nname: "Mona"\nnational_id: "29903220201567"\n_src: "S1:R3"';
        const provider = fakeProvider([{ text: first }, { text: repaired }]);
        const result = await run(provider);
        expect(provider.calls).toHaveLength(2);
        expect(result.repairs).toBe(true);
        expect(result.documents.map((d) => d.record.name)).toEqual(['Ahmed', 'Mona']);
        expect(result.rejected).toEqual([]);
        expect(result.usage).toEqual({ in: 20, out: 40 });

        const repairMessage = provider.calls[1].user[0].text;
        expect(repairMessage).toContain('Your previous output could not be fully parsed');
        expect(repairMessage).toContain('name: [broken');
        expect(repairMessage).toContain('<<<BAD-fixed1>>>');
    });

    it('keeps still-bad documents in the tray with the source lines', async () => {
        const provider = fakeProvider([
            { text: `---\n- broken\n` },
            { text: `---\n- still broken\n` },
        ]);
        const result = await run(provider);
        expect(result.status).toBe('ok');
        expect(result.documents).toEqual([]);
        expect(result.rejected).toHaveLength(1);
        expect(result.rejected[0].error).toBe('document is not a YAML mapping');
        expect(result.rejected[0].lines).toEqual(CHUNK.lines);
    });

    it('keeps the original bad documents when the repair call itself fails', async () => {
        const provider = fakeProvider([
            { text: `---\n- broken\n` },
            new LlmError('PROVIDER_ERROR', 'boom', { retryable: true }),
        ]);
        const result = await run(provider);
        expect(result.status).toBe('ok');
        expect(result.rejected).toHaveLength(1);
        expect(result.rejected[0].raw).toBe('- broken');
    });

    it('marks truncation and keeps the documents before the cut (spec §7.4)', async () => {
        const provider = fakeProvider([{ text: `${DOC}\n${DOC}`, finishReason: 'length' }]);
        const result = await run(provider);
        expect(result.status).toBe('truncated');
        expect(result.truncated).toBe(true);
        expect(result.documents).toHaveLength(1);
    });

    it('fails the chunk on OUTPUT_TOO_LARGE without a repair call', async () => {
        const provider = fakeProvider([{ text: 'x'.repeat(210 * 1024) }]);
        const result = await run(provider);
        expect(result.status).toBe('failed');
        expect(result.errorCode).toBe('OUTPUT_TOO_LARGE');
        expect(provider.calls).toHaveLength(1);
    });

    it('maps a provider failure to a failed chunk with its code', async () => {
        const provider = fakeProvider([new LlmError('PROVIDER_RATE_LIMITED', 'busy', { retryable: true })]);
        const result = await run(provider);
        expect(result.status).toBe('failed');
        expect(result.errorCode).toBe('PROVIDER_RATE_LIMITED');
    });

    it('names the OpenRouter data-policy block instead of a generic rejection', async () => {
        const detail = 'Provider rejected the request (404): {"error":{"message":"No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy"}}';
        const provider = fakeProvider([new LlmError('PROVIDER_REJECTED', detail, { status: 404 })]);
        const result = await run(provider);
        expect(result.status).toBe('failed');
        expect(result.errorCode).toBe('DATA_POLICY_BLOCKED');
        expect(result.errorDetail).toContain('No endpoints found matching your data policy');
    });

    it('never calls the provider when the job is already cancelled', async () => {
        const provider = fakeProvider([{ text: DOC }]);
        const result = await run(provider, { signal: AbortSignal.abort() });
        expect(result.status).toBe('cancelled');
        expect(provider.calls).toHaveLength(0);
    });

    it('stops before the repair call when cancellation arrives mid-chunk', async () => {
        const controller = new AbortController();
        const provider = fakeProvider([
            () => {
                controller.abort();
                return { text: `---\n- broken\n` };
            },
        ]);
        const result = await run(provider, { signal: controller.signal });
        expect(result.status).toBe('cancelled');
        expect(provider.calls).toHaveLength(1);
        expect(result.rejected).toHaveLength(1);
    });
});
