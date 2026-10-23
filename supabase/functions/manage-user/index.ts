import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SERVICE_ROLE_KEY')
    ?? '';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    serviceRoleKey,
);

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return json({ ok: true }, 200);
    }

    try {
        const auth = req.headers.get('Authorization') || '';
        const token = auth.replace('Bearer ', '');

        const { data: { user: caller }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !caller) {
            return json({ error: 'Unauthorized' }, 401);
        }

        const { data: callerProfile } = await supabase
            .from('users')
            .select('is_admin')
            .eq('id', caller.id)
            .single();

        if (!callerProfile?.is_admin) {
            return json({ error: 'Forbidden: admin only' }, 403);
        }

        const body = await req.json();
        const { action } = body;

        if (action === 'create') {
            const { email, password, name, is_admin, section } = body;
            const { data: created, error } = await supabase.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
                user_metadata: { name, is_admin, section: is_admin ? null : section },
            });
            if (error) return json({ error: error.message }, 400);

            // The auth trigger creates a profile, but the values there come
            // from user_metadata. The upsert is the authoritative write; if it
            // fails, the auth user must not be left behind.
            const { data: profile, error: pErr } = await supabase
                .from('users')
                .upsert({
                    id: created.user.id,
                    name,
                    email,
                    is_admin,
                    section: is_admin ? null : section,
                })
                .select()
                .single();
            if (pErr) {
                const { error: rollbackErr } = await supabase.auth.admin.deleteUser(created.user.id);
                if (rollbackErr) {
                    console.error('manage-user create rollback failed', created.user.id, rollbackErr.message);
                    return json({
                        error: `${pErr.message}. The new auth user could not be removed; delete it manually.`,
                    }, 500);
                }
                return json({ error: pErr.message }, 400);
            }

            return json({ user: profile });
        }

        if (action === 'update') {
            const { id, name, is_admin, section, password } = body;
            const updates = { name, is_admin, section: is_admin ? null : section };

            // Keep the old profile so a failed password write can put it back:
            // the admin sees one failed operation, not a partial success.
            const { data: before, error: readErr } = await supabase
                .from('users')
                .select('name, is_admin, section')
                .eq('id', id)
                .single();
            if (readErr) return json({ error: readErr.message }, 400);

            const { data: profile, error: pErr } = await supabase
                .from('users')
                .update(updates)
                .eq('id', id)
                .select()
                .single();
            if (pErr) return json({ error: pErr.message }, 400);

            if (password) {
                const { error: pwErr } = await supabase.auth.admin.updateUserById(id, { password });
                if (pwErr) {
                    const { error: rollbackErr } = await supabase
                        .from('users')
                        .update({
                            name: before.name,
                            is_admin: before.is_admin,
                            section: before.section,
                        })
                        .eq('id', id);
                    if (rollbackErr) {
                        console.error('manage-user update rollback failed', id, rollbackErr.message);
                        return json({
                            error: `${pwErr.message}. The profile change could not be rolled back.`,
                        }, 500);
                    }
                    return json({ error: pwErr.message }, 400);
                }
            }

            return json({ user: profile });
        }

        if (action === 'delete') {
            const { id } = body;
            // Auth first: the FK cascades auth.users -> public.users. If this
            // fails, the account is untouched and the admin can retry.
            const { error } = await supabase.auth.admin.deleteUser(id);
            if (error) return json({ error: error.message }, 400);

            // Older databases may predate the cascade; the explicit delete is
            // idempotent and leaves no profile behind.
            const { error: profileErr } = await supabase.from('users').delete().eq('id', id);
            if (profileErr) {
                console.error('manage-user profile cleanup failed after auth delete', id, profileErr.message);
            }
            return json({ ok: true });
        }

        return json({ error: 'Unknown action' }, 400);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return json({ error: message }, 500);
    }
});

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
        },
    });
}
