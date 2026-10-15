import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadAiSettings } from '../_shared/ai-settings.ts';
import yaml from 'https://esm.sh/js-yaml@4.1.0';

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

const GOVERNORATES = [
    'Cairo', 'Giza', 'Alexandria', 'Dakahlia', 'Red Sea', 'Beheira', 'Faiyum',
    'Gharbia', 'Ismailia', 'Monufia', 'Minya', 'Qalyubia', 'New Valley', 'Suez',
    'Aswan', 'Asyut', 'Beni Suef', 'Port Said', 'Damietta', 'South Sinai',
    'North Sinai', 'Sharqia', 'Kafr El Sheikh', 'Qena', 'Luxor', 'Sohag', 'Matrouh',
];

// Field order the output YAML must follow, so the review table and any
// post-processing can rely on a stable document shape.
const FIELD_ORDER = [
    'name', 'national_id', 'mobile', 'date_of_birth', 'age', 'marital_status',
    'children_count', 'governorate', 'address', 'problem', 'solution', 'price',
    'visit_date', 'source_of_money', 'follower', 'notes', 'uncertain', 'source',
];

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

/**
 * System prompt: Egyptian clinic patient-registry extraction engine.
 * The model never decides what gets saved — it only transcribes what is
 * explicitly present in the provided content, and the browser does all
 * further normalization deterministically.
 */
function systemPrompt(ctx = {}) {
    const followerList = ctx.followers?.length
        ? ctx.followers.join(', ')
        : 'hassan_hamam, abdel_rahman_ahmed, ahmed_saad, mohamed_ali, mohamed_ahmed, hazem, mohamed_rabie';
    const governorateList = ctx.governorates?.length ? ctx.governorates.join(', ') : GOVERNORATES.join(', ');
    return [
        'You are an extraction engine for an Egyptian clinic patient registry.',
        'You receive content from a staff member — spreadsheet lines, document text, a photo, or a PDF — and you transcribe every patient explicitly described in it.',
        '',
        'OUTPUT CONTRACT — follow it exactly:',
        '- Output ONLY valid YAML. No markdown fences, no commentary, no code blocks, no comments.',
        '- Root key is `patients:` with a list of patient mappings. If the content contains no patients at all, output exactly:',
        'patients: []',
        '- Quote EVERY string value, including null-free strings and national IDs (they keep leading zeros).',
        '- Use null (not "" and not 0) when a value is not stated.',
        '- NEVER invent, guess, or infer data. Nothing that is not explicitly in the content.',
        '- Preserve names and clinically relevant text in their original script (Arabic stays Arabic).',
        '- Each patient uses these keys, in this order:',
        ...FIELD_ORDER.map((field) => `  ${field}`),
        '- `source` is a short (a few words) string describing where this patient came from, e.g. "sheet row 4", "photo, top of page", "CSV part 2".',
        '- `uncertain` is a YAML list: one entry per value you are not sure about, phrased as the FIELD name plus why, e.g. - "mobile: digits unclear in image".',
        '- `notes` is a YAML list of strings (one entry per note); empty list [] when none.',
        '',
        'FIELD RULES:',
        '- name: full name exactly as recorded, original script.',
        '- national_id: Egyptian national ID, exactly 14 digits, quoted string.',
        '- mobile: normalize to digits only. If clearly an Egyptian number that starts with 20 or 0020 without the leading 0, write it with the leading 0, e.g. "01012345678". If unsure, transcribe as-is and add an entry to uncertain.',
        '- date_of_birth / visit_date: ISO format YYYY-MM-DD. Convert Arabic-Indic digits (٠-٩) and long-form Arabic dates ("٥ أبريل ١٩٩٧") to the ISO format. If you cannot determine month/day, do not guess — leave null and note it in uncertain.',
        '- age / price / children_count: plain numbers, no currency symbols or units.',
        '- marital_status: exactly one of single, married, divorced, widowed, or null. Arabic variants (أعزب, متزوج, مطلق, أرمل) map to these values.',
        '- governorate: exactly one of: ' + governorateList + '. Map Arabic governorate names (القاهرة → Cairo, الجيزة → Giza, الإسكندرية → Alexandria, etc.). If not one of these, null and add uncertain.',
        '- source_of_money: charity or country, or null. Arabic "عين" ─ keep null; Arabic "شخص" or "أهل" may mean charity only when explicit.',
        '- follower: exactly one of: ' + followerList + ', or null. Arabic follower names (e.g. حسن حمام → hassan_hamam) map when recognizable; otherwise null plus uncertain.',
        '- problem / solution / address: free transcriptions from the content.',
        '',
        'Transcribe only what is explicitly present. When in doubt, null plus an uncertain entry beats a guess.',
    ].join('\n');
}

