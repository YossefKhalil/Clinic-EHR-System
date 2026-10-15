// Server-side AI settings (OpenRouter key, model, enabled flag) shared by the
// ai-import and ai-settings Edge Functions.
//
// The key is stored in public.ai_settings as AES-GCM ciphertext. The
// encryption key is derived (HKDF-SHA256) from SUPABASE_SERVICE_ROLE_KEY, so
// no extra secret has to be provisioned. Consequence: rotating the
// service-role key makes the stored ciphertext undecryptable — re-save the
// API key after such a rotation.

export const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';

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
    apiKey: string;
    model: string;
    enabled: boolean;
    last4: string;
}

// Resolves the effective settings. When no saved row exists the function
// falls back to the OPENROUTER_API_KEY environment secret (the pre-#10
// deployment style) and reports the feature as enabled only if that key is
// present, so nothing breaks for deployments that never open the settings UI.
export async function loadAiSettings(supabase: { from: (table: string) => any }, serviceRoleKey: string): Promise<AiSettings> {
    const envKey = (Deno.env.get('OPENROUTER_API_KEY') || '').trim();

    let row: { openrouter_key_encrypted: string | null; model: string | null; enabled: boolean } | null = null;
    try {
        const { data } = await supabase
            .from('ai_settings')
            .select('openrouter_key_encrypted, model, enabled')
            .eq('id', true)
            .maybeSingle();
        row = data ?? null;
    } catch {
        // Table not migrated yet: behave like a fresh deployment.
        row = null;
    }

    let apiKey = envKey;
    if (row?.openrouter_key_encrypted) {
        apiKey = await decryptApiKey(row.openrouter_key_encrypted, serviceRoleKey) || envKey;
    }

    return {
        apiKey,
        model: (row?.model || '').trim() || DEFAULT_MODEL,
        enabled: row ? Boolean(row.enabled) : Boolean(envKey),
        last4: keyLast4(apiKey),
    };
}
