// Encrypted provider settings (spec 13.6).
//
// The single `ai_settings` row is reachable only through the service role.
// Provider credentials are stored as `v1.<iv>.<ciphertext>` (base64), AES-GCM
// 256, under a key derived with HKDF-SHA256 from the dedicated
// AI_SETTINGS_ENC_KEY secret, never from the service-role key. A decryption
// failure is an explicit error ("re-enter credentials"), never "no key".
//
// `model_chain` is an ordered list of { provider, model } entries. The job
// tries each ready entry in order. `provider`/`model` remain for rows written
// before the chain existed and for an older deployed job function.

export const HKDF_SALT = 'import-agent/ai-settings/v1';
export const HKDF_INFO = 'aes-gcm-256';

export const MAX_MODEL_CHAIN = 8;
export const MAX_MODEL_LENGTH = 160;

export type AiProviderId = 'openrouter' | 'cloudflare' | 'openai' | 'groq';

export const AI_PROVIDERS: readonly AiProviderId[] = ['openrouter', 'cloudflare', 'openai', 'groq'];

/** Groq exposes an OpenAI-compatible API; the key is the only credential. */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export class SettingsError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'SettingsError';
        this.code = code;
    }
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** HKDF-SHA256(secret) -> AES-GCM-256 key. */
export async function deriveAesKey(secret: string, usages: KeyUsage[] = ['decrypt']): Promise<CryptoKey> {
    if (!secret) throw new SettingsError('ENCRYPTION_KEY_MISSING', 'AI_SETTINGS_ENC_KEY is not set');
    const encoder = new TextEncoder();
    const material = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode(HKDF_SALT),
            info: encoder.encode(HKDF_INFO),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        usages,
    );
}

/** Encrypt for storage (used by the admin path and by tests). */
export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
    const key = await deriveAesKey(secret, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext),
    );
    return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

const STORED_FORMAT = /^v1\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/;

/** Decrypt a stored secret; failures are explicit, never silent. */
export async function decryptSecret(secret: string, stored: string): Promise<string> {
    const match = STORED_FORMAT.exec(String(stored ?? '').trim());
    if (!match) {
        throw new SettingsError('DECRYPT_FAILED', 'Stored key cannot be decrypted, re-enter credentials');
    }
    try {
        const key = await deriveAesKey(secret, ['decrypt']);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fromBase64(match[1]) },
            key,
            fromBase64(match[2]),
        );
        return new TextDecoder().decode(plaintext);
    } catch (err) {
        if (err instanceof SettingsError && err.code === 'ENCRYPTION_KEY_MISSING') throw err;
        throw new SettingsError('DECRYPT_FAILED', 'Stored key cannot be decrypted, re-enter credentials');
    }
}

export interface AiSettingsRow {
    provider: AiProviderId;
    enabled: boolean;
    model: string;
    model_chain?: unknown;
    openrouter_key_encrypted?: string | null;
    cloudflare_account_id?: string | null;
    cloudflare_token_encrypted?: string | null;
    openai_base_url?: string | null;
    openai_key_encrypted?: string | null;
    groq_key_encrypted?: string | null;
}

export interface ModelChainEntry {
    provider: AiProviderId;
    model: string;
}

export interface ChainSkip {
    provider: string;
    model: string;
    code: string;
}

export interface ProviderCredentials {
    provider: AiProviderId;
    /** One model from the chain. */
    model: string;
    apiKey: string | null;
    accountId: string | null;
    baseUrl: string | null;
}

export interface ProviderHealth {
    configured: boolean;
    healthy: boolean;
    code: string | null;
}

export function isAiProvider(value: unknown): value is AiProviderId {
    return value === 'openrouter' || value === 'cloudflare' || value === 'openai' || value === 'groq';
}

/**
 * Runtime reader for the chain. Invalid entries are dropped rather than
 * crashing an extraction pump; the settings save path is stricter.
 */
