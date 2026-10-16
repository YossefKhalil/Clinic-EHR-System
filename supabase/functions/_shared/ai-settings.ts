// Server-side AI provider settings (provider choice, credentials, model,
// enabled flag) shared by the ai-import and ai-settings Edge Functions.
//
// Credentials for every provider are stored in public.ai_settings as AES-GCM
// ciphertext. The encryption key is derived (HKDF-SHA256) from
// SUPABASE_SERVICE_ROLE_KEY, so no extra secret has to be provisioned.
// Consequence: rotating the service-role key makes the stored ciphertext
// undecryptable — re-save the credentials after such a rotation.
//
// The HKDF info string below is historical (from the OpenRouter-only era);
// changing it would strand every already-encrypted value, so it stays.

export const DEFAULT_PROVIDER = 'openrouter';
export const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';
export const DEFAULT_CLOUDFLARE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export type AiProvider = 'openrouter' | 'cloudflare' | 'openai';

export const AI_PROVIDERS: AiProvider[] = ['openrouter', 'cloudflare', 'openai'];

export function isAiProvider(value: unknown): value is AiProvider {
    return typeof value === 'string' && (AI_PROVIDERS as string[]).includes(value);
}

// Sensible starting model per provider; '' means the admin must type one.
export function providerDefaultModel(provider: AiProvider): string {
    if (provider === 'cloudflare') return DEFAULT_CLOUDFLARE_MODEL;
    if (provider === 'openai') return '';
    return DEFAULT_MODEL;
}

const HKDF_SALT = 'clinic-ehr-ai-settings-v1';
const HKDF_INFO = 'openrouter-api-key';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function deriveKey(serviceRoleKey: string): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
        'raw',
        encoder.encode(serviceRoleKey),
        'HKDF',
        false,
        ['deriveKey'],
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
        ['encrypt', 'decrypt'],
    );
}

export async function encryptApiKey(plaintext: string, serviceRoleKey: string): Promise<string> {
    const key = await deriveKey(serviceRoleKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(plaintext),
    );
    return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptApiKey(payload: string | null, serviceRoleKey: string): Promise<string> {
    const [version, ivB64, ciphertextB64] = String(payload || '').split('.');
    if (version !== 'v1' || !ivB64 || !ciphertextB64) return '';

    try {
        const key = await deriveKey(serviceRoleKey);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
            key,
            base64ToBytes(ciphertextB64),
        );
        return decoder.decode(plaintext);
    } catch {
        // Rotated service-role key or corrupt ciphertext: treat as "no key".
        return '';
    }
}

export function keyLast4(apiKey: string): string {
    const trimmed = String(apiKey || '').trim();
    return trimmed ? trimmed.slice(-4) : '';
}

export interface AiSettings {
    provider: AiProvider;
    // Secret used for the ACTIVE provider ('' when absent). OpenRouter may
    // fall back to the OPENROUTER_API_KEY environment secret.
    apiKey: string;
    model: string;
    enabled: boolean;
    last4: string;
    // All decrypted credentials, so status responses can report per-provider
    // readiness without extra database round-trips.
    openrouterKey: string;
    openrouterStored: boolean;
    cloudflareAccountId: string;
    cloudflareToken: string;
    openaiBaseUrl: string;
    openaiKey: string;
}

// Friendly description of what is still missing before the active provider
// can run, or null when it is ready to go. The OpenAI-compatible key is
// optional because local endpoints (Ollama, LM Studio) usually ignore it.
export function missingProviderConfig(settings: AiSettings): string | null {
    if (settings.provider === 'cloudflare') {
        if (!settings.cloudflareAccountId) return 'Cloudflare account ID';
        if (!settings.cloudflareToken) return 'Cloudflare API token';
        return null;
    }
    if (settings.provider === 'openai') {
        if (!settings.openaiBaseUrl) return 'base URL';
        if (!settings.model) return 'model name';
        return null;
    }
    return settings.openrouterKey ? null : 'OpenRouter API key';
}

const SETTINGS_COLUMNS = 'provider, openrouter_key_encrypted, cloudflare_account_id, cloudflare_token_encrypted, openai_base_url, openai_key_encrypted, model, enabled';

// Resolves the effective settings. When no saved row exists the function
// falls back to the OPENROUTER_API_KEY environment secret (the pre-#10
// deployment style) and reports the feature as enabled only if that key is
// present, so nothing breaks for deployments that never open the settings UI.
export async function loadAiSettings(supabase: { from: (table: string) => any }, serviceRoleKey: string): Promise<AiSettings> {
    const envKey = (Deno.env.get('OPENROUTER_API_KEY') || '').trim();

    let row: any = null;
    try {
        const { data } = await supabase
            .from('ai_settings')
            .select(SETTINGS_COLUMNS)
            .eq('id', true)
            .maybeSingle();
        row = data ?? null;
    } catch {
        // Table not migrated yet: behave like a fresh deployment.
        row = null;
    }

    const provider: AiProvider = isAiProvider(row?.provider) ? row.provider : DEFAULT_PROVIDER;

    const storedOpenrouter = row?.openrouter_key_encrypted
        ? await decryptApiKey(row.openrouter_key_encrypted, serviceRoleKey)
        : '';
    const openrouterKey = storedOpenrouter || envKey;
    const cloudflareAccountId = String(row?.cloudflare_account_id || '').trim();
    const cloudflareToken = row?.cloudflare_token_encrypted
        ? await decryptApiKey(row.cloudflare_token_encrypted, serviceRoleKey)
        : '';
    const openaiBaseUrl = String(row?.openai_base_url || '').trim();
    const openaiKey = row?.openai_key_encrypted
        ? await decryptApiKey(row.openai_key_encrypted, serviceRoleKey)
        : '';

    const apiKey = provider === 'cloudflare'
        ? cloudflareToken
        : provider === 'openai'
            ? openaiKey
            : openrouterKey;

    return {
        provider,
        apiKey,
        model: String(row?.model || '').trim() || providerDefaultModel(provider),
        enabled: row ? Boolean(row.enabled) : Boolean(envKey),
        last4: keyLast4(apiKey),
        openrouterKey,
        openrouterStored: Boolean(storedOpenrouter),
        cloudflareAccountId,
        cloudflareToken,
        openaiBaseUrl,
        openaiKey,
    };
}
