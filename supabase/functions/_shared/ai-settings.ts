// Encrypted provider settings (spec §13.6).
//
// The single `ai_settings` row is reachable only through the service role.
// Provider credentials are stored as `v1.<iv>.<ciphertext>` (base64), AES-GCM
// 256, under a key derived with HKDF-SHA256 from the dedicated
// AI_SETTINGS_ENC_KEY secret — never from the service-role key. A decryption
// failure is an explicit error ("re-enter credentials"), never "no key".

export const HKDF_SALT = 'import-agent/ai-settings/v1';
export const HKDF_INFO = 'aes-gcm-256';

export type AiProviderId = 'openrouter' | 'cloudflare' | 'openai';

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

function fromBase64(text: string): Uint8Array {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** HKDF-SHA256(secret) → AES-GCM-256 key. */
export async function deriveAesKey(secret: string, usages: KeyUsage[] = ['decrypt']): Promise<CryptoKey> {
    if (!secret) throw new SettingsError('NOT_CONFIGURED', 'AI_SETTINGS_ENC_KEY is not set');
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
    } catch {
        throw new SettingsError('DECRYPT_FAILED', 'Stored key cannot be decrypted, re-enter credentials');
    }
}

export interface AiSettingsRow {
    provider: AiProviderId;
    enabled: boolean;
    model: string;
    openrouter_key_encrypted?: string | null;
    cloudflare_account_id?: string | null;
    cloudflare_token_encrypted?: string | null;
    openai_base_url?: string | null;
    openai_key_encrypted?: string | null;
}

export interface ProviderCredentials {
    provider: AiProviderId;
    /** One model, or an ordered comma-separated fallback list (OpenRouter). */
    model: string;
    apiKey: string | null;
    accountId: string | null;
    baseUrl: string | null;
}

/**
 * Validate the row for its active provider and decrypt exactly the key that
 * provider needs. Throws SettingsError with a code the function can return.
 */
export async function readAiSettings(row: AiSettingsRow, encKey: string): Promise<ProviderCredentials> {
    if (!row || !row.enabled) {
        throw new SettingsError('FEATURE_DISABLED', 'The import agent is disabled in AI settings');
    }
    const model = String(row.model ?? '').trim();
    if (!model) throw new SettingsError('NOT_CONFIGURED', 'No model configured');

    if (row.provider === 'openrouter') {
        if (!row.openrouter_key_encrypted) throw new SettingsError('NOT_CONFIGURED', 'OpenRouter key is not set');
        return {
            provider: 'openrouter',
            model,
            apiKey: await decryptSecret(encKey, row.openrouter_key_encrypted),
            accountId: null,
            baseUrl: null,
        };
    }
    if (row.provider === 'cloudflare') {
        if (!row.cloudflare_account_id || !row.cloudflare_token_encrypted) {
            throw new SettingsError('NOT_CONFIGURED', 'Cloudflare account or token is not set');
        }
        return {
            provider: 'cloudflare',
            model,
            apiKey: await decryptSecret(encKey, row.cloudflare_token_encrypted),
            accountId: row.cloudflare_account_id,
            baseUrl: null,
        };
    }
    if (row.provider === 'openai') {
        if (!row.openai_base_url) throw new SettingsError('NOT_CONFIGURED', 'OpenAI-compatible base URL is not set');
        return {
            provider: 'openai',
            model,
            apiKey: row.openai_key_encrypted ? await decryptSecret(encKey, row.openai_key_encrypted) : null,
            accountId: null,
            baseUrl: row.openai_base_url,
        };
    }
    throw new SettingsError('NOT_CONFIGURED', `Unknown provider: ${String(row.provider)}`);
}