export function parseModelChain(value: unknown): ModelChainEntry[] {
    if (!Array.isArray(value)) return [];
    const entries: ModelChainEntry[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const provider = (item as { provider?: unknown }).provider;
        const rawModel = (item as { model?: unknown }).model;
        const model = typeof rawModel === 'string' ? rawModel.trim() : '';
        if (isAiProvider(provider) && model) entries.push({ provider, model });
    }
    return entries;
}

export interface ChainValidationResult {
    entries: ModelChainEntry[];
    error?: { code: string; index?: number; provider?: string };
}

/** Strict validator for the admin save action. */
export function validateModelChain(value: unknown): ChainValidationResult {
    if (value === undefined || value === null) return { entries: [] };
    if (!Array.isArray(value)) return { entries: [], error: { code: 'BAD_REQUEST' } };
    if (value.length > MAX_MODEL_CHAIN) {
        return { entries: [], error: { code: 'CHAIN_TOO_LONG' } };
    }
    const entries: ModelChainEntry[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (!item || typeof item !== 'object') {
            return { entries: [], error: { code: 'CHAIN_INCOMPLETE', index } };
        }
        const provider = (item as { provider?: unknown }).provider;
        const rawModel = (item as { model?: unknown }).model;
        const model = typeof rawModel === 'string' ? rawModel.trim() : '';
        if (!isAiProvider(provider)) {
            return { entries: [], error: { code: 'CHAIN_INCOMPLETE', index } };
        }
        if (!model) {
            return { entries: [], error: { code: 'CHAIN_INCOMPLETE', index, provider } };
        }
        if (model.length > MAX_MODEL_LENGTH) {
            return { entries: [], error: { code: 'MODEL_TOO_LONG', index, provider } };
        }
        const key = `${provider}\u0000${model.toLowerCase()}`;
        if (seen.has(key)) {
            return { entries: [], error: { code: 'CHAIN_DUPLICATE', index, provider } };
        }
        seen.add(key);
        entries.push({ provider, model });
    }
    return { entries };
}

/** Chain first, then the pre-chain single provider/model row. */
export function chainFromRow(row: AiSettingsRow): ModelChainEntry[] {
    const chain = parseModelChain(row?.model_chain);
    if (chain.length > 0) return chain;
    const model = String(row?.model ?? '').trim();
    if (isAiProvider(row?.provider) && model) return [{ provider: row.provider, model }];
    return [];
}

export function providerPresence(row: AiSettingsRow): Record<AiProviderId, boolean> {
    return {
        openrouter: Boolean(row?.openrouter_key_encrypted),
        cloudflare: Boolean(row?.cloudflare_account_id && row?.cloudflare_token_encrypted),
        openai: Boolean(row?.openai_base_url),
        groq: Boolean(row?.groq_key_encrypted),
    };
}

/**
 * Decrypt exactly the secret a provider needs. Throws SettingsError with a
 * code the caller can return or turn into a health flag.
 */
export async function readProviderCredentials(
    row: AiSettingsRow,
    provider: AiProviderId,
    modelValue: string,
    encKey: string,
): Promise<ProviderCredentials> {
    const model = String(modelValue ?? '').trim();
    if (!model) throw new SettingsError('NOT_CONFIGURED', 'No model configured');

    if (provider === 'openrouter') {
        if (!row.openrouter_key_encrypted) throw new SettingsError('NOT_CONFIGURED', 'OpenRouter key is not set');
        return {
            provider,
            model,
            apiKey: await decryptSecret(encKey, row.openrouter_key_encrypted),
            accountId: null,
            baseUrl: null,
        };
    }
    if (provider === 'cloudflare') {
        if (!row.cloudflare_account_id || !row.cloudflare_token_encrypted) {
            throw new SettingsError('NOT_CONFIGURED', 'Cloudflare account or token is not set');
        }
        return {
            provider,
            model,
            apiKey: await decryptSecret(encKey, row.cloudflare_token_encrypted),
            accountId: row.cloudflare_account_id,
            baseUrl: null,
        };
    }
    if (provider === 'openai') {
        if (!row.openai_base_url) throw new SettingsError('NOT_CONFIGURED', 'OpenAI-compatible base URL is not set');
        return {
            provider,
            model,
            apiKey: row.openai_key_encrypted ? await decryptSecret(encKey, row.openai_key_encrypted) : null,
            accountId: null,
            baseUrl: row.openai_base_url,
        };
    }
    if (provider === 'groq') {
        if (!row.groq_key_encrypted) throw new SettingsError('NOT_CONFIGURED', 'Groq API key is not set');
        return {
            provider,
            model,
            apiKey: await decryptSecret(encKey, row.groq_key_encrypted),
            accountId: null,
            baseUrl: GROQ_BASE_URL,
        };
    }
    throw new SettingsError('NOT_CONFIGURED', `Unknown provider: ${String(provider)}`);
}

