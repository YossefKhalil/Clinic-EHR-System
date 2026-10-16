import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
    DEFAULT_PROVIDER,
    decryptApiKey,
    encryptApiKey,
    isAiProvider,
    keyLast4,
    loadAiSettings,
    missingProviderConfig,
    providerDefaultModel,
    type AiProvider,
    type AiSettings,
} from '../_shared/ai-settings.ts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SERVICE_ROLE_KEY')
    ?? '';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    serviceRoleKey,
);

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// The response shape every action returns — deliberately never includes a
// secret, only readiness flags, masked hints, and the non-secret identifiers
// the admin typed in (account ID, base URL).
function publicSettings(settings: AiSettings) {
    return {
        provider: settings.provider,
        // Kept for older frontends that only knew about the active provider.
        configured: missingProviderConfig(settings) === null,
        last4: keyLast4(settings.apiKey),
        model: settings.model,
        enabled: Boolean(settings.enabled),
        storedCredentials: Boolean(settings.openrouterStored || settings.cloudflareToken || settings.openaiKey),
        providers: {
            openrouter: {
                configured: Boolean(settings.openrouterKey),
                last4: keyLast4(settings.openrouterKey),
            },
            cloudflare: {
                configured: Boolean(settings.cloudflareAccountId && settings.cloudflareToken),
                accountId: settings.cloudflareAccountId,
                last4: keyLast4(settings.cloudflareToken),
            },
            openai: {
                configured: Boolean(settings.openaiBaseUrl && settings.model),
                baseUrl: settings.openaiBaseUrl,
                last4: keyLast4(settings.openaiKey),
            },
        },
    };
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return json({ ok: true }, 200);

    try {
        const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
        const { data: { user: caller }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !caller) return json({ error: 'Unauthorized' }, 401);

        const { data: callerProfile } = await supabase
            .from('users')
            .select('is_admin')
            .eq('id', caller.id)
            .single();
        if (!callerProfile?.is_admin) return json({ error: 'Forbidden: admin only' }, 403);

        const body = await req.json().catch(() => ({}));
        const { action } = body;

        if (action === 'status') {
            return json(publicSettings(await loadAiSettings(supabase, serviceRoleKey)));
        }

        if (action === 'save') {
            const {
                provider, model, enabled,
                openrouterKey, cloudflareAccountId, cloudflareToken,
                openaiBaseUrl, openaiKey,
            } = body;

            if (provider !== undefined && !isAiProvider(provider)) {
                return json({ error: 'Unknown AI provider.' }, 400);
            }

            const nextOrKey = trim(openrouterKey);
            if (nextOrKey && !nextOrKey.startsWith('sk-or-')) {
                return json({ error: 'This does not look like an OpenRouter key — they start with "sk-or-".' }, 400);
            }
            const nextCfAccount = trim(cloudflareAccountId);
            if (nextCfAccount && !/^[a-f0-9]{32}$/i.test(nextCfAccount)) {
                return json({ error: 'The Cloudflare account ID is 32 hexadecimal characters (Workers AI dashboard, "Use REST API").' }, 400);
            }
            let nextBaseUrl = trim(openaiBaseUrl).replace(/\/+$/, '');
            if (nextBaseUrl) {
                let parsed: URL;
                try { parsed = new URL(nextBaseUrl); } catch { return json({ error: 'The base URL is not a valid URL.' }, 400); }
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    return json({ error: 'The base URL must start with http:// or https://.' }, 400);
                }
            }
            if (typeof model === 'string' && model.trim().length > 120) {
                return json({ error: 'The model name is too long.' }, 400);
            }

            const { data: existing } = await supabase
                .from('ai_settings')
                .select('*')
                .eq('id', true)
                .maybeSingle();

            const envKey = (Deno.env.get('OPENROUTER_API_KEY') || '').trim();

            const activeProvider: AiProvider = isAiProvider(provider)
                ? provider
                : (isAiProvider(existing?.provider) ? existing.provider : DEFAULT_PROVIDER);

            let effectiveModel = trim(existing?.model);
            if (typeof model === 'string') effectiveModel = model.trim();
            if (!effectiveModel) effectiveModel = providerDefaultModel(activeProvider);

            // Effective plaintext credentials after applying the updates:
            // a typed value replaces the stored one, blanks keep what exists.
            const storedOrKey = nextOrKey
                || (existing?.openrouter_key_encrypted ? await decryptApiKey(existing.openrouter_key_encrypted, serviceRoleKey) : '');
            const effCloudflareAccountId = nextCfAccount || String(existing?.cloudflare_account_id || '').trim();
            const effCloudflareToken = trim(cloudflareToken)
                || (existing?.cloudflare_token_encrypted ? await decryptApiKey(existing.cloudflare_token_encrypted, serviceRoleKey) : '');
            const effBaseUrl = nextBaseUrl || String(existing?.openai_base_url || '').trim();
            const effOpenaiKey = trim(openaiKey)
                || (existing?.openai_key_encrypted ? await decryptApiKey(existing.openai_key_encrypted, serviceRoleKey) : '');

            const nextEnabled = typeof enabled === 'boolean' ? enabled : Boolean(existing?.enabled);

            // Guard: never leave the feature switched on with a provider that
            // cannot run. Same readiness rule the ai-import function applies.
            const missing = missingProviderConfig({
                provider: activeProvider,
                apiKey: activeProvider === 'cloudflare'
                    ? effCloudflareToken
                    : activeProvider === 'openai'
                        ? effOpenaiKey
                        : (storedOrKey || envKey),
                model: effectiveModel,
                enabled: nextEnabled,
                last4: '',
                openrouterKey: storedOrKey || envKey,
                openrouterStored: Boolean(storedOrKey),
                cloudflareAccountId: effCloudflareAccountId,
                cloudflareToken: effCloudflareToken,
                openaiBaseUrl: effBaseUrl,
                openaiKey: effOpenaiKey,
            });
            if (nextEnabled && missing) {
                return json({ error: `Add the ${missing} before enabling AI Import.` }, 400);
            }

            const row = {
                id: true,
                provider: activeProvider,
                model: effectiveModel,
                enabled: nextEnabled,
                openrouter_key_encrypted: existing?.openrouter_key_encrypted ?? null,
                cloudflare_account_id: effCloudflareAccountId || null,
                cloudflare_token_encrypted: existing?.cloudflare_token_encrypted ?? null,
                openai_base_url: effBaseUrl || null,
                openai_key_encrypted: existing?.openai_key_encrypted ?? null,
                updated_at: new Date().toISOString(),
                updated_by: caller.id,
            };

            if (nextOrKey) row.openrouter_key_encrypted = await encryptApiKey(nextOrKey, serviceRoleKey);
            if (trim(cloudflareToken)) row.cloudflare_token_encrypted = await encryptApiKey(trim(cloudflareToken), serviceRoleKey);
            if (trim(openaiKey)) row.openai_key_encrypted = await encryptApiKey(trim(openaiKey), serviceRoleKey);

            const { error: saveErr } = await supabase.from('ai_settings').upsert(row);
            if (saveErr) return json({ error: saveErr.message }, 400);

            return json(publicSettings(await loadAiSettings(supabase, serviceRoleKey)));
        }

        if (action === 'test') {
            const settings = await loadAiSettings(supabase, serviceRoleKey);
            const missing = missingProviderConfig(settings);
            if (missing) return json({ error: `${missing} is not configured yet.` }, 400);

            try {
                if (settings.provider === 'openrouter') {
                    // /api/v1/key reports the key's validity and limits
                    // without spending tokens, unlike a real chat completion.
                    const res = await fetch('https://openrouter.ai/api/v1/key', {
                        headers: { Authorization: `Bearer ${settings.apiKey}` },
                    });
                    const raw = await res.text();
                    if (!res.ok) {
                        console.error('OpenRouter key test failed:', res.status, raw.slice(0, 300));
                        return json({ error: `OpenRouter rejected the key (${res.status}).` }, 502);
                    }
                    let data: Record<string, unknown> = {};
                    try { data = JSON.parse(raw)?.data ?? {}; } catch {}
                    return json({
                        ok: true,
                        provider: 'openrouter',
                        label: data.label ?? null,
                        usage: data.usage ?? null,
                        limit: data.limit ?? null,
                    });
                }

                if (settings.provider === 'cloudflare') {
                    // Lists models for the account: validates the account ID
                    // and that the token carries Workers AI access, without
                    // spending inference.
                    const res = await fetch(
                        `https://api.cloudflare.com/client/v4/accounts/${settings.cloudflareAccountId}/ai/models/search?per_page=1`,
                        { headers: { Authorization: `Bearer ${settings.apiKey}` } },
                    );
                    const raw = await res.text();
                    if (!res.ok) {
                        console.error('Cloudflare test failed:', res.status, raw.slice(0, 300));
                        return json({ error: `Cloudflare rejected the credentials (${res.status}).` }, 502);
                    }
                    let payload: Record<string, unknown> = {};
                    try { payload = JSON.parse(raw); } catch {}
                    if (payload.success === false) {
                        return json({ error: 'Cloudflare rejected the credentials.' }, 502);
                    }
                    return json({ ok: true, provider: 'cloudflare' });
                }

                // OpenAI-compatible: GET /models proves endpoint + auth answer
                // without spending tokens on inference.
                const headers: Record<string, string> = {};
                if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
                const res = await fetch(`${settings.openaiBaseUrl}/models`, { headers });
                if (!res.ok) {
                    const raw = await res.text();
                    console.error('OpenAI-compatible test failed:', res.status, raw.slice(0, 300));
                    return json({ error: `The endpoint rejected the request (${res.status}). If it does not implement /models, chat completions may still work.` }, 502);
                }
                return json({ ok: true, provider: 'openai' });
            } catch (e) {
                return json({ error: `Could not reach the provider: ${e.message}` }, 502);
            }
        }

        if (action === 'clear') {
            const { data: existing } = await supabase
                .from('ai_settings')
                .select('*')
                .eq('id', true)
                .maybeSingle();

            const keepProvider: AiProvider = isAiProvider(existing?.provider) ? existing.provider : DEFAULT_PROVIDER;
            const { error: clearErr } = await supabase.from('ai_settings').upsert({
                id: true,
                provider: keepProvider,
                model: trim(existing?.model) || providerDefaultModel(keepProvider),
                enabled: false,
                openrouter_key_encrypted: null,
                cloudflare_account_id: null,
                cloudflare_token_encrypted: null,
                openai_base_url: null,
                openai_key_encrypted: null,
                updated_at: new Date().toISOString(),
                updated_by: caller.id,
            });
            if (clearErr) return json({ error: clearErr.message }, 400);

            return json(publicSettings(await loadAiSettings(supabase, serviceRoleKey)));
        }

        return json({ error: 'Unknown action' }, 400);
    } catch (e) {
        console.error('ai-settings failed:', e);
        return json({ error: e.message ?? 'Internal error' }, 500);
    }
});
