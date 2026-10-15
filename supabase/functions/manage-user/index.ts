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
    serviceRoleKey
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
            if (pErr) return json({ error: pErr.message }, 400);

            return json({ user: profile });
        }

        if (action === 'update') {
            const { id, name, is_admin, section, password } = body;
            const updates = { name, is_admin, section: is_admin ? null : section };

            const { data: profile, error: pErr } = await supabase
                .from('users')
                .update(updates)
                .eq('id', id)
                .select()
                .single();
            if (pErr) return json({ error: pErr.message }, 400);

            if (password) {
                const { error: pwErr } = await supabase.auth.admin.updateUserById(id, { password });
                if (pwErr) return json({ error: pwErr.message }, 400);
            }

            return json({ user: profile });
        }

        if (action === 'delete') {
            const { id } = body;
            await supabase.from('users').delete().eq('id', id);
            const { error } = await supabase.auth.admin.deleteUser(id);
            if (error) return json({ error: error.message }, 400);
            return json({ ok: true });
        }

        return json({ error: 'Unknown action' }, 400);
    } catch (e) {
        return json({ error: e.message }, 500);
    }
});

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
        },
    });
}