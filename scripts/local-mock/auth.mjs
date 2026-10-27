// A small GoTrue.
//
// Only the endpoints the app uses: password grant, refresh, current user,
// logout, and the admin user CRUD that manage-user calls. Passwords live in
// public._local_passwords; auth.users keeps the same shape the RLS harness
// uses, so public.users' foreign key and the signup trigger behave normally.

import { newId, serializedService, localPasswordHash } from './db.mjs';
import { sign, verify } from './jwt.mjs';

function send(res, status, body, extraHeaders = {}) {
    if (status === 204) { res.writeHead(204, extraHeaders); res.end(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
    res.end(JSON.stringify(body));
}

function readJson(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve({});
            try { resolve(JSON.parse(text)); } catch { resolve(null); }
        });
        req.on('error', () => resolve(null));
    });
}

function userShape(row) {
    const meta = row.raw_user_meta_data ?? {};
    const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    return {
        id: row.id,
        aud: 'authenticated',
        role: 'authenticated',
        email: row.email,
        email_confirmed_at: createdAt ?? null,
        phone: '',
        confirmed_at: createdAt ?? null,
        last_sign_in_at: new Date().toISOString(),
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: meta,
        identities: [],
        created_at: createdAt ?? null,
        updated_at: createdAt ?? null,
    };
}

async function loadUserByEmail(email) {
    const result = await serializedService((run) => run(
        `SELECT a.id, a.email, a.raw_user_meta_data, a.created_at, u.name, u.is_super_admin,
                p.password_hash
           FROM auth.users a
           LEFT JOIN public.users u ON u.id = a.id
           LEFT JOIN public._local_passwords p ON p.user_id = a.id
          WHERE lower(a.email) = lower($1)`,
        [email],
    ));
    return result.rows[0] ?? null;
}

async function loadUserById(id) {
    const result = await serializedService((run) => run(
        `SELECT a.id, a.email, a.raw_user_meta_data, a.created_at, u.name, u.is_super_admin
           FROM auth.users a
           LEFT JOIN public.users u ON u.id = a.id
          WHERE a.id = $1`,
        [id],
    ));
    return result.rows[0] ?? null;
}

function issueSession(row) {
    const user = userShape(row);
    const accessToken = sign({
        sub: row.id,
        email: row.email,
        role: 'authenticated',
        aud: 'authenticated',
        app_metadata: user.app_metadata,
        user_metadata: user.user_metadata,
    });
    const refreshToken = sign({ sub: row.id, type: 'refresh' }, { expiresIn: 60 * 60 * 24 * 30 });
    const expiresIn = 3600;
    return {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: expiresIn,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        refresh_token: refreshToken,
        user,
    };
}

async function passwordGrant(email, password) {
    const row = await loadUserByEmail(email);
    if (!row) return null;
    if (row.password_hash !== localPasswordHash(password)) return null;
    return issueSession(row);
}

async function createUser(body) {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const metadata = body.user_metadata && typeof body.user_metadata === 'object' ? body.user_metadata : {};
    const existing = await loadUserByEmail(email);
    if (existing) {
        const error = new Error('A user with this email address has already been registered');
        error.status = 422;
        throw error;
    }
    const id = newId();
    await serializedService(async (run) => {
        await run(
            `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
             VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), $3)`,
            [id, email, JSON.stringify(metadata)],
        );
        await run(
            'INSERT INTO public._local_passwords (user_id, password_hash) VALUES ($1, $2)',
            [id, localPasswordHash(password)],
        );
    });
    const created = await loadUserById(id);
    return userShape(created);
}

