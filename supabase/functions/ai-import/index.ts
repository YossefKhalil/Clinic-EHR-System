import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadAiSettings } from '../_shared/ai-settings.ts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SERVICE_ROLE_KEY')
    ?? '';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    serviceRoleKey
);

// Convert a JS value into clean, human-readable YAML without quotes where
// possible. Deliberately tiny: the shape is flat and known.
function toYaml(value, indent = 0) {
    const pad = '  '.repeat(indent);

    if (value === null || value === undefined) return 'null';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        return '\n' + value.map((item) => `${pad}- ${toYaml(item, indent + 1)}`).join('\n');
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        if (!entries.length) return '{}';
        const lines = entries.map(([key, val]) => {
            const rendered = (val !== null && typeof val === 'object')
                ? toYaml(val, indent + 1)
                : String(val);
            return `${pad}${key}: ${rendered}`;
        });
        return '\n' + lines.join('\n');
    }

    const text = String(value);
    const needsQuotes = text === '' || /^[0-9+\-.]/.test(text) || /[:#\n]/.test(text) || /^(true|false|null|yes|no|~)$/i.test(text);
    return needsQuotes ? JSON.stringify(text) : text;
}

// The prompt that governs everything the model may, must not, returns.
function systemPrompt(ctx = {}) {
    return [
        'You are a data-entry assistant for a clinic patient registry.',
        'You receive a prompt from a staff member plus optional file content (spreadsheet rows, document text, or an image) and you return the patients described, as strict YAML.',
        '',
        'Return ONLY a YAML document. No markdown fences, no explanations, no code blocks, no comments.',
        '',
        'Exactly this shape, repeating patients for each person found:',
        'patients:',
        '  - name: "Full Name"',
        '    national_id: "14 digit string"',
        '    mobile: "Phone number or null"',
        '    date_of_birth: "YYYY-MM-DD or null"',
        '    age: null',
        '    marital_status: single|married|divorced|widowed|null',
        '    children_count: 0',
        '    governorate: "One of: Cairo, Giza, Alexandria, Dakahlia, Red Sea, Beheira, Faiyum, Gharbia, Ismailia, Monufia, Minya, Qalyubia, New Valley, Suez, Aswan, Asyut, Beni Suef, Port Said, Damietta, South Sinai, North Sinai, Sharqia, Kafr El Sheikh, Qena, Luxor, Sohag, Matrouh"',
        '    address: "Street / building / landmarks or null"',
        '    problem: "Presented symptoms"',
        '    solution: "Treatment / diagnosis or null"',
        '    price: null',
        '    visit_date: "YYYY-MM-DD or null"',
        '    source_of_money: charity|country|null',
        '    is_completed: false',
        '    notes: "One-line string or null"',
        '',
        'Rules:',
        `- Only output patients explicitly present in the provided content. Never invent or guess.`,
        `- Leave a field as null when not provided. Do not use empty strings.`,
        `- national_id keeps leading zeros as a quoted string.`,
        `- date_of_birth / visit_date must be YYYY-MM-DD.`,
        `- age is a number. price is a number (no currency symbol).`,
        `- Valid marital_status values: single, married, divorced, widowed.`,
        `- Valid source_of_money values: charity, country.`,
        `- notes merges multiple notes into one line separated by ;`,
        ...ctx.defaults,
    ].join('\n');
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

    try {
        const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
        const { data: { user: caller }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !caller) return json({ error: 'Unauthorized' }, 401);

        const body = await req.json().catch(() => ({}));
        const { action, contents = [], defaults = [] } = body;

        // Lightweight feature flag for any signed-in user: lets the UI hide
        // the AI Import entry point without leaking key details downwards.
        if (action === 'status') {
            const { enabled } = await loadAiSettings(supabase, serviceRoleKey);
            return json({ enabled });
        }

        const { data: callerProfile } = await supabase
            .from('users')
            .select('is_admin')
            .eq('id', caller.id)
            .single();
        if (!callerProfile?.is_admin) return json({ error: 'Forbidden: admin only' }, 403);

        const settings = await loadAiSettings(supabase, serviceRoleKey);
        if (!settings.enabled) {
            return json({ error: 'AI Import is disabled by the administrator.' }, 403);
        }
        if (!settings.apiKey) {
            return json({ error: 'OpenRouter API key is not configured.' }, 500);
        }
        if (!contents.length) {
            return json({ error: 'No content provided.' }, 400);
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: settings.model,
                temperature: 0.1,
                max_tokens: 3600,
                messages: [
                    { role: 'system', content: systemPrompt({ defaults }) },
                    { role: 'user', content: contents },
                ],
            }),
        });

        const raw = await response.text();
        if (!response.ok) {
            console.error('OpenRouter error:', response.status, raw.slice(0, 400));
            return json({ error: `AI provider error (${response.status}): ${raw.slice(0, 200)}` }, 502);
        }

        const payload = JSON.parse(raw);
        const yaml = payload?.choices?.[0]?.message?.content ?? '';
        return json({ yaml });
    } catch (e) {
        console.error('ai-import failed:', e);
        return json({ error: e.message ?? 'Internal error' }, 500);
    }
});
