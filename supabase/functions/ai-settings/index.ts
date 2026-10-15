import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
    DEFAULT_MODEL,
    encryptApiKey,
    keyLast4,
    loadAiSettings,
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

// The response shape every action returns — deliberately never includes the
// key itself, only whether one effectively exists and its last 4 characters.
function publicSettings(settings: AiSettings) {
    return {
        configured: Boolean(settings.apiKey),
        last4: keyLast4(settings.apiKey),
        model: settings.model,
        enabled: Boolean(settings.enabled),
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
            const { key, model, enabled } = body;

            if (typeof key === 'string' && key.trim() && !key.trim().startsWith('sk-or-')) {
                return json({ error: 'This does not look like an OpenRouter key — they start with "sk-or-".' }, 400);
            }
            if (typeof model === 'string' && model.trim().length > 120) {
                return json({ error: 'The model name is too long.' }, 400);
            }

            const { data: existing } = await supabase
                .from('ai_settings')
                .select('openrouter_key_encrypted, model, enabled')
                .eq('id', true)
                .maybeSingle();

            const row = {
                id: true,
                openrouter_key_encrypted: existing?.openrouter_key_encrypted ?? null,
                model: (existing?.model || '').trim() || DEFAULT_MODEL,
                enabled: Boolean(existing?.enabled),
                updated_at: new Date().toISOString(),
                updated_by: caller.id,
            };

            if (typeof key === 'string' && key.trim()) {
                row.openrouter_key_encrypted = await encryptApiKey(key.trim(), serviceRoleKey);
            }
            if (typeof model === 'string') {
                row.model = model.trim() || DEFAULT_MODEL;
            }
            if (typeof enabled === 'boolean') {
                row.enabled = enabled;
            }

            // Guard: never leave the feature switched on with no usable key.
            const envKey = (Deno.env.get('OPENROUTER_API_KEY') || '').trim();
            if (row.enabled && !row.openrouter_key_encrypted && !envKey) {
                return json({ error: 'Add an API key before enabling AI Import.' }, 400);
            }

            const { error: saveErr } = await supabase.from('ai_settings').upsert(row);
            if (saveErr) return json({ error: saveErr.message }, 400);

            return json(publicSettings(await loadAiSettings(supabase, serviceRoleKey)));
        }

        if (action === 'test') {
            const { apiKey } = await loadAiSettings(supabase, serviceRoleKey);
            if (!apiKey) return json({ error: 'No API key is configured yet.' }, 400);

            // /api/v1/key reports the key's validity and limits without
            // spending tokens, unlike a real chat completion.
            let res;
            try {
                res = await fetch('https://openrouter.ai/api/v1/key', {
                    headers: { Authorization: `Bearer ${apiKey}` },
                });
            } catch (e) {
                return json({ error: `Could not reach OpenRouter: ${e.message}` }, 502);
            }

            const raw = await res.text();
            if (!res.ok) {
                console.error('OpenRouter key test failed:', res.status, raw.slice(0, 300));
                return json({ error: `OpenRouter rejected the key (${res.status}).` }, 502);
            }

            let data: Record<string, unknown> = {};
            try { data = JSON.parse(raw)?.data ?? {}; } catch {}
            return json({
                ok: true,
                label: data.label ?? null,
                usage: data.usage ?? null,
                limit: data.limit ?? null,
            });
        }

        if (action === 'clear') {
            const { data: existing } = await supabase
                .from('ai_settings')
                .select('model')
                .eq('id', true)
                .maybeSingle();

            const { error: clearErr } = await supabase.from('ai_settings').upsert({
                id: true,
                openrouter_key_encrypted: null,
                model: (existing?.model || '').trim() || DEFAULT_MODEL,
                enabled: false,
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
