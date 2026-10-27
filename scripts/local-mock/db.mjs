// The mock backend's database.
//
// It is a real Postgres (PGlite, WASM) with the same prelude a hosted Supabase
// project has: the anon/authenticated/service_role roles and the auth schema.
// supabase/schema.sql is applied as-is, so RLS policies, SECURITY DEFINER
// helpers, triggers and generated columns all behave like production.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { SUPABASE_PRELUDE } from '../../tests/rls/harness.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCHEMA_PATH = `${ROOT}supabase/schema.sql`;
const SEED_PATH = `${ROOT}supabase/seed.local.sql`;
const DATA_DIR = process.env.MOCK_PGDATA || `${ROOT}.local/pgdata`;

export const LOCAL_ADMIN = Object.freeze({
    id: '00000000-0000-0000-0000-0000000000a1',
    name: 'Yossef',
    username: 'yossef',
    email: 'yossef@clinic.local',
    password: '123',
});

let db;
// PGlite is a single connection; a transaction cannot start while another is
// open, so every unit of work goes through one queue.
let queue = Promise.resolve();

function serialize(work) {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
}

export function localPasswordHash(password) {
    return `local:${createHash('sha256').update(String(password)).digest('hex')}`;
}

export async function openDatabase() {
    if (db) return db;
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    db = new PGlite({ dataDir: DATA_DIR, extensions: { uuid_ossp } });

    const { rows } = await db.query(
        "SELECT to_regclass('public.users') IS NOT NULL AS present",
    );
    const fresh = rows[0]?.present !== true;
    if (fresh) {
        await db.exec(SUPABASE_PRELUDE);
        await db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
        if (existsSync(SEED_PATH)) await db.exec(readFileSync(SEED_PATH, 'utf8'));
    }
    // A hosted project grants the service role access to the auth/storage
    // schemas; the RLS harness does not, because its SQL runs as superuser.
    // The mock's own code runs as service_role, so it needs the grants.
    await db.exec(`
        GRANT ALL ON ALL TABLES IN SCHEMA auth TO service_role;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO service_role;
        GRANT ALL ON ALL TABLES IN SCHEMA storage TO service_role;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO service_role;
    `);

    // Mock-only table: the local passwords. auth.users is the same shape the
    // RLS harness uses, and must not carry extra columns.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS public._local_passwords (
            user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
            password_hash text NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
        );
    `);

    await serializedService(async (run) => {
        const existing = await run(
            'SELECT id FROM auth.users WHERE lower(email) = lower($1)',
            [LOCAL_ADMIN.email],
        );
        if (existing.rows.length === 0) {
            await run(
                `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
                 VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), $3)
                 ON CONFLICT (id) DO NOTHING`,
                [LOCAL_ADMIN.id, LOCAL_ADMIN.email, JSON.stringify({ name: LOCAL_ADMIN.name })],
            );
            await run(
                `INSERT INTO public._local_passwords (user_id, password_hash)
                 VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
                [LOCAL_ADMIN.id, localPasswordHash(LOCAL_ADMIN.password)],
            );
        }
        // The trigger created the profile (or it already exists); grant the
        // top role so the local login can manage users.
        await run(
            `UPDATE public.users
                SET name = $2, is_super_admin = TRUE, is_admin = TRUE
              WHERE lower(email) = lower($1)`,
            [LOCAL_ADMIN.email, LOCAL_ADMIN.name],
        );
    });

    return db;
}

/** Run `work` inside one serialised transaction as the given role. */
export function withRole(role, work, claims = null) {
    return serialize(() => db.transaction(async (tx) => {
        if (role === 'service_role') {
            await tx.exec('SET LOCAL ROLE service_role;');
        } else if (role === 'authenticated') {
            await tx.exec('SET LOCAL ROLE authenticated;');
            await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims ?? {})]);
            await tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [String(claims?.sub ?? '')]);
        } else {
            await tx.exec('SET LOCAL ROLE anon;');
        }
        return work(tx);
    }));
}

/** Service-role helper for the mock's own bookkeeping. */
export function serializedService(work) {
    return serialize(async () => {
        return db.transaction(async (tx) => {
            await tx.exec('SET LOCAL ROLE service_role;');
            return work((sql, params) => tx.query(sql, params));
        });
    });
}

export function newId() {
    return randomUUID();
}
