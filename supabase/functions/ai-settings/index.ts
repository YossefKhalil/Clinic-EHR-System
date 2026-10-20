// Admin-only AI settings endpoint.
//
// The `ai_settings` row is service-role only, so the Settings page talks to
// this function instead of PostgREST. Actions:
//   status : non-secret view of enabled, the ordered model chain, provider
//            readiness and health. Secrets are decrypted only to verify them.
//   save   : atomically replace the chain and the supplied credentials. Blank
//            secret fields keep the stored key; an explicit clear flag removes
//            it, and a key used by the chain cannot be removed.
//   test   : prove credentials with a cheap provider endpoint. Draft values
//            are tested without saving them.
//
// No action ever returns a secret or logs one.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
    AI_PROVIDERS,
    chainFromRow,
    decryptSecret,
    encryptSecret,
    GROQ_BASE_URL,
    isAiProvider,
    parseModelChain,
    providerHealth,
    providerPresence,
    readProviderCredentials,
    SettingsError,
    validateModelChain,
    type AiProviderId,
    type AiSettingsRow,
} from '../_shared/ai-settings.ts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SERVICE_ROLE_KEY')
    ?? '';
const ENC_KEY = Deno.env.get('AI_SETTINGS_ENC_KEY') ?? '';
const MAX_SECRET_LENGTH = 4096;
const MAX_BASE_URL_LENGTH = 500;

// The database schema is not generated into a TypeScript type in this repo.
// Keep the helper signatures on the client shape actually returned by
// createClient instead of ReturnType, whose generic defaults resolve to never.
type Service = SupabaseClient<any, 'public', any, any, any>;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
}

function fail(code: string, status = 400, extra: Record<string, unknown> = {}): Response {
    return json({ ok: false, code, ...extra }, status);
}

