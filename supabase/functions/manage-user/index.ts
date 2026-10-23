// manage-user: the only writer of the users table.
//
// The browser cannot touch public.users directly: the RLS policies allow
// writes to Super Admins only, and this function re-checks that same rule
// with the service role before it does anything. That gives us one place to
// validate input, keep `write_sections` a superset of `read_sections`, and
// roll back a half-finished Auth write.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// The shape the client renders; never leaks auth internals.
const USER_COLUMNS = 'id, name, email, is_super_admin, read_sections, write_sections, created_at';

const MIN_PASSWORD_LENGTH = 6;

const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SERVICE_ROLE_KEY')
    ?? '';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    serviceRoleKey,
    { auth: { persistSession: false } },
);

/** An error whose message is safe to show the caller. */
class RequestError extends Error {
    status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.status = status;
    }
}

type Account = { name: string; email: string; password: string };
type Permissions = { isSuperAdmin: boolean; readSections: string[]; writeSections: string[] };
type Body = Record<string, unknown>;

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return json({ ok: true });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    try {
        const caller = await authenticate(req);
        await assertSuperAdmin(caller.id);

        const body = await readBody(req);
        const action = text(body.action);

        if (action === 'create') return json({ user: await createUser(body) });
        if (action === 'update') return json({ user: await updateUser(caller.id, body) });
        if (action === 'delete') return json(await deleteUser(caller.id, body));

        throw new RequestError('Unknown action');
    } catch (error) {
        const status = error instanceof RequestError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status >= 500) console.error('manage-user failed:', message);
        return json({ error: message }, status);
    }
});

/** Resolves the caller from the bearer token, or rejects the request. */
async function authenticate(req: Request): Promise<{ id: string }> {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new RequestError('Unauthorized', 401);

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) throw new RequestError('Unauthorized', 401);
    return user;
}

/** The one and only authorization rule for user management. */
async function assertSuperAdmin(callerId: string): Promise<void> {
    const { data, error } = await supabase
        .from('users')
        .select('is_super_admin')
        .eq('id', callerId)
        .maybeSingle();

    if (error) throw new RequestError(error.message, 500);
    if (!data?.is_super_admin) {
        throw new RequestError('Only a Super Admin can manage users', 403);
    }
}

async function readBody(req: Request): Promise<Body> {
    try {
        const body = await req.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('not an object');
        }
        return body as Body;
    } catch {
        throw new RequestError('Invalid JSON body');
    }
}

// --------------------------------------------------------------- create ----

async function createUser(body: Body) {
    const account = readAccount(body, { passwordRequired: true });
    const permissions = await readPermissions(body);

    const { data: created, error: authError } = await supabase.auth.admin.createUser({
        email: account.email,
        password: account.password,
        email_confirm: true,
        // Only the display name comes through metadata; permissions are
        // written explicitly below and the trigger ignores metadata anyway.
        user_metadata: { name: account.name },
    });
    if (authError || !created?.user) {
        throw new RequestError(authError?.message ?? 'The account could not be created');
    }

    // The auth trigger inserts a bare profile; this upsert is authoritative.
    // If it fails the auth account must not be left behind.
    const { data: profile, error: profileError } = await supabase
        .from('users')
        .upsert({ id: created.user.id, ...profileWrite(account, permissions) })
        .select(USER_COLUMNS)
        .single();

    if (profileError) {
        const { error: rollbackError } = await supabase.auth.admin.deleteUser(created.user.id);
        if (rollbackError) {
            console.error('manage-user create rollback failed', created.user.id, rollbackError.message);
            throw new RequestError(
                `${profileError.message}. The auth account could not be removed; delete it manually.`,
                500,
            );
        }
        throw new RequestError(profileError.message);
    }

    return profile;
}

// --------------------------------------------------------------- update ----

