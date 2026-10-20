// Browser client for the admin-only `ai-settings` Edge Function.
//
// The `ai_settings` table is service-role only, so every read and write goes
// through the function. Secrets never come back: status returns booleans and
// non-secret fields (Cloudflare account id, OpenAI base URL), and save accepts
// new secrets but never echoes them.

import { supabase } from './supabase.js';

export class AiSettingsError extends Error {
    constructor(code, details = {}) {
        super(code);
        this.name = 'AiSettingsError';
        this.code = code;
        this.details = details;
    }
}

async function invoke(body) {
    const client = supabase();
    if (!client) throw new AiSettingsError('OFFLINE');
    let data;
    let error;
    let status;
    try {
        ({ data, error, status } = await client.functions.invoke('ai-settings', { body }));
    } catch {
        // fetch failures and CORS errors reject before a Response exists.
        throw new AiSettingsError('OFFLINE');
    }

    let payload = data;
    if (error) {
        try {
            payload = typeof error.context?.json === 'function' ? await error.context.json() : null;
        } catch {
            payload = null;
        }
        if (payload?.code) {
            throw new AiSettingsError(payload.code, {
                provider: payload.provider,
                index: payload.index,
                upstreamStatus: payload.upstreamStatus,
                status,
            });
        }
        throw new AiSettingsError('INTERNAL', { status });
    }
    if (!payload || payload.ok !== true) {
        throw new AiSettingsError(payload?.code ?? 'INTERNAL', {
            provider: payload?.provider,
            index: payload?.index,
            upstreamStatus: payload?.upstreamStatus,
            status,
        });
    }
    return payload;
}

export function loadAiSettings() {
    return invoke({ action: 'status' });
}

export function saveAiSettings(payload) {
    return invoke({ action: 'save', ...payload });
}

export function testAiProvider(provider, credentials) {
    return invoke({ action: 'test', provider, credentials: { [provider]: credentials } });
}