function trim(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function objectAt(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function normalizeBaseUrl(raw: string): string {
    const value = raw.trim().replace(/\/+$/, '');
    if (!value) return '';
    if (value.length > MAX_BASE_URL_LENGTH) throw new SettingsError('INVALID_BASE_URL', 'Base URL is too long');
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new SettingsError('INVALID_BASE_URL', 'Base URL is not valid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SettingsError('INVALID_BASE_URL', 'Base URL must use http or https');
    }
    if (parsed.username || parsed.password) {
        throw new SettingsError('INVALID_BASE_URL', 'Base URL must not contain credentials');
    }
    return value;
}

function normalizeAccountId(raw: string): string {
    const value = raw.trim();
    if (!value) return '';
    if (!/^[a-f0-9]{32}$/i.test(value)) {
        throw new SettingsError('INVALID_ACCOUNT_ID', 'Cloudflare account ID must be 32 hexadecimal characters');
    }
    return value;
}

function normalizeSecret(raw: string): string {
    const value = raw.trim();
    if (value.length > MAX_SECRET_LENGTH) {
        throw new SettingsError('INVALID_SECRET', 'Credential is too long');
    }
    return value;
}

function displayChain(row: AiSettingsRow | null) {
    if (!row) return [];
    const stored = parseModelChain(row.model_chain);
    if (stored.length > 0) return stored;
    const legacy = chainFromRow(row);
    if (legacy.length > 0 && isAiProvider(row.provider) && providerPresence(row)[row.provider]) {
        return legacy;
    }
    return [];
}

async function loadRow(service: Service): Promise<AiSettingsRow | null> {
    const { data } = await service.from('ai_settings').select('*').eq('id', true).maybeSingle();
    return (data as AiSettingsRow | null) ?? null;
}

async function publicSettings(row: AiSettingsRow | null) {
    const chain = displayChain(row);
    const providers: Record<string, Record<string, unknown>> = {};
    for (const provider of AI_PROVIDERS) {
        const health = row
            ? await providerHealth(row, provider, ENC_KEY)
            : { configured: false, healthy: false, code: null };
        providers[provider] = {
            configured: health.configured,
            healthy: health.healthy,
            code: health.code,
            hasKey: provider === 'openai'
                ? Boolean(row?.openai_key_encrypted)
                : provider === 'openrouter'
                    ? Boolean(row?.openrouter_key_encrypted)
                    : provider === 'groq'
                        ? Boolean(row?.groq_key_encrypted)
                        : Boolean(row?.cloudflare_token_encrypted),
            ...(provider === 'cloudflare' ? { accountId: row?.cloudflare_account_id ?? '' } : {}),
            ...(provider === 'openai' ? { baseUrl: row?.openai_base_url ?? '' } : {}),
            ...(provider === 'groq' ? { baseUrl: GROQ_BASE_URL } : {}),
        };
    }
    return {
        ok: true,
        enabled: row?.enabled === true,
        chain,
        providers,
        encryptionReady: Boolean(ENC_KEY),
        stored: Boolean(row),
    };
}

async function audit(service: Service, actor: string, action: string, meta: Record<string, unknown>) {
    try {
        const { error } = await service.from('audit_log').insert({
            actor,
            action,
            entity: 'ai_settings',
            entity_id: 'singleton',
            meta,
        });
        if (error) console.error('ai settings audit failed', error.message);
    } catch (err) {
        // Audit is best-effort; never blocks the user's save, but do not hide
        // the failure from the operator.
        console.error('ai settings audit failed', (err as Error)?.message);
    }
}

type Creds = {
    openrouter?: Record<string, unknown>;
    cloudflare?: Record<string, unknown>;
    openai?: Record<string, unknown>;
    groq?: Record<string, unknown>;
};

async function actionSave(body: Record<string, unknown>, service: Service, userId: string) {
    const existing = await loadRow(service);
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : existing?.enabled === true;
    const chainInput = body.chain === undefined ? displayChain(existing) : body.chain;
    const validation = validateModelChain(chainInput);
    if (validation.error) {
        return fail(validation.error.code, 400, {
            index: validation.error.index,
            provider: validation.error.provider,
        });
    }
    const chain = validation.entries;
    if (enabled && chain.length === 0) return fail('CHAIN_EMPTY', 400);

    const credentials = objectAt(body.credentials) as Creds;
    const or = objectAt(credentials.openrouter);
    const cf = objectAt(credentials.cloudflare);
    const oa = objectAt(credentials.openai);
    const gr = objectAt(credentials.groq);

    let orKeyEncrypted = existing?.openrouter_key_encrypted ?? null;
    let cfAccountId = existing?.cloudflare_account_id ?? '';
    let cfTokenEncrypted = existing?.cloudflare_token_encrypted ?? null;
    let oaBaseUrl = existing?.openai_base_url ?? '';
    let oaKeyEncrypted = existing?.openai_key_encrypted ?? null;
    let grKeyEncrypted = existing?.groq_key_encrypted ?? null;

    let nextOrKey = '';
    let nextCfToken = '';
    let nextOaKey = '';
    let nextGrKey = '';
    try {
        if (or.clearKey === true && trim(or.apiKey)) return fail('BAD_REQUEST', 400);
        if (or.clearKey === true) {
            if (chain.some((entry) => entry.provider === 'openrouter')) return fail('PROVIDER_IN_USE', 409, { provider: 'openrouter' });
            orKeyEncrypted = null;
        }
        nextOrKey = normalizeSecret(trim(or.apiKey));

        if (cf.clearToken === true && trim(cf.apiToken)) return fail('BAD_REQUEST', 400);
        if (cf.clearToken === true) {
            if (chain.some((entry) => entry.provider === 'cloudflare')) return fail('PROVIDER_IN_USE', 409, { provider: 'cloudflare' });
            cfTokenEncrypted = null;
        }
        if (typeof cf.accountId === 'string') cfAccountId = normalizeAccountId(cf.accountId);
        nextCfToken = normalizeSecret(trim(cf.apiToken));

        if (oa.clearKey === true && trim(oa.apiKey)) return fail('BAD_REQUEST', 400);
        if (oa.clearKey === true) oaKeyEncrypted = null;
        if (typeof oa.baseUrl === 'string') oaBaseUrl = normalizeBaseUrl(oa.baseUrl);
        nextOaKey = normalizeSecret(trim(oa.apiKey));

        if (gr.clearKey === true && trim(gr.apiKey)) return fail('BAD_REQUEST', 400);
        if (gr.clearKey === true) {
            if (chain.some((entry) => entry.provider === 'groq')) return fail('PROVIDER_IN_USE', 409, { provider: 'groq' });
            grKeyEncrypted = null;
        }
        nextGrKey = normalizeSecret(trim(gr.apiKey));
    } catch (err) {
        if (err instanceof SettingsError) return fail(err.code, 400);
        throw err;
    }

    if (!ENC_KEY && (nextOrKey || nextCfToken || nextOaKey || nextGrKey)) {
        return fail('ENCRYPTION_KEY_MISSING', 409);
    }
    if (nextOrKey) orKeyEncrypted = await encryptSecret(ENC_KEY, nextOrKey);
    if (nextCfToken) cfTokenEncrypted = await encryptSecret(ENC_KEY, nextCfToken);
    if (nextOaKey) oaKeyEncrypted = await encryptSecret(ENC_KEY, nextOaKey);
    if (nextGrKey) grKeyEncrypted = await encryptSecret(ENC_KEY, nextGrKey);

    const nextRow: AiSettingsRow = {
        provider: chain[0]?.provider
            ?? (isAiProvider(existing?.provider) ? existing.provider : 'openrouter'),
        // An intentionally empty chain must not keep a stale legacy model,
        // otherwise status would synthesize a chain row the admin removed.
        model: chain[0]?.model ?? '',
        model_chain: chain,
        enabled,
        openrouter_key_encrypted: orKeyEncrypted,
        cloudflare_account_id: cfAccountId || null,
        cloudflare_token_encrypted: cfTokenEncrypted,
        openai_base_url: oaBaseUrl || null,
        openai_key_encrypted: oaKeyEncrypted,
        groq_key_encrypted: grKeyEncrypted,
    };

    if (!ENC_KEY && (nextRow.openrouter_key_encrypted || nextRow.cloudflare_token_encrypted
        || nextRow.openai_key_encrypted || nextRow.groq_key_encrypted)) {
        return fail('ENCRYPTION_KEY_MISSING', 409);
    }

    const presence = providerPresence(nextRow);
    for (const entry of chain) {
        if (!presence[entry.provider]) return fail('PROVIDER_NOT_READY', 400, { provider: entry.provider });
        try {
            await readProviderCredentials(nextRow, entry.provider, entry.model, ENC_KEY);
        } catch (err) {
            if (err instanceof SettingsError) return fail(err.code, 400, { provider: entry.provider });
            throw err;
        }
    }

    const rowToWrite = {
        id: true,
        provider: nextRow.provider,
        model: nextRow.model,
        model_chain: chain,
        enabled,
        openrouter_key_encrypted: orKeyEncrypted,
        cloudflare_account_id: cfAccountId || null,
        cloudflare_token_encrypted: cfTokenEncrypted,
        openai_base_url: oaBaseUrl || null,
        openai_key_encrypted: oaKeyEncrypted,
        groq_key_encrypted: grKeyEncrypted,
        updated_at: new Date().toISOString(),
        updated_by: userId,
    };
    const { error } = await service.from('ai_settings').upsert(rowToWrite);
    if (error) {
        console.error('ai settings save failed', error.message);
        return fail('SAVE_FAILED', 500);
    }

    await audit(service, userId, 'ai_settings.updated', {
        enabled,
        chain_length: chain.length,
        chain: chain.map((entry) => ({ provider: entry.provider, model: entry.model })),
    });
    return json(await publicSettings(await loadRow(service)));
}

async function actionTest(body: Record<string, unknown>, service: Service) {
    const provider = body.provider;
    if (!isAiProvider(provider)) return fail('BAD_REQUEST', 400);
    const existing = await loadRow(service);
    const credentials = objectAt(body.credentials);
    const draft = objectAt(credentials[provider]);

    let apiKey: string | null = null;
    let accountId = '';
    let baseUrl = '';

    try {
        if (provider === 'openrouter') {
            const typed = normalizeSecret(trim(draft.apiKey));
            if (typed) {
                apiKey = typed;
            } else if (existing?.openrouter_key_encrypted) {
                if (!ENC_KEY) return fail('ENCRYPTION_KEY_MISSING', 409);
                apiKey = await decryptSecret(ENC_KEY, existing.openrouter_key_encrypted);
            }
            if (!apiKey) return fail('NOT_CONFIGURED', 400, { provider });
        } else if (provider === 'cloudflare') {
            accountId = normalizeAccountId(typeof draft.accountId === 'string'
                ? draft.accountId
                : existing?.cloudflare_account_id ?? '');
            const typed = normalizeSecret(trim(draft.apiToken));
            if (typed) {
                apiKey = typed;
            } else if (existing?.cloudflare_token_encrypted) {
                if (!ENC_KEY) return fail('ENCRYPTION_KEY_MISSING', 409);
                apiKey = await decryptSecret(ENC_KEY, existing.cloudflare_token_encrypted);
            }
            if (!accountId || !apiKey) return fail('NOT_CONFIGURED', 400, { provider });
        } else if (provider === 'groq') {
            baseUrl = GROQ_BASE_URL;
            const typed = normalizeSecret(trim(draft.apiKey));
            if (typed) {
                apiKey = typed;
            } else if (existing?.groq_key_encrypted) {
                if (!ENC_KEY) return fail('ENCRYPTION_KEY_MISSING', 409);
                apiKey = await decryptSecret(ENC_KEY, existing.groq_key_encrypted);
            }
            if (!apiKey) return fail('NOT_CONFIGURED', 400, { provider });
        } else {
            baseUrl = normalizeBaseUrl(typeof draft.baseUrl === 'string'
                ? draft.baseUrl
                : existing?.openai_base_url ?? '');
            const typed = normalizeSecret(trim(draft.apiKey));
            if (typed) {
                apiKey = typed;
            } else if (existing?.openai_key_encrypted) {
                if (!ENC_KEY) return fail('ENCRYPTION_KEY_MISSING', 409);
                apiKey = await decryptSecret(ENC_KEY, existing.openai_key_encrypted);
            }
            if (!baseUrl) return fail('NOT_CONFIGURED', 400, { provider });
        }
    } catch (err) {
        if (err instanceof SettingsError) return fail(err.code, 400, { provider });
        throw err;
    }

    let response: Response;
    try {
        if (provider === 'openrouter') {
            response = await fetch('https://openrouter.ai/api/v1/key', {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(12_000),
            });
        } else if (provider === 'cloudflare') {
            response = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`,
                {
                    headers: { Authorization: `Bearer ${apiKey}` },
                    signal: AbortSignal.timeout(12_000),
                },
            );
        } else {
            const headers: Record<string, string> = {};
            if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
            response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
                headers,
                signal: AbortSignal.timeout(12_000),
            });
        }
    } catch (err) {
        console.error('ai settings test unreachable', provider, (err as Error)?.message);
        return fail('TEST_FAILED', 502, { provider, upstreamStatus: null });
    }

    if (!response.ok) {
        console.error('ai settings test rejected', provider, response.status);
        return fail('TEST_FAILED', 502, { provider, upstreamStatus: response.status });
    }

    let testDetails: Record<string, unknown> = {};
    if (provider === 'openrouter') {
        // `/key` returns the free-model daily counter, so the Settings page can
        // say "0 of 50 left" instead of only "connection works" while every
        // extraction call is being rate-limited.
        try {
            const payload = await response.json() as { data?: Record<string, unknown> };
            const data = payload?.data ?? {};
            testDetails = {
                isFreeTier: data.is_free_tier ?? null,
                freeDaily: data.free_model_daily_requests ?? null,
                usage: data.usage ?? null,
                limit: data.limit ?? null,
            };
        } catch {
            testDetails = {};
        }
    }

    if (provider === 'cloudflare') {
        let payload: Record<string, unknown> = {};
        try { payload = await response.json(); } catch { payload = {}; }
        if (payload.success === false) {
            return fail('TEST_FAILED', 502, { provider, upstreamStatus: response.status });
        }
    }

    return json({ ok: true, provider, ...testDetails });
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
    if (req.method !== 'POST') return fail('BAD_REQUEST', 405);
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) return fail('INTERNAL', 500);

    const authorization = req.headers.get('Authorization') ?? '';
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return fail('UNAUTHORIZED', 401);

    const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: profile } = await service
        .from('users')
        .select('is_admin')
        .eq('id', user.id)
        .maybeSingle();
    if (!profile?.is_admin) return fail('FORBIDDEN', 403);

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return fail('BAD_REQUEST', 400);
    }
    const action = String(body.action ?? '');

    try {
        if (action === 'status') {
            return json(await publicSettings(await loadRow(service)));
        }
        if (action === 'save') return await actionSave(body, service, user.id);
        if (action === 'test') return await actionTest(body, service);
        return fail('BAD_REQUEST', 400);
    } catch (err) {
        console.error('ai-settings failed', action, (err as Error)?.message);
        return fail('INTERNAL', 500);
    }
});
