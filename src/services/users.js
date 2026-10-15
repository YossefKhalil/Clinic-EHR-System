import { supabase } from './supabase.js';

export async function getUsers() {
    const { data, error } = await supabase()
        .from('users')
        .select('id, name, email, is_admin, section, created_at')
        .order('created_at', { ascending: true });

    if (error) throw error;
    return data;
}

// Admin-only operations are implemented as a Supabase Edge Function
// (supabase/functions/manage-user) so the secret service-role key stays server-side.
async function callManageUser(action, payload) {
    const fnUrl = import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/manage-user';
    const token = (await supabase().auth.getSession()).data.session?.access_token;

    if (!token) {
        throw new Error('Your session has expired. Please sign in again.');
    }

    let res;
    try {
        res = await fetch(fnUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ action, ...payload }),
        });
    } catch (e) {
        // Browsers reduce CORS preflight failures, DNS errors and offline
        // states to an opaque TypeError. Translate it into something the
        // clinic staff can act on instead of "NetworkError when attempting
        // to fetch resource".
        console.error('manage-user request failed:', e);
        throw new Error('Could not reach the user service. Check your connection or contact the administrator if this keeps happening.');
    }

    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        // A 401 here platform-side usually means the presented JWT was
        // rejected (revoked session or too old); a plain re-login fixes it.
        if (res.status === 401) msg = 'Your session was rejected. Please sign in again.';
        throw new Error(msg);
    }

    return res.json();
}

export async function createUser({ email, password, name, is_admin, section }) {
    const data = await callManageUser('create', { email, password, name, is_admin, section });
    return data.user;
}

export async function updateUser(id, { name, is_admin, section, password = null }) {
    return callManageUser('update', { id, name, is_admin, section, password: password || null });
}

export async function deleteUser(id) {
    return callManageUser('delete', { id });
}

export async function setUserAiKey(id, openrouter_api_key) {
    const data = await callManageUser('setAiKey', { id, openrouter_api_key });
    return data.user;
}