async function updateUser(id, body) {
    const patch = {};
    if (typeof body.email === 'string' && body.email.trim()) patch.email = body.email.trim().toLowerCase();
    if (typeof body.password === 'string' && body.password) patch.password = body.password;
    if (body.user_metadata && typeof body.user_metadata === 'object') patch.metadata = body.user_metadata;

    await serializedService(async (run) => {
        if (patch.email) {
            await run('UPDATE auth.users SET email = $2, updated_at = now() WHERE id = $1', [id, patch.email]);
            await run('UPDATE public.users SET email = $2 WHERE id = $1', [id, patch.email]);
        }
        if (patch.metadata) {
            await run('UPDATE auth.users SET raw_user_meta_data = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(patch.metadata)]);
        }
        if (patch.password) {
            await run(
                `INSERT INTO public._local_passwords (user_id, password_hash)
                 VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
                [id, localPasswordHash(patch.password)],
            );
        }
    });
    return userShape(await loadUserById(id));
}

async function deleteUser(id) {
    await serializedService(async (run) => {
        await run('DELETE FROM public.users WHERE id = $1', [id]);
        await run('DELETE FROM auth.users WHERE id = $1', [id]);
    });
}

function bearer(req) {
    return String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
}

export async function handleAuth(req, res, url, ctx) {
    const path = url.pathname.replace(/\/+$/, '');

    if (path === '/auth/v1/token') {
        if (req.method !== 'POST') return send(res, 405, { message: 'method not allowed' });
        const body = await readJson(req);
        if (body === null) return send(res, 400, { message: 'invalid JSON body' });
        const grant = url.searchParams.get('grant_type');
        if (grant === 'password') {
            const session = await passwordGrant(String(body.email ?? '').trim().toLowerCase(), String(body.password ?? ''));
            if (!session) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
            return send(res, 200, session);
        }
        if (grant === 'refresh_token') {
            const payload = verify(String(body.refresh_token ?? ''));
            if (!payload || payload.type !== 'refresh') {
                return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
            }
            const row = await loadUserById(payload.sub);
            if (!row) return send(res, 400, { error: 'invalid_grant', error_description: 'User not found' });
            return send(res, 200, issueSession(row));
        }
        return send(res, 400, { error: 'unsupported_grant_type' });
    }

    if (path === '/auth/v1/user') {
        const payload = verify(bearer(req));
        if (!payload?.sub) return send(res, 401, { message: 'invalid claim: missing sub claim' });
        if (req.method === 'GET') {
            const row = await loadUserById(payload.sub);
            if (!row) return send(res, 404, { message: 'user not found' });
            return send(res, 200, userShape(row));
        }
        if (req.method === 'PUT') {
            const body = await readJson(req) ?? {};
            const updated = await updateUser(payload.sub, body);
            return send(res, 200, updated);
        }
        return send(res, 405, { message: 'method not allowed' });
    }

    if (path === '/auth/v1/logout') {
        return send(res, 204, null);
    }

    if (path === '/auth/v1/settings') {
        return send(res, 200, {
            external: {},
            disable_signup: true,
            mailer_autoconfirm: true,
            phone_autoconfirm: false,
            sms_provider: '',
        });
    }

    const adminMatch = /^\/auth\/v1\/admin\/users(?:\/([^/]+))?$/.exec(path);
    if (adminMatch) {
        const id = adminMatch[1];
        try {
            if (!id && req.method === 'POST') {
                const created = await createUser(await readJson(req) ?? {});
                return send(res, 200, created);
            }
            if (!id && req.method === 'GET') {
                const result = await serializedService((run) => run(
                    'SELECT id, email, raw_user_meta_data, created_at FROM auth.users ORDER BY created_at ASC',
                ));
                return send(res, 200, { aud: 'authenticated', users: result.rows.map(userShape) });
            }
            if (id && req.method === 'PUT') {
                const updated = await updateUser(id, await readJson(req) ?? {});
                return send(res, 200, updated);
            }
            if (id && req.method === 'DELETE') {
                await deleteUser(id);
                return send(res, 200, {});
            }
        } catch (error) {
            return send(res, error.status ?? 500, { code: error.status ?? 500, message: String(error.message ?? error) });
        }
        return send(res, 405, { message: 'method not allowed' });
    }

    return send(res, 404, { message: `no mock route for ${req.method} ${url.pathname}` });
}
