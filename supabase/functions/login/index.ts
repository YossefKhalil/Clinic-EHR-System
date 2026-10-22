// login - password sign-in with the account email or its username.
//
// Supabase Auth only signs in with an email (or a phone), so an identifier
// without an @ is resolved to the account email here, with the service role.
// The lookup never leaves the server: the browser receives a session, not the
// email behind a username, and an unknown username and a wrong password both
// answer the same generic 401. Because the password grant decides the outcome,
// this endpoint is not a username-enumeration oracle.
//
// Deployed with --no-verify-jwt: the caller is, by definition, signed out.
//
// Request:  { identifier: string, password: string }
// Response: { access_token, refresh_token, expires_in, token_type }
//
// Secrets (set by the platform): SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
    isUsername,
    looksLikeEmail,
    MAX_IDENTIFIER_LENGTH,
    normalizeIdentifier,
    usernameEmailPattern,
} from '../_shared/login-identifier.ts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Created per request so a missing secret answers with the JSON error below
// instead of failing at boot. Service role bypasses RLS, which is what lets
// the lookup run before there is a session; it only ever reads the one email
// this request needs.
function adminClient() {
    return createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
}

// One answer for every credential failure: unknown identifier, ambiguous
// username, wrong password. Never say which.
function rejected(): Response {
    return json({ error: 'Invalid username or password' }, 401);
}

async function resolveEmail(identifier: string): Promise<string | null> {
    if (looksLikeEmail(identifier)) return identifier;
    if (!isUsername(identifier)) return null;

    const { data, error } = await adminClient()
        .from('users')
        .select('email')
        .ilike('email', usernameEmailPattern(identifier))
        .limit(2);

    // Two profiles sharing a local part (sara@a.com and sara@b.com) cannot be
    // told apart by the username alone, so neither one signs in with it.
    if (error || !data || data.length !== 1) return null;
    return normalizeIdentifier(data[0].email);
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: CORS_HEADERS });
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
        return json({ error: 'Sign-in is not configured on the server' }, 500);
    }

    try {
        let body: Record<string, unknown>;
        try {
            body = await req.json();
        } catch {
            return json({ error: 'Invalid JSON body' }, 400);
        }

        const identifier = normalizeIdentifier(body?.identifier);
        const password = typeof body?.password === 'string' ? body.password : '';
        if (!identifier || identifier.length > MAX_IDENTIFIER_LENGTH || !password) {
            return rejected();
        }

        const email = await resolveEmail(identifier);

        // The grant runs even when the identifier resolved to nothing: the
        // extra round-trip keeps "no such username" from being distinguishable
        // from "wrong password" by how fast the answer comes back. Same
        // endpoint the browser would have called, with the resolved email.
        // GoTrue owns the password check, the rate limits and the lockout
        // rules.
        const grant = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: {
                apikey: anonKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email: email ?? 'unknown@invalid', password }),
        });
        if (!grant.ok || !email) return rejected();

        const session = await grant.json();
        if (!session?.access_token || !session?.refresh_token) return rejected();

        return json({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: session.expires_in,
            token_type: session.token_type,
        });
    } catch (error) {
        // A database or auth outage must not look like a wrong password, and
        // the browser needs the CORS headers to read any of this at all.
        console.error('login failed:', error);
        return json({ error: 'Sign-in is temporarily unavailable' }, 503);
    }
});
