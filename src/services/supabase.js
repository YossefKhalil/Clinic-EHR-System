import { createClient } from '@supabase/supabase-js';

let supabaseClient = null;
let currentUser = null;

export async function initSupabase() {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseAnonKey) {
        console.warn('Supabase credentials not configured.');
        return;
    }
    
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
        // Long extractions outlive a short-lived access token. Without this the
        // browser keeps an expired JWT and every table read fails mid-import.
        auth: { autoRefreshToken: true, persistSession: true }
    });
    
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) {
            currentUser = session.user;
        }
    } catch (e) {
        console.warn('getSession failed:', e);
    }
    
    supabaseClient.auth.onAuthStateChange((event, session) => {
        currentUser = session?.user || null;
        window.authStateChanged?.(currentUser);
    });
}

export function supabase() {
    return supabaseClient;
}

export function getCurrentUser() {
    return currentUser;
}

export async function signIn(email, password) {
    if (!supabaseClient) throw new Error('Supabase not initialized');
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentUser = data.user;
    return data;
}

// Supabase Auth signs in by email only, but staff know their account by the
// part before the @ (the `login` Edge Function uses the same definition). An
// email is signed in directly; a username is resolved to its account email
// server-side, so the browser never learns which address a username maps to.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signInWithIdentifier(identifier, password) {
    if (!supabaseClient) throw new Error('Supabase not initialized');
    const value = String(identifier || '').trim();
    if (EMAIL_PATTERN.test(value)) {
        return signIn(value, password);
    }

    const { data, error } = await supabaseClient.functions.invoke('login', {
        body: { identifier: value, password },
    });
    if (error) {
        // 400/401 is the function's generic "wrong username or password".
        // Anything else means the function could not answer at all, which is
        // a different message for the person on the login screen.
        const status = error?.context?.status || 0;
        const failure = new Error(status === 400 || status === 401
            ? 'Invalid login credentials'
            : 'The sign-in service is unreachable');
        failure.status = status;
        throw failure;
    }
    if (!data?.access_token || !data?.refresh_token) {
        const failure = new Error('Invalid login credentials');
        failure.status = 401;
        throw failure;
    }

    const { data: session, error: sessionError } = await supabaseClient.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
    });
    if (sessionError) throw sessionError;
    currentUser = session?.user || null;
    return session;
}

export async function signOut() {
    if (!supabaseClient) throw new Error('Supabase not initialized');
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    currentUser = null;
}