// M4 extensions: ordered mixed-provider chains, strict admin validation and
// explicit health codes. These are the rules the Settings endpoint and the
// extraction pump rely on, tested without Deno or a database.
import { describe, expect, it } from 'vitest';
import {
    chainFromRow,
    encryptSecret,
    parseModelChain,
    providerHealth,
    providerPresence,
    readAiChain,
    SettingsError,
    validateModelChain,
} from '../../supabase/functions/_shared/ai-settings.ts';

const SECRET = 'test-enc-key-material';
const ACCOUNT = 'a'.repeat(32);

const codeOf = async (promise) => {
    try {
        await promise;
        return null;
    } catch (err) {
        return err instanceof SettingsError ? err.code : `UNEXPECTED:${err.message}`;
    }
};

async function encryptedRow(overrides = {}) {
    return {
        provider: 'openrouter',
        enabled: true,
        model: 'google/gemini-2.5-flash-lite',
        model_chain: [],
        openrouter_key_encrypted: await encryptSecret(SECRET, 'sk-or-test'),
        cloudflare_account_id: ACCOUNT,
        cloudflare_token_encrypted: await encryptSecret(SECRET, 'cf-token'),
        openai_base_url: 'http://localhost:11434/v1',
        openai_key_encrypted: null,
        ...overrides,
    };
}