// Parse the model's YAML and return the patient list. Throws on invalid YAML
// so the caller can attach the parse error and retry.
function extractPatientsDocument(text) {
    // Strip any prose before the `patients:` root and any fences — copy-paste
    // from some providers still wraps output in markdown fences.
    const cleaned = String(text)
        .replace(/```[a-z]*\n?/gi, '')
        .replace(/^(?:(?!patients\s*:)[\s\S])*/m, '');
    const doc = yaml.load(cleaned);
    if (!doc || typeof doc !== 'object' || !('patients' in doc)) {
        throw new Error('The response did not contain a patients: root.');
    }
    if (doc.patients !== undefined && !Array.isArray(doc.patients)) {
        throw new Error('patients: must be a list.');
    }
    return doc.patients;
}

/**
 * Cut a possibly-truncated response to whole patients. If the output was cut
 * by the token limit, the final list item may be syntactically valid YAML but
 * fabricated by the parser... which is much worse than losing it. Dropping
 * the LAST entry and re-serializing keeps every kept patient complete.
 */
function dropLastPatient(text) {
    let patients;
    try {
        patients = extractPatientsDocument(text);
    } catch {
        return null;
    }
    if (!patients.length) return null;
    const kept = patients.slice(0, -1);
    return yaml.dump({ patients: kept }, { quotingType: '"' });
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

    try {
        const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
        const { data: { user: caller }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !caller) return json({ error: 'Unauthorized' }, 401);

        const body = await req.json().catch(() => ({}));
        const {
            action,
            contents = [],
            defaults = [],
            model,
            instructions = '',
            governorates = [],
            followers = [],
            // Retry context: when the client fails to parse the previous YAML
            // it re-sends the chunk with the parser's complaint attached.
            parse_error = '',
            previous_output = '',
        } = body;

        // Lightweight feature flag for any signed-in user: lets the UI hide
        // the AI Import entry point without leaking key details downwards.
        if (action === 'status') {
            const { enabled } = await loadAiSettings(supabase, serviceRoleKey);
            return json({ enabled });
        }

        // Admins can import everywhere; section staff may import into their
        // own section. A signed-in user with neither is rejected.
        const { data: callerProfile } = await supabase
            .from('users')
            .select('is_admin, section')
            .eq('id', caller.id)
            .single();
        if (!callerProfile || (!callerProfile.is_admin && !callerProfile.section)) {
            return json({ error: 'Forbidden: no import permission' }, 403);
        }

        // One key mechanism (issue #10): the encrypted ai_settings row is the
        // source of truth; the env var is only a zero-config fallback.
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

        // The user turn: the chunk contents first (text parts stay before
        // image/PDF parts), then optional free-text instructions from the
        // staff member, then the parse-error retry context.
        const userLines = [];
        if (parse_error) {
            userLines.push('The previous response could not be parsed. Parser message: ' + parse_error);
            userLines.push('Previous response (for reference only — regenerate a complete, valid replacement):');
            userLines.push(previous_output.slice(0, 4000));
        }
        if (instructions) userLines.push('Staff instructions: ' + instructions.slice(0, 2000));

        const userContent = [...contents];
        if (userLines.length) {
            userContent.unshift({ type: 'text', text: userLines.join('\n') });
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model ?? settings.model ?? 'google/gemini-2.5-flash-lite',
                temperature: 0,
                max_tokens: 8000,
                provider: { data_collection: 'deny' },
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt({
                            followers: Array.isArray(followers) && followers.length ? followers : [],
                            governorates: Array.isArray(governorates) && governorates.length ? governorates : [],
                        }),
                    },
                    { role: 'user', content: userContent },
                ],
            }),
        });

        const raw = await response.text();
        if (!response.ok) {
            console.error('OpenRouter error:', response.status, raw.slice(0, 400));
            return json({ error: `AI provider error (${response.status}): ${raw.slice(0, 200)}` }, 502);
        }

        const payload = JSON.parse(raw);
        const choice = payload?.choices?.[0];
        let outYaml = choice?.message?.content ?? '';

        // Truncation guard: max_tokens ran out mid-document, so the final
        // patient may be incomplete. Drop it and tell the client so it can
        // warn the user and, if it wants, re-request a retry of that chunk.
        let truncated = false;
        if (choice?.finish_reason === 'length') {
            truncated = true;
            const repaired = dropLastPatient(outYaml);
            if (repaired) outYaml = repaired;
        }

        return json({ yaml: outYaml, truncated });
    } catch (e) {
        console.error('ai-import failed:', e);
        return json({ error: e.message ?? 'Internal error' }, 500);
    }
});
