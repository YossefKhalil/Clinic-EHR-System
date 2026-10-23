import { supabase } from './supabase.js';

// Columns the user list and the edit form render. Kept in one place so the
// Edge Function and the client can never drift.
const USER_COLUMNS = 'id, name, email, is_super_admin, read_sections, write_sections, created_at';

export async function getUsers() {
    const { data, error } = await supabase()
        .from('users')
        .select(USER_COLUMNS)
        .order('created_at', { ascending: true });

    if (error) throw error;
    return data;
}

// User writes go through a Supabase Edge Function so the service-role key
// stays server-side and the Super Admin rule is enforced where the browser
// cannot bypass it.
async function callManageUser(action, payload) {
    const baseUrl = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
    if (!baseUrl) throw new Error('User management is not configured.');

    const token = (await supabase().auth.getSession()).data.session?.access_token;
    if (!token) throw new Error('Your session has expired. Please sign in again.');

    let response;
    try {
        response = await fetch(`${baseUrl}/functions/v1/manage-user`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ action, ...payload }),
        });
    } catch (error) {
        // Browsers reduce CORS preflight failures, DNS errors and offline
        // states to an opaque TypeError. Translate it into something the
        // clinic staff can act on.
        console.error('manage-user request failed:', error);
        throw new Error('Could not reach the user service. Check your connection or contact the administrator.');
    }

    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            message = (await response.json()).error || message;
        } catch {
            // Non-JSON error page; keep the status text.
        }
        // A 401 here is usually a revoked or stale JWT; a re-login fixes it.
        if (response.status === 401) message = 'Your session was rejected. Please sign in again.';
        throw new Error(message);
    }

    return response.json();
}

export async function createUser({ email, password, name, is_super_admin, read_sections, write_sections }) {
    const data = await callManageUser('create', {
        email,
        password,
        name,
        is_super_admin: !!is_super_admin,
        read_sections: read_sections || [],
        write_sections: write_sections || [],
    });
    return data.user;
}

export async function updateUser(id, { email, name, is_super_admin, read_sections, write_sections, password = '' }) {
    const data = await callManageUser('update', {
        id,
        email,
        name,
        is_super_admin: !!is_super_admin,
        read_sections: read_sections || [],
        write_sections: write_sections || [],
        password: password || '',
    });
    return data.user;
}

export async function deleteUser(id) {
    return callManageUser('delete', { id });
}