async function updateUser(callerId: string, body: Body) {
    const id = requiredId(body.id);
    const account = readAccount(body, { passwordRequired: false });
    const permissions = await readPermissions(body);

    // Self-lockout guard: a Super Admin must not be able to demote themselves
    // and leave the clinic with no one who can manage users.
    if (id === callerId && !permissions.isSuperAdmin) {
        throw new RequestError('You cannot remove your own Super Admin access');
    }

    const { data: before, error: readError } = await supabase
        .from('users')
        .select('name, email, is_admin, is_super_admin, section, read_sections, write_sections')
        .eq('id', id)
        .maybeSingle();
    if (readError) throw new RequestError(readError.message, 500);
    if (!before) throw new RequestError('User not found', 404);

    const { data: profile, error: profileError } = await supabase
        .from('users')
        .update(profileWrite(account, permissions))
        .eq('id', id)
        .select(USER_COLUMNS)
        .single();
    if (profileError) throw new RequestError(profileError.message);

    const authUpdate: { email?: string; password?: string } = {};
    if (account.email !== before.email) authUpdate.email = account.email;
    if (account.password) authUpdate.password = account.password;

    if (Object.keys(authUpdate).length) {
        const { error: authError } = await supabase.auth.admin.updateUserById(id, authUpdate);
        if (authError) {
            // One failed operation, not a half-updated account: put the
            // profile back before reporting the failure.
            const rollback = {
                name: before.name,
                email: before.email,
                is_admin: before.is_admin,
                is_super_admin: before.is_super_admin,
                section: before.section,
                read_sections: before.read_sections,
                write_sections: before.write_sections,
            };
            const { error: rollbackError } = await supabase.from('users').update(rollback).eq('id', id);
            if (rollbackError) {
                console.error('manage-user update rollback failed', id, rollbackError.message);
                throw new RequestError(
                    `${authError.message}. The profile change could not be rolled back.`,
                    500,
                );
            }
            throw new RequestError(authError.message);
        }
    }

    return profile;
}

// --------------------------------------------------------------- delete ----

async function deleteUser(callerId: string, body: Body) {
    const id = requiredId(body.id);

    // Self-lockout guard: deleting yourself would end the session and can
    // lock the clinic out of user management.
    if (id === callerId) throw new RequestError('You cannot delete your own account');

    // Auth first: auth.users -> public.users cascades. If this fails the
    // account is untouched and the caller can retry.
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) throw new RequestError(error.message);

    // Older databases may predate the cascade; this explicit delete is
    // idempotent and leaves no orphan profile behind.
    const { error: profileError } = await supabase.from('users').delete().eq('id', id);
    if (profileError) {
        console.error('manage-user profile cleanup failed after auth delete', id, profileError.message);
    }

    return { ok: true };
}

// ---------------------------------------------------------------- input ----

function readAccount(body: Body, { passwordRequired }: { passwordRequired: boolean }): Account {
    const name = text(body.name);
    const email = text(body.email).toLowerCase();
    const password = text(body.password);

    if (!name) throw new RequestError('Full name is required');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new RequestError('A valid email address is required');
    }
    if (passwordRequired && !password) throw new RequestError('Password is required');
    if (password && password.length < MIN_PASSWORD_LENGTH) {
        throw new RequestError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    return { name, email, password };
}

async function readPermissions(body: Body): Promise<Permissions> {
    const isSuperAdmin = body.is_super_admin === true;
    const writeSections = normalizeSections(body.write_sections);
    // Write implies read: fold the write grants into the read set so the two
    // arrays can never contradict each other.
    const readSections = unique([...normalizeSections(body.read_sections), ...writeSections]);

    if (!isSuperAdmin) {
        const known = await knownSectionKeys();
        const unknown = readSections.filter((key) => !known.has(key));
        if (unknown.length) {
            throw new RequestError(`Unknown section${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
        }
    }

    return {
        isSuperAdmin,
        readSections: isSuperAdmin ? [] : readSections,
        writeSections: isSuperAdmin ? [] : writeSections,
    };
}

/** Builds the users row for an account + permissions. */
function profileWrite(account: Account, permissions: Permissions) {
    return {
        name: account.name,
        email: account.email,
        // Legacy full-data flag, kept in sync for older code that reads it.
        is_admin: permissions.isSuperAdmin,
        is_super_admin: permissions.isSuperAdmin,
        // New accounts always use the per-section arrays; clearing the legacy
        // primary section keeps it from widening a narrowed grant.
        section: null,
        read_sections: permissions.isSuperAdmin ? [] : permissions.readSections,
        write_sections: permissions.isSuperAdmin ? [] : permissions.writeSections,
    };
}

async function knownSectionKeys(): Promise<Set<string>> {
    const { data, error } = await supabase
        .from('app_options')
        .select('key')
        .eq('kind', 'section');
    if (error) throw new RequestError(error.message, 500);
    return new Set((data ?? []).map((row) => String(row.key)));
}

function normalizeSections(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return unique(value.map((entry) => text(entry)).filter(Boolean));
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function requiredId(value: unknown): string {
    const id = text(value);
    if (!id) throw new RequestError('A user id is required');
    return id;
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
        },
    });
}
