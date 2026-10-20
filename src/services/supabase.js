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

export async function signOut() {
    if (!supabaseClient) throw new Error('Supabase not initialized');
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    currentUser = null;
}