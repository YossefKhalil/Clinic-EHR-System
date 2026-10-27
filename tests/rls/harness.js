// PGlite harness for the SQL test scripts under tests/rls/.
//
// PGlite is a full Postgres (WASM), so the scripts exercise the real engine:
// RLS, SECURITY DEFINER helpers, triggers, SKIP LOCKED. What it does not have
// is the Supabase platform, so this file provides the same pieces a hosted
// project always has: the anon/authenticated/service_role roles, the auth
// schema (auth.users + auth.uid() reading the request JWT claims) and the
// storage schema (buckets + objects with RLS enabled).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const RLS_DIR = fileURLToPath(new URL('.', import.meta.url));
export const SCHEMA_PATH = fileURLToPath(new URL('../../supabase/schema.sql', import.meta.url));

// Mirrors the hosted platform: everything a Supabase project provides before
// supabase/schema.sql runs. Default privileges grant ALL to the API roles —
// that is how hosted projects behave too; RLS is what gates rows.
export const SUPABASE_PRELUDE = `
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;

-- Hosted projects grant the API roles USAGE on these schemas.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id uuid,
    aud text,
    role text,
    email text,
    encrypted_password text NOT NULL DEFAULT '',
    email_confirmed_at timestamptz,
    raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- The same shape as the hosted auth.uid(): the sub claim of the request JWT.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql
STABLE
AS $fn$
    SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid
$fn$;

CREATE TABLE IF NOT EXISTS storage.buckets (
    id text PRIMARY KEY,
    name text NOT NULL,
    public boolean NOT NULL DEFAULT false,
    file_size_limit bigint,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id text REFERENCES storage.buckets(id),
    name text,
    owner uuid,
    metadata jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
`;

/** A fresh Postgres with the Supabase prelude and the real schema applied. */
export async function createSupabaseLikeDb() {
    const db = new PGlite({ extensions: { uuid_ossp } });
    await db.exec(SUPABASE_PRELUDE);
    await db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    return db;
}

// The users/patients shape of a database created before the per-section
// access model: no is_super_admin, no read/write arrays, no patients.mobile /
// attachments / registered_by_name. `schema.sql` must upgrade it in place.
const LEGACY_SCHEMA = `
CREATE TABLE public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    section TEXT CHECK (section IN ('agamy', 'dekhila')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.patients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    national_id TEXT UNIQUE,
    record_type TEXT NOT NULL DEFAULT 'patient',
    date_of_birth DATE,
    age INTEGER,
    marital_status TEXT,
    children_count INTEGER,
    governorate TEXT,
    address TEXT,
    problem TEXT,
    solution TEXT,
    notes JSONB DEFAULT '[]'::jsonb,
    visit_date DATE,
    is_completed BOOLEAN DEFAULT FALSE,
    price DECIMAL(10, 2),
    follower TEXT,
    section TEXT CHECK (section IN ('agamy', 'dekhila')),
    source_of_money TEXT CHECK (source_of_money IN ('charity', 'country')),
    CHECK (record_type IN ('patient','food','classroom','well')),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
`;

/** A Postgres that predates the per-section access model, for upgrade tests. */
export async function createLegacyDb() {
    const db = new PGlite({ extensions: { uuid_ossp } });
    await db.exec(SUPABASE_PRELUDE);
    await db.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await db.exec(LEGACY_SCHEMA);
    return db;
}

/**
 * Runs one tests/rls/*.sql script inside a transaction that is always rolled
 * back, so scripts can seed fixtures and switch roles freely.
 */
export async function runRlsScript(db, name) {
    const assertSql = readFileSync(`${RLS_DIR}_assert.sql`, 'utf8');
    const scriptSql = readFileSync(`${RLS_DIR}${name}`, 'utf8');
    try {
        await db.exec(assertSql);
        await db.exec(scriptSql);
    } finally {
        try {
            await db.exec('ROLLBACK;');
        } catch {
            // No open transaction (the failure happened before BEGIN, or the
            // connection already cleaned up); nothing to roll back.
        }
    }
}
