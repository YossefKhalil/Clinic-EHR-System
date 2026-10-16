import { supabase } from './supabase.js';

// Admin-only operations are implemented as a Supabase Edge Function
// (supabase/functions/ai-settings) so AI provider credentials never reach
// the browser and the service-role key stays server-side.
const FN_URL = import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/ai-settings';

async function callAiSettings(action, payload = {}) {
    const token = (await supabase().auth.getSession()).data.session?.access_token;

    if (!token) {
        throw new Error('Your session has expired. Please sign in again.');
    }

    let res;
    try {
        res = await fetch(FN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ action, ...payload }),
        });
    } catch (e) {
        // Same opaque-TypeError handling as the other Edge Function services.
        console.error('ai-settings request failed:', e);
        throw new Error('Could not reach the settings service. Check your connection or contact the administrator if this keeps happening.');
    }

    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        if (res.status === 401) msg = 'Your session was rejected. Please sign in again.';
        throw new Error(msg);
    }

    return res.json();
}

export async function getAiSettings() {
    return callAiSettings('status');
}

export async function saveAiSettings({ provider, model, enabled, openrouterKey, cloudflareAccountId, cloudflareToken, openaiBaseUrl, openaiKey }) {
    return callAiSettings('save', {
        provider, model, enabled,
        openrouterKey, cloudflareAccountId, cloudflareToken, openaiBaseUrl, openaiKey,
    });
}

export async function testAiSettings() {
    return callAiSettings('test');
}

export async function clearAiSettings() {
    return callAiSettings('clear');
}