describe('chainFromRow', () => {
    it('prefers model_chain and keeps its order', () => {
        const chain = chainFromRow({
            provider: 'openrouter',
            model: 'legacy/model',
            model_chain: [
                { provider: 'cloudflare', model: '@cf/meta/llama-3-8b-instruct' },
                { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' },
            ],
        });
        expect(chain).toEqual([
            { provider: 'cloudflare', model: '@cf/meta/llama-3-8b-instruct' },
            { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' },
        ]);
    });

    it('falls back to the legacy single provider/model row', () => {
        expect(chainFromRow({
            provider: 'openai',
            model: ' qwen2.5:7b ',
            model_chain: [],
        })).toEqual([{ provider: 'openai', model: 'qwen2.5:7b' }]);
    });

    it('returns an empty chain when neither source is usable', () => {
        expect(chainFromRow({ provider: 'openrouter', model: '', model_chain: null })).toEqual([]);
        expect(chainFromRow({ provider: 'weird', model: 'x', model_chain: [] })).toEqual([]);
    });

    it('drops malformed runtime entries instead of crashing the pump', () => {
        expect(parseModelChain([
            { provider: 'openrouter', model: 'ok/model' },
            { provider: 'nope', model: 'bad/provider' },
            { provider: 'cloudflare', model: '   ' },
            null,
        ])).toEqual([{ provider: 'openrouter', model: 'ok/model' }]);
    });
});

describe('validateModelChain', () => {
    it('accepts an ordered mixed-provider chain', () => {
        const result = validateModelChain([
            { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' },
            { provider: 'cloudflare', model: '@cf/meta/llama-3-8b-instruct' },
            { provider: 'openai', model: 'qwen2.5:7b' },
        ]);
        expect(result.error).toBeUndefined();
        expect(result.entries).toHaveLength(3);
    });

    it('rejects empty, partial, unknown-provider and over-long rows', () => {
        expect(validateModelChain([{ provider: '', model: '' }]).error.code).toBe('CHAIN_INCOMPLETE');
        expect(validateModelChain([{ provider: 'openrouter', model: ' ' }]).error.code).toBe('CHAIN_INCOMPLETE');
        expect(validateModelChain([{ provider: 'other', model: 'x' }]).error.code).toBe('CHAIN_INCOMPLETE');
        expect(validateModelChain([{ provider: 'openai', model: 'x'.repeat(161) }]).error.code).toBe('MODEL_TOO_LONG');
    });

    it('rejects duplicate provider-model pairs case-insensitively', () => {
        const result = validateModelChain([
            { provider: 'openai', model: 'Qwen2.5' },
            { provider: 'openai', model: 'qwen2.5' },
        ]);
        expect(result.error).toMatchObject({ code: 'CHAIN_DUPLICATE', index: 1, provider: 'openai' });
    });

    it('caps the chain length', () => {
        const rows = Array.from({ length: 9 }, (_, index) => ({
            provider: 'openai',
            model: `model-${index}`,
        }));
        expect(validateModelChain(rows).error.code).toBe('CHAIN_TOO_LONG');
    });

    it('treats a missing chain as empty', () => {
        expect(validateModelChain(undefined)).toEqual({ entries: [] });
    });
});

describe('readAiChain', () => {
    it('decrypts each ready provider in order', async () => {
        const row = await encryptedRow({
            model_chain: [
                { provider: 'openrouter', model: 'or/model' },
                { provider: 'cloudflare', model: '@cf/meta/llama' },
                { provider: 'openai', model: 'qwen2.5:7b' },
            ],
        });
        const result = await readAiChain(row, SECRET);
        expect(result.skipped).toEqual([]);
        expect(result.entries.map((entry) => entry.provider)).toEqual(['openrouter', 'cloudflare', 'openai']);
        expect(result.entries[0].apiKey).toBe('sk-or-test');
        expect(result.entries[1]).toMatchObject({ apiKey: 'cf-token', accountId: ACCOUNT });
        expect(result.entries[2]).toMatchObject({ apiKey: null, baseUrl: 'http://localhost:11434/v1' });
    });

    it('skips an unready secondary but keeps the ready primary', async () => {
        const row = await encryptedRow({
            cloudflare_token_encrypted: null,
            model_chain: [
                { provider: 'openrouter', model: 'or/model' },
                { provider: 'cloudflare', model: '@cf/meta/llama' },
            ],
        });
        const result = await readAiChain(row, SECRET);
        expect(result.entries.map((entry) => entry.provider)).toEqual(['openrouter']);
        expect(result.skipped).toEqual([{
            provider: 'cloudflare',
            model: '@cf/meta/llama',
            code: 'NOT_CONFIGURED',
        }]);
    });

    it('reports a corrupt key as DECRYPT_FAILED and still returns a healthy fallback', async () => {
        const row = await encryptedRow({
            openrouter_key_encrypted: 'v1.bad.bad',
            model_chain: [
                { provider: 'openrouter', model: 'or/model' },
                { provider: 'openai', model: 'qwen2.5:7b' },
            ],
        });
        const result = await readAiChain(row, SECRET);
        expect(result.entries.map((entry) => entry.provider)).toEqual(['openai']);
        expect(result.skipped[0]).toMatchObject({ provider: 'openrouter', code: 'DECRYPT_FAILED' });
    });

    it('reports a missing encryption key separately from a corrupt key', async () => {
        const row = await encryptedRow({
            model_chain: [{ provider: 'openrouter', model: 'or/model' }],
        });
        const result = await readAiChain(row, '');
        expect(result.entries).toEqual([]);
        expect(result.skipped).toEqual([{
            provider: 'openrouter',
            model: 'or/model',
            code: 'ENCRYPTION_KEY_MISSING',
        }]);
    });

    it('still runs a keyless OpenAI-compatible entry without an encryption key', async () => {
        const row = await encryptedRow({
            openrouter_key_encrypted: null,
            cloudflare_token_encrypted: null,
            model_chain: [{ provider: 'openai', model: 'qwen2.5:7b' }],
        });
        const result = await readAiChain(row, '');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({
            provider: 'openai',
            apiKey: null,
            baseUrl: 'http://localhost:11434/v1',
        });
        expect(result.skipped).toEqual([]);
    });

    it('returns no entries when every chain entry is unready', async () => {
        const row = await encryptedRow({
            openrouter_key_encrypted: null,
            cloudflare_token_encrypted: null,
            openai_base_url: null,
            model_chain: [
                { provider: 'openrouter', model: 'or/model' },
                { provider: 'cloudflare', model: '@cf/meta/llama' },
                { provider: 'openai', model: 'qwen2.5:7b' },
            ],
        });
        const result = await readAiChain(row, SECRET);
        expect(result.entries).toEqual([]);
        expect(result.skipped.map((entry) => entry.code)).toEqual([
            'NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED',
        ]);
    });

    it('deduplicates repeated pairs at runtime', async () => {
        const row = await encryptedRow({
            model_chain: [
                { provider: 'openrouter', model: 'or/model' },
                { provider: 'openrouter', model: 'OR/MODEL' },
            ],
        });
        const result = await readAiChain(row, SECRET);
        expect(result.entries).toHaveLength(1);
    });

    it('refuses a disabled row', async () => {
        const row = await encryptedRow({ enabled: false });
        expect(await codeOf(readAiChain(row, SECRET))).toBe('FEATURE_DISABLED');
    });
});

describe('providerHealth', () => {
    it('flags a missing encryption key only when a secret is needed', async () => {
        const row = await encryptedRow();
        expect(await providerHealth(row, 'openrouter', '')).toMatchObject({
            configured: true, healthy: false, code: 'ENCRYPTION_KEY_MISSING',
        });

        const keyless = await encryptedRow({
            openrouter_key_encrypted: null,
            cloudflare_token_encrypted: null,
            openai_base_url: 'http://localhost:11434/v1',
            openai_key_encrypted: null,
        });
        expect(await providerHealth(keyless, 'openai', '')).toMatchObject({
            configured: true, healthy: true, code: null,
        });
    });

    it('flags a corrupt stored secret without throwing', async () => {
        const row = await encryptedRow({ openrouter_key_encrypted: 'v1.bad.bad' });
        expect(await providerHealth(row, 'openrouter', SECRET)).toMatchObject({
            configured: true, healthy: false, code: 'DECRYPT_FAILED',
        });
    });

    it('reports presence without decrypting', async () => {
        const row = await encryptedRow({ openai_base_url: null });
        expect(providerPresence(row)).toEqual({
            openrouter: true,
            cloudflare: true,
            openai: false,
        });
    });
});