/**
 * Validate the row for its active provider and decrypt exactly the key that
 * provider needs. Kept for the pre-chain callers and tests.
 */
export async function readAiSettings(row: AiSettingsRow, encKey: string): Promise<ProviderCredentials> {
    if (!row || !row.enabled) {
        throw new SettingsError('FEATURE_DISABLED', 'The import agent is disabled in AI settings');
    }
    const model = String(row.model ?? '').trim();
    if (!model) throw new SettingsError('NOT_CONFIGURED', 'No model configured');
    return readProviderCredentials(row, row.provider, model, encKey);
}

/**
 * Decrypt every ready chain entry, preserving order. Unready entries are
 * returned in `skipped` with a code, so the pump can log them and still use a
 * working fallback. If every entry is skipped the caller fails explicitly.
 */
export async function readAiChain(
    row: AiSettingsRow,
    encKey: string,
): Promise<{ entries: ProviderCredentials[]; skipped: ChainSkip[]; chain: ModelChainEntry[] }> {
    if (!row || !row.enabled) {
        throw new SettingsError('FEATURE_DISABLED', 'The import agent is disabled in AI settings');
    }
    const chain = chainFromRow(row);
    if (chain.length === 0) {
        throw new SettingsError('NOT_CONFIGURED', 'No model configured');
    }

    const entries: ProviderCredentials[] = [];
    const skipped: ChainSkip[] = [];
    const seen = new Set<string>();
    for (const item of chain) {
        const key = `${item.provider}\u0000${item.model.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
            entries.push(await readProviderCredentials(row, item.provider, item.model, encKey));
        } catch (err) {
            if (err instanceof SettingsError) {
                skipped.push({ provider: item.provider, model: item.model, code: err.code });
            } else {
                throw err;
            }
        }
    }
    return { entries, skipped, chain };
}

/** Whether a provider has the stored values it needs, without decrypting. */
export async function providerHealth(
    row: AiSettingsRow,
    provider: AiProviderId,
    encKey: string,
): Promise<ProviderHealth> {
    const present = providerPresence(row);
    if (!present[provider]) return { configured: false, healthy: false, code: null };
    const needsSecret = provider === 'openrouter'
        || provider === 'cloudflare'
        || provider === 'groq'
        || (provider === 'openai' && Boolean(row.openai_key_encrypted));
    if (!encKey && needsSecret) {
        return { configured: true, healthy: false, code: 'ENCRYPTION_KEY_MISSING' };
    }

    try {
        if (provider === 'openrouter' && row.openrouter_key_encrypted) {
            await decryptSecret(encKey, row.openrouter_key_encrypted);
        } else if (provider === 'cloudflare' && row.cloudflare_token_encrypted) {
            await decryptSecret(encKey, row.cloudflare_token_encrypted);
        } else if (provider === 'openai' && row.openai_key_encrypted) {
            await decryptSecret(encKey, row.openai_key_encrypted);
        } else if (provider === 'groq' && row.groq_key_encrypted) {
            await decryptSecret(encKey, row.groq_key_encrypted);
        }
        return { configured: true, healthy: true, code: null };
    } catch (err) {
        const code = err instanceof SettingsError ? err.code : 'DECRYPT_FAILED';
        return { configured: true, healthy: false, code };
    }
}
