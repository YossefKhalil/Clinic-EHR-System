// M4: encrypted provider settings (spec §13.6) — AES-GCM under an HKDF-derived
// key, explicit decryption failures, and per-provider validation.
import { describe, expect, it } from 'vitest';
import {
    decryptSecret, encryptSecret, readAiSettings, SettingsError,
} from '../../supabase/functions/_shared/ai-settings.ts';

const SECRET = 'test-enc-key-material';

const baseRow = {
    provider: 'openrouter',
    enabled: true,
    model: 'google/gemini-2.5-flash-lite',
};

const codeOf = async (promise) => {
    try {
        await promise;
        return null;
    } catch (err) {
        return err instanceof SettingsError ? err.code : `UNEXPECTED:${err.message}`;
    }
};

describe('encryptSecret / decryptSecret', () => {
    it('round-trips, including non-ASCII text', async () => {
        const stored = await encryptSecret(SECRET, 'sk-or-v1-abcdef');
        expect(stored).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
        expect(await decryptSecret(SECRET, stored)).toBe('sk-or-v1-abcdef');

        const arabic = await encryptSecret(SECRET, 'مفتاح سري ١٢٣');
        expect(await decryptSecret(SECRET, arabic)).toBe('مفتاح سري ١٢٣');
    });

    it('uses a fresh IV per encryption', async () => {
        const first = await encryptSecret(SECRET, 'same');
        const second = await encryptSecret(SECRET, 'same');
        expect(first).not.toBe(second);
        expect(await decryptSecret(SECRET, first)).toBe('same');
        expect(await decryptSecret(SECRET, second)).toBe('same');
    });

    it('fails explicitly on a wrong key, tampering and malformed input', async () => {
        expect(await codeOf(decryptSecret('other-key', await encryptSecret(SECRET, 'x')))).toBe('DECRYPT_FAILED');
        const stored = await encryptSecret(SECRET, 'x');
        const [version, iv, ciphertext] = stored.split('.');
        const tampered = `${version}.${iv}.${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`;
        expect(await codeOf(decryptSecret(SECRET, tampered))).toBe('DECRYPT_FAILED');
        expect(await codeOf(decryptSecret(SECRET, 'garbage'))).toBe('DECRYPT_FAILED');
        expect(await codeOf(decryptSecret(SECRET, 'v1.abc'))).toBe('DECRYPT_FAILED');
        expect(await codeOf(decryptSecret(SECRET, ''))).toBe('DECRYPT_FAILED');
        expect(await codeOf(decryptSecret('', stored))).toBe('ENCRYPTION_KEY_MISSING');
    });
});

describe('readAiSettings', () => {
    it('requires the feature flag and a model', async () => {
        expect(await codeOf(readAiSettings({ ...baseRow, enabled: false }, SECRET))).toBe('FEATURE_DISABLED');
        expect(await codeOf(readAiSettings({ ...baseRow, model: '' }, SECRET))).toBe('NOT_CONFIGURED');
    });

    it('decrypts exactly the key its provider needs', async () => {
        const credentials = await readAiSettings({
            ...baseRow,
            openrouter_key_encrypted: await encryptSecret(SECRET, 'or-key'),
        }, SECRET);
        expect(credentials).toEqual({
            provider: 'openrouter',
            model: 'google/gemini-2.5-flash-lite',
            apiKey: 'or-key',
            accountId: null,
            baseUrl: null,
        });
    });

    it('reports NOT_CONFIGURED for missing keys and DECRYPT_FAILED for unreadable ones', async () => {
        expect(await codeOf(readAiSettings({ ...baseRow }, SECRET))).toBe('NOT_CONFIGURED');
        expect(await codeOf(readAiSettings({
            ...baseRow,
            openrouter_key_encrypted: 'v1.not.a.real.payload',
        }, SECRET))).toBe('DECRYPT_FAILED');
    });

    it('handles cloudflare and openai-compatible rows', async () => {
        const token = await encryptSecret(SECRET, 'cf-token');
        const cloudflare = await readAiSettings({
            ...baseRow,
            provider: 'cloudflare',
            cloudflare_account_id: 'acc1',
            cloudflare_token_encrypted: token,
        }, SECRET);
        expect(cloudflare).toEqual({
            provider: 'cloudflare',
            model: 'google/gemini-2.5-flash-lite',
            apiKey: 'cf-token',
            accountId: 'acc1',
            baseUrl: null,
        });
        expect(await codeOf(readAiSettings({
            ...baseRow, provider: 'cloudflare', cloudflare_account_id: 'acc1',
        }, SECRET))).toBe('NOT_CONFIGURED');

        const local = await readAiSettings({
            ...baseRow,
            provider: 'openai',
            openai_base_url: 'http://localhost:11434/v1',
        }, SECRET);
        expect(local).toEqual({
            provider: 'openai',
            model: 'google/gemini-2.5-flash-lite',
            apiKey: null,
            accountId: null,
            baseUrl: 'http://localhost:11434/v1',
        });
        expect(await codeOf(readAiSettings({ ...baseRow, provider: 'openai' }, SECRET))).toBe('NOT_CONFIGURED');
        expect(await codeOf(readAiSettings({ ...baseRow, provider: 'weird' }, SECRET))).toBe('NOT_CONFIGURED');
    });
});
