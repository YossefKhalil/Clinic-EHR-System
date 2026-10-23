-- Clinic EHR — full database setup.
--
-- This file is idempotent: run the whole thing in the Supabase SQL editor to
-- set up a fresh project, or re-run it as-is on an existing one to repair it.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    is_super_admin BOOLEAN DEFAULT FALSE,
    section TEXT CHECK (section IN ('agamy', 'dekhila')),
    read_sections JSONB DEFAULT '[]'::jsonb,
    write_sections JSONB DEFAULT '[]'::jsonb,
    can_manage_users BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Patients table
CREATE TABLE IF NOT EXISTS public.patients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    national_id TEXT UNIQUE,
    record_type TEXT NOT NULL DEFAULT 'patient',
    mobile TEXT,
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

-- Databases that were created before the record types existed (patient,
-- food, classroom, well) get the column here - before anything reads it.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS record_type TEXT NOT NULL DEFAULT 'patient';

-- User profiles trigger
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.users (id, name, email, is_admin, section)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'name', NEW.email),
        NEW.email,
        -- Never trust signup metadata for privilege: anyone who can sign up
        -- controls raw_user_meta_data. Admin rows are granted explicitly.
        FALSE,
        NULL
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user creation
CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- RLS policies
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER helper to check admin/super admin status without RLS recursion
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND (is_super_admin = TRUE OR is_admin = TRUE)
    );
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND is_super_admin = TRUE
    );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_users()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND (is_super_admin = TRUE OR can_manage_users = TRUE)
    );
$$;

CREATE OR REPLACE FUNCTION public.can_read_section(p_section TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND (
            is_super_admin = TRUE OR
            is_admin = TRUE OR
            (read_sections IS NOT NULL AND read_sections ? p_section) OR
            (section = p_section AND is_admin = FALSE) OR
            (section = p_section)
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.can_write_section(p_section TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND (
            is_super_admin = TRUE OR
            is_admin = TRUE OR
            (write_sections IS NOT NULL AND write_sections ? p_section)
        )
    );
$$;

-- Same idea for section members: answers "is the caller a non-admin user of
-- section p_section?" without a policy re-reading public.users.
CREATE OR REPLACE FUNCTION public.is_section_user(p_section TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND is_admin = FALSE AND section = p_section
    );
$$;

-- Only signed-in callers should reach these helpers. They are deliberately
-- SECURITY DEFINER, so lock down who may execute them.
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_section_user(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_users() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_read_section(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_write_section(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_section_user(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_users() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_section(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_section(TEXT) TO authenticated;

-- Every policy below is written as DROP + CREATE so this whole file can be
-- re-run against an existing database to repair policies created by an
-- older schema. Policies must never read public.users directly: doing so
-- re-enters the RLS policies on public.users and Postgres aborts the query
-- with `infinite recursion detected in policy for relation "users"`.
-- All such checks go through the SECURITY DEFINER helpers above.

-- Users policies
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
    FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Admins can view all users" ON public.users;
CREATE POLICY "Admins can view all users" ON public.users
    FOR SELECT USING (public.is_admin() OR public.can_manage_users());

DROP POLICY IF EXISTS "Users can view all users" ON public.users;
CREATE POLICY "Users can view all users" ON public.users
    FOR SELECT USING (public.is_super_admin() OR public.can_manage_users());

DROP POLICY IF EXISTS "Admins can insert users" ON public.users;
CREATE POLICY "Admins can insert users" ON public.users
    FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_manage_users());

DROP POLICY IF EXISTS "Admins can update users" ON public.users;
CREATE POLICY "Admins can update users" ON public.users
    FOR UPDATE USING (public.is_super_admin() OR public.can_manage_users());

DROP POLICY IF EXISTS "Admins can delete users" ON public.users;
CREATE POLICY "Admins can delete users" ON public.users
    FOR DELETE USING (public.is_super_admin() OR public.can_manage_users());

-- Patients policies
DROP POLICY IF EXISTS "Admins can do everything with patients" ON public.patients;
CREATE POLICY "Admins can do everything with patients" ON public.patients
    FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "Users can view patients in permitted sections" ON public.patients;
CREATE POLICY "Users can view patients in permitted sections" ON public.patients
    FOR SELECT USING (public.can_read_section(patients.section) OR public.is_admin());

DROP POLICY IF EXISTS "Section users can view patients in their section" ON public.patients;
CREATE POLICY "Section users can view patients in their section" ON public.patients
    FOR SELECT USING (public.is_section_user(patients.section));

DROP POLICY IF EXISTS "Users can insert patients in writable sections" ON public.patients;
CREATE POLICY "Users can insert patients in writable sections" ON public.patients
    FOR INSERT WITH CHECK (public.can_write_section(patients.section) OR public.is_admin());

DROP POLICY IF EXISTS "Section users can insert patients in their section" ON public.patients;
CREATE POLICY "Section users can insert patients in their section" ON public.patients
    FOR INSERT WITH CHECK (public.is_section_user(patients.section));

DROP POLICY IF EXISTS "Users can update patients in writable sections" ON public.patients;
CREATE POLICY "Users can update patients in writable sections" ON public.patients
    FOR UPDATE USING (public.can_write_section(patients.section) OR public.is_admin());

DROP POLICY IF EXISTS "Section users can update patients in their section" ON public.patients;
CREATE POLICY "Section users can update patients in their section" ON public.patients
    FOR UPDATE USING (public.is_section_user(patients.section));

DROP POLICY IF EXISTS "Users can delete patients in writable sections" ON public.patients;
CREATE POLICY "Users can delete patients in writable sections" ON public.patients
    FOR DELETE USING (public.can_write_section(patients.section) OR public.is_admin());

DROP POLICY IF EXISTS "Section users can delete patients in their section" ON public.patients;
CREATE POLICY "Section users can delete patients in their section" ON public.patients
    FOR DELETE USING (public.is_section_user(patients.section));

-- Any-value search support: a computed field that renders every patient
-- column as one space-joined text blob. PostgREST exposes it automatically
-- (GET /patients?anysearch=ilike.*term*), so one search box can match a name,
-- a phone number, a year, an id, or a note without knowing which column.
-- Casts live inside the function because PostgREST does not allow casting
-- columns in filter expressions, and ilike on int4/timestamptz/jsonb raises
-- "operator does not exist".
-- It only reads the row itself, so no SECURITY DEFINER and no RLS change:
-- callers still only ever see patient rows their policies allow.
CREATE OR REPLACE FUNCTION public.anysearch(p public.patients)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
    SELECT concat_ws(
        ' ',
        p.name, p.national_id, p.mobile, p.governorate, p.address,
        p.problem, p.solution, p.follower, p.marital_status,
        p.source_of_money, p.section, p.record_type,
        p.age, p.children_count, p.visit_date, p.created_at, p.price,
        CASE WHEN p.is_completed THEN 'complete completed' ELSE 'pending' END,
        p.notes
    );
$$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_patients_national_id ON public.patients(national_id);
CREATE INDEX IF NOT EXISTS idx_patients_user_id ON public.patients(user_id);
CREATE INDEX IF NOT EXISTS idx_patients_section ON public.patients(section);
CREATE INDEX IF NOT EXISTS idx_patients_record_type ON public.patients(record_type);
CREATE INDEX IF NOT EXISTS idx_patients_is_completed ON public.patients(is_completed);
CREATE INDEX IF NOT EXISTS idx_patients_created_at ON public.patients(created_at);

-- Updated at trigger
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER update_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE TRIGGER update_patients_updated_at
    BEFORE UPDATE ON public.patients
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Editable option lists (issue #1): followers, clinic sections and sources of
-- money live here instead of being hard-coded in the client or the SQL CHECK
-- constraints. `key` is the immutable value stored on
-- patients rows; renaming an option changes only its labels. Deactivation is
-- a soft delete: existing patient rows keep rendering their stored key.
CREATE TABLE IF NOT EXISTS public.app_options (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind TEXT NOT NULL CHECK (kind IN ('follower', 'section', 'source')),
    key TEXT NOT NULL,
    label_en TEXT NOT NULL DEFAULT '',
    label_ar TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (kind, key)
);

ALTER TABLE public.app_options ENABLE ROW LEVEL SECURITY;

-- Everyone signed in reads options (forms, filters, export labels need
-- them); only admins write. This is the server-side half of the Settings
-- page access control — non-admins get a 403/permission error from PostgREST.
DROP POLICY IF EXISTS "Signed-in users can view options" ON public.app_options;
CREATE POLICY "Signed-in users can view options" ON public.app_options
    FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Admins can insert options" ON public.app_options;
CREATE POLICY "Admins can insert options" ON public.app_options
    FOR INSERT WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins can update options" ON public.app_options;
CREATE POLICY "Admins can update options" ON public.app_options
    FOR UPDATE USING (public.is_admin());

DROP POLICY IF EXISTS "Admins can delete options" ON public.app_options;
CREATE POLICY "Admins can delete options" ON public.app_options
    FOR DELETE USING (public.is_admin());

-- Seed the historical lists. ON CONFLICT keeps re-runs idempotent and never
-- overwrites an admin's later edit (no DO UPDATE on purpose).
INSERT INTO public.app_options (kind, key, label_en, label_ar, sort_order) VALUES
    ('follower', 'hassan_hamam', 'Hassan Hamam', 'حسن حمام', 1),
    ('follower', 'abdel_rahman_ahmed', 'Abdel Rahman Ahmed', 'عبد الرحمن أحمد', 2),
    ('follower', 'ahmed_saad', 'Ahmed Saad', 'احمد سعد', 3),
    ('follower', 'mohamed_ali', 'Mohamed Ali', 'محمد علي', 4),
    ('follower', 'mohamed_ahmed', 'Mohamed Ahmed', 'محمد أحمد', 5),
    ('follower', 'hazem', 'Hazem', 'حازم', 6),
    ('follower', 'mohamed_rabie', 'Mohamed Rabie', 'محمد ربيع', 7),
    ('section', 'agamy', 'Agamy', 'العجمي', 1),
    ('section', 'dekhila', 'Dekhila', 'الدخيلة', 2),
    ('source', 'charity', 'Charity', 'الجمعية الخيرية', 1),
    ('source', 'country', 'Country', 'الدولة', 2)
ON CONFLICT (kind, key) DO NOTHING;

-- The inline CHECKs only allowed the original two sections/sources and
-- cannot reference another table, so they are replaced by a trigger that
-- validates against app_options (any row, active or not: deactivated options
-- must stay valid on the patients that already carry them).
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_section_check;
ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_section_check;
ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_source_of_money_check;

CREATE OR REPLACE FUNCTION public.validate_patient_options()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.section IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.app_options WHERE kind = 'section' AND key = NEW.section
    ) THEN
        RAISE EXCEPTION 'Unknown section "%" - add it on the Settings page first', NEW.section;
    END IF;
    IF NEW.source_of_money IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.app_options WHERE kind = 'source' AND key = NEW.source_of_money
    ) THEN
        RAISE EXCEPTION 'Unknown source of money "%" - add it on the Settings page first', NEW.source_of_money;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_patient_options_trigger ON public.patients;
CREATE TRIGGER validate_patient_options_trigger
    BEFORE INSERT OR UPDATE ON public.patients
    FOR EACH ROW EXECUTE FUNCTION public.validate_patient_options();

CREATE OR REPLACE TRIGGER update_app_options_updated_at
    BEFORE UPDATE ON public.app_options
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Idempotent column migrations for databases created by an older schema.
-- Safe to re-run: each line is a no-op when the column is already present.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS read_sections JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS write_sections JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS can_manage_users BOOLEAN DEFAULT FALSE;
-- Migrate existing admins to super admins
UPDATE public.users SET is_super_admin = TRUE, can_manage_users = TRUE WHERE is_admin = TRUE AND is_super_admin = FALSE;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE public.patients ALTER COLUMN national_id DROP NOT NULL;
-- Medical/lab papers & images are stored on Cloudinary; the row keeps only
-- the metadata array [{ public_id, url, name, size, mime, uploaded_at }].
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;

-- Backfill profile rows for auth users created while the trigger was missing
-- or broken (sign-in otherwise succeeds but the profile cannot be loaded).
INSERT INTO public.users (id, name, email, is_admin, section)
SELECT
    u.id,
    COALESCE(u.raw_user_meta_data->>'name', u.email),
    u.email,
    FALSE,
    NULL
FROM auth.users u
LEFT JOIN public.users p ON p.id = u.id
WHERE p.id IS NULL;
-- Registrar name denormalization (#7): section staff cannot read other users'
-- rows through RLS, so the users join-based "Registered by" lookup returned
-- Unknown for them. Store the registrar name on the patient row at write time.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS registered_by_name TEXT;

UPDATE public.patients p
SET registered_by_name = u.name
FROM public.users u
WHERE p.user_id = u.id AND p.registered_by_name IS NULL;

CREATE OR REPLACE FUNCTION public.set_registered_by_name()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.registered_by_name IS NULL AND NEW.user_id IS NOT NULL THEN
        SELECT name INTO NEW.registered_by_name FROM public.users WHERE id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS patients_set_registered_by_name ON public.patients;
CREATE TRIGGER patients_set_registered_by_name
    BEFORE INSERT ON public.patients
    FOR EACH ROW EXECUTE FUNCTION public.set_registered_by_name();

-- ============================================================================
-- AI Import Agent — persistence (design spec §9, milestone M2)
--
-- Additive and idempotent like the rest of this file. State ownership: the
-- browser reads jobs, sources, chunks, rows, rejects and batches under RLS,
-- and edits nothing except its own rows' review fields; every state change
-- goes through the import-* Edge Functions with the service role. Staged
-- uploads live in the private `import-staging` bucket created below.

-- ============================================================================

-- Feature settings for the import agent (spec §14.4). Single row, like
-- ai_settings: `limits` carries deployment overrides for limits.js, and the
-- cleanup URL/secret wire the daily pg_cron call to the import-cleanup
-- function. Only Edge Functions (service role) read or write it.
CREATE TABLE IF NOT EXISTS public.import_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    limits JSONB NOT NULL DEFAULT '{}'::jsonb,
    cleanup_url TEXT,
    cleanup_secret TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.import_settings ENABLE ROW LEVEL SECURITY;
-- Explicit REVOKE (mirroring ai_settings): the row never appears on the
-- PostgREST surface, even for admins; a settings action in the import-job
-- function is the only writer.
REVOKE ALL ON TABLE public.import_settings FROM PUBLIC, anon, authenticated;

INSERT INTO public.import_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE TRIGGER update_import_settings_updated_at
    BEFORE UPDATE ON public.import_settings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- AI provider settings and encrypted keys. Recreated from the v1 AI import;
-- the encryption key is now the dedicated AI_SETTINGS_ENC_KEY secret
-- (spec §13.6), not one derived from the service-role key. `enabled` is the
-- `import_agent_enabled` feature flag: every import function checks it and
-- the client hides the entry point when false (spec §14.4).
CREATE TABLE IF NOT EXISTS public.ai_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    provider TEXT NOT NULL DEFAULT 'openrouter',
    openrouter_key_encrypted TEXT,
    cloudflare_account_id TEXT,
    cloudflare_token_encrypted TEXT,
    openai_base_url TEXT,
    openai_key_encrypted TEXT,
    groq_key_encrypted TEXT,
    -- Ordered [{ provider, model }] fallback chain. Empty means fall back to
    -- the legacy provider/model columns below.
    model_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
    model TEXT DEFAULT 'google/gemini-2.5-flash-lite',
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    -- Which engine the import runs on: 'cloud' sends the data to a provider,
    -- 'local' runs the model in the browser. `enabled = false` means Off.
    inference_mode TEXT NOT NULL DEFAULT 'cloud',
    -- The clinic accepted that cloud mode sends patient data to third
    -- parties. The record holds no patient data.
    cloud_consent BOOLEAN NOT NULL DEFAULT FALSE,
    cloud_consent_at TIMESTAMPTZ,
    -- The local models the clinic picked: name, size and SHA-256 only. The
    -- files and their handles stay in the browser.
    local_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The local runtime settings (context, KV cache, threads, lease).
    local_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_settings FROM PUBLIC, anon, authenticated;

-- Idempotent column migrations for databases created before multi-provider
-- support (they are no-ops on the CREATE TABLE above).
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'openrouter';
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS cloudflare_account_id TEXT;
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS cloudflare_token_encrypted TEXT;
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS openai_base_url TEXT;
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS openai_key_encrypted TEXT;
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS groq_key_encrypted TEXT;
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS model_chain JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Idempotent column migrations for the local engine.
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS inference_mode TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS cloud_consent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS cloud_consent_at TIMESTAMPTZ;
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS local_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS local_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The engine is one of the two known values. A row written by an older
-- deployment keeps working: it reads as 'cloud'.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ai_settings_inference_mode_check'
    ) THEN
        ALTER TABLE public.ai_settings
            ADD CONSTRAINT ai_settings_inference_mode_check
            CHECK (inference_mode IN ('cloud', 'local'));
    END IF;
END $$;

-- A clinic that already had the AI import switched on was already sending
-- patient data to a provider, so the consent record is written for it now.
-- Without this the new consent rule would refuse to save the settings of a
-- working clinic, and the import would look switched off.
UPDATE public.ai_settings
   SET cloud_consent = true,
       cloud_consent_at = COALESCE(cloud_consent_at, NOW())
 WHERE enabled = true
   AND cloud_consent = false
   AND cloud_consent_at IS NULL;

-- Import batch tracking (recreated from v1): every patient row written by one
-- commit carries the batch id; M7's undo removes exactly those rows. Nullable
-- on purpose: app-created patients have no batch.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS import_batch_id UUID;
CREATE INDEX IF NOT EXISTS idx_patients_import_batch_id ON public.patients(import_batch_id);

-- Cross-section duplicate detection (§8.6): RLS hides other sections'
-- patients from a caller, so this SECURITY DEFINER helper answers "does this
-- national id exist anywhere?" without exposing the rows themselves. M7 adds
-- `AND p.deleted_at IS NULL` when soft delete lands.
CREATE OR REPLACE FUNCTION public.existing_national_ids(ids text[])
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(array_agg(DISTINCT p.national_id), '{}')
    FROM unnest(ids) AS nid
    JOIN public.patients p ON p.national_id = nid
$$;

REVOKE ALL ON FUNCTION public.existing_national_ids(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.existing_national_ids(text[]) TO authenticated;

-- ----------------------------------------------------------------------------
-- Job tables (spec §9.3). `expires_at` and `token_cap` are deliberately set
-- by the import-job function from limits.js instead of SQL defaults, so every
-- tunable keeps a single source of truth.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.import_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID NOT NULL REFERENCES auth.users(id),
    section TEXT,                                  -- default section chosen at start
    status TEXT NOT NULL DEFAULT 'uploaded'
        CHECK (status IN ('uploaded','extracting','review','committing','done','cancelled','failed')),
    config JSONB NOT NULL,                         -- enum snapshot, prompt ids, provider/model, limits, defaults
    hints TEXT,
    counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    token_cap INTEGER NOT NULL,
    batch_id UUID,
    commit_key UUID UNIQUE,                        -- idempotency key from the client
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    cancelled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.import_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.import_jobs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    kind TEXT NOT NULL,                            -- sheet | docx | pdf | image | text
    name TEXT,
    mime TEXT,
    bytes INTEGER,
    sha256 TEXT,
    storage_path TEXT,                             -- `<user-id>/<job-id>/<idx>-<name>` in import-staging
    meta JSONB,
    warnings JSONB,
    UNIQUE (job_id, idx)
);

CREATE TABLE IF NOT EXISTS public.import_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.import_jobs(id) ON DELETE CASCADE,
    source_id UUID REFERENCES public.import_sources(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    parent_chunk UUID,                             -- set when a chunk was split
    kind TEXT NOT NULL,
    payload JSONB,
    payload_path TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','done','failed','split')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until TIMESTAMPTZ,                       -- pump lease (§9.5)
    error_code TEXT,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    prompt_id TEXT,
    model TEXT,
    model_sha256 TEXT,                             -- local mode: hash of the model file
    tokens_in INTEGER,
    tokens_out INTEGER,
    raw_response_path TEXT,
    UNIQUE (job_id, idx)
);

-- Idempotent migration for jobs created before the model hash was audited.
ALTER TABLE public.import_chunks ADD COLUMN IF NOT EXISTS model_sha256 TEXT;

CREATE TABLE IF NOT EXISTS public.import_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.import_jobs(id) ON DELETE CASCADE,
    chunk_id UUID REFERENCES public.import_chunks(id) ON DELETE SET NULL,
    seq INTEGER NOT NULL,
    src JSONB,                                     -- cited line ids
    extracted JSONB,                               -- parsed model output, untouched (nulled by retention)
    cells JSONB,                                   -- { field: { value, origin, raw } } (nulled by retention)
    issues JSONB NOT NULL DEFAULT '[]'::jsonb,
    acknowledged JSONB NOT NULL DEFAULT '[]'::jsonb,
    dup JSONB,                                     -- { kind, action, existing_id? }
    status TEXT NOT NULL DEFAULT 'review'
        CHECK (status IN ('ready','review','error')),
    removed BOOLEAN NOT NULL DEFAULT FALSE,
    commit_result JSONB,                           -- { result: created|filled|skipped|failed, patient_id?, code? }
    version INTEGER NOT NULL DEFAULT 1,            -- optimistic concurrency (§9.6)
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chunk_id, seq)                         -- duplicate delivery cannot duplicate rows
);

CREATE TABLE IF NOT EXISTS public.import_rejects (     -- the tray (invariant I8)
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES public.import_jobs(id) ON DELETE CASCADE,
    chunk_id UUID,
    reason TEXT NOT NULL,
    raw TEXT,
    src JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()  -- tray ordering (not in §9.3)
);

CREATE TABLE IF NOT EXISTS public.import_batches (
    id UUID PRIMARY KEY,                           -- also stamped on patients.import_batch_id
    job_id UUID NOT NULL REFERENCES public.import_jobs(id),
    committed_by UUID NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    counts JSONB NOT NULL,
    undone_at TIMESTAMPTZ,
    undone_by UUID,
    undo_result JSONB
);

CREATE TABLE IF NOT EXISTS public.import_batch_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
    patient_id UUID NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('created','filled')),
    before JSONB,                                  -- for 'filled': previous values of changed fields
    after JSONB                                    -- values written
);

-- Cost and cap accounting (spec §13.5, §16). No PHI: ids, tokens, cost only.
-- Rows are written by the functions; admins read them for dashboards (M9).
CREATE TABLE IF NOT EXISTS public.ai_usage (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    job_id UUID,
    chunk_id UUID,
    model TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_est NUMERIC(10,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit trail (spec §9.3, §12.7): actor, action, entity, ids and counts only;
-- never PHI. Actions: job.created, job.committed, job.undone, job.cancelled.
CREATE TABLE IF NOT EXISTS public.audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor UUID,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_created_by ON public.import_jobs(created_by);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON public.import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_import_chunks_job_status ON public.import_chunks(job_id, status);
CREATE INDEX IF NOT EXISTS idx_import_rows_job_status ON public.import_rows(job_id, status);
-- The review load reads a job's rows ordered by seq; `seq` is unique per
-- chunk only, so the id breaks the ties and the range paging cannot drop
-- rows.
CREATE INDEX IF NOT EXISTS idx_import_rows_job_seq ON public.import_rows(job_id, seq, id);
CREATE INDEX IF NOT EXISTS idx_import_rejects_job ON public.import_rejects(job_id);
CREATE INDEX IF NOT EXISTS idx_import_batches_job ON public.import_batches(job_id);
CREATE INDEX IF NOT EXISTS idx_import_batch_items_batch ON public.import_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON public.ai_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_job ON public.ai_usage(job_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON public.audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON public.audit_log(created_at);

CREATE OR REPLACE TRIGGER update_import_jobs_updated_at
    BEFORE UPDATE ON public.import_jobs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE OR REPLACE TRIGGER update_import_rows_updated_at
    BEFORE UPDATE ON public.import_rows
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ----------------------------------------------------------------------------
-- Row-level security (spec §9.4). Read access follows job ownership (plus
-- admins); writes from the client are limited to review edits on the owner's
-- own rows. All state changes go through service-role Edge Functions.
-- ----------------------------------------------------------------------------

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_rejects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Same pattern as is_admin()/is_section_user(): SECURITY DEFINER helpers so
-- a policy can ask "does the caller own this job?" without re-entering the
-- import_jobs policies. They answer booleans about ids the caller already
-- holds and never expose row contents.
CREATE OR REPLACE FUNCTION public.import_job_access(p_job_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.import_jobs j
        WHERE j.id = p_job_id AND (j.created_by = auth.uid() OR public.is_admin())
    );
$$;

CREATE OR REPLACE FUNCTION public.import_job_owned(p_job_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.import_jobs j
        WHERE j.id = p_job_id AND j.created_by = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.import_batch_access(p_batch_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.import_batches b
        WHERE b.id = p_batch_id AND (b.committed_by = auth.uid() OR public.is_admin())
    );
$$;

REVOKE ALL ON FUNCTION public.import_job_access(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.import_job_owned(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.import_batch_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_job_access(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_job_owned(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_batch_access(UUID) TO authenticated;

DROP POLICY IF EXISTS "Owner and admins read jobs" ON public.import_jobs;
CREATE POLICY "Owner and admins read jobs" ON public.import_jobs
    FOR SELECT USING (public.import_job_access(id));

DROP POLICY IF EXISTS "Owner and admins read sources" ON public.import_sources;
CREATE POLICY "Owner and admins read sources" ON public.import_sources
    FOR SELECT USING (public.import_job_access(job_id));

DROP POLICY IF EXISTS "Owner and admins read chunks" ON public.import_chunks;
CREATE POLICY "Owner and admins read chunks" ON public.import_chunks
    FOR SELECT USING (public.import_job_access(job_id));

DROP POLICY IF EXISTS "Owner and admins read rows" ON public.import_rows;
CREATE POLICY "Owner and admins read rows" ON public.import_rows
    FOR SELECT USING (public.import_job_access(job_id));

-- The owner edits review state only, with the optimistic-concurrency bump;
-- the guard trigger below enforces the column set.
DROP POLICY IF EXISTS "Owner edits own rows" ON public.import_rows;
CREATE POLICY "Owner edits own rows" ON public.import_rows
    FOR UPDATE USING (public.import_job_owned(job_id))
    WITH CHECK (public.import_job_owned(job_id));

DROP POLICY IF EXISTS "Owner and admins read rejects" ON public.import_rejects;
CREATE POLICY "Owner and admins read rejects" ON public.import_rejects
    FOR SELECT USING (public.import_job_access(job_id));

-- The owner resolves tray items: moving unmapped text into a cell removes its
-- reject row (spec 10.7), so owners may delete their own job's items only.
DROP POLICY IF EXISTS "Owner deletes own rejects" ON public.import_rejects;
CREATE POLICY "Owner deletes own rejects" ON public.import_rejects
    FOR DELETE USING (public.import_job_owned(job_id));

DROP POLICY IF EXISTS "Owner and admins read batches" ON public.import_batches;
CREATE POLICY "Owner and admins read batches" ON public.import_batches
    FOR SELECT USING (public.import_batch_access(id));

DROP POLICY IF EXISTS "Owner and admins read batch items" ON public.import_batch_items;
CREATE POLICY "Owner and admins read batch items" ON public.import_batch_items
    FOR SELECT USING (public.import_batch_access(batch_id));

DROP POLICY IF EXISTS "Admins read usage" ON public.ai_usage;
CREATE POLICY "Admins read usage" ON public.ai_usage
    FOR SELECT USING (public.is_admin());

DROP POLICY IF EXISTS "Admins read the audit log" ON public.audit_log;
CREATE POLICY "Admins read the audit log" ON public.audit_log
    FOR SELECT USING (public.is_admin());

-- Client review edits are restricted to the columns the review UI owns.
-- Extraction artefacts (src, extracted) and commit results are immutable from
-- PostgREST; service role and direct SQL bypass this trigger. `status` is
-- included because it is derived from the same review fields the owner may
-- change; the commit path re-validates everything server-side (spec §11.2).
CREATE OR REPLACE FUNCTION public.guard_import_row_update()
RETURNS TRIGGER AS $$
BEGIN
    IF current_user IN ('anon', 'authenticated') THEN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.job_id IS DISTINCT FROM OLD.job_id
           OR NEW.chunk_id IS DISTINCT FROM OLD.chunk_id
           OR NEW.seq IS DISTINCT FROM OLD.seq
           OR NEW.src IS DISTINCT FROM OLD.src
           OR NEW.extracted IS DISTINCT FROM OLD.extracted
           OR NEW.commit_result IS DISTINCT FROM OLD.commit_result THEN
            RAISE EXCEPTION 'import_rows: only the review fields (cells, issues, acknowledged, dup, removed, status, version) may be changed by the owner'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
            RAISE EXCEPTION 'import_rows: version must be incremented by exactly 1'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS guard_import_row_update_trigger ON public.import_rows;
CREATE TRIGGER guard_import_row_update_trigger
    BEFORE UPDATE ON public.import_rows
    FOR EACH ROW EXECUTE FUNCTION public.guard_import_row_update();

-- ----------------------------------------------------------------------------
-- The pump's claim step (spec §9.5). Every tunable is an argument (the pump
-- passes resolved limits.js values: PUMP_PARALLEL, LEASE_SECONDS,
-- MAX_ATTEMPTS), so no limit lives twice in SQL. Expired leases make a
-- crashed chunk claimable again; attempts cap out at p_max_attempts.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.import_claim_chunks(
    p_job_id UUID,
    p_limit INTEGER,
    p_lease_seconds INTEGER,
    p_max_attempts INTEGER
)
RETURNS SETOF public.import_chunks
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.import_chunks c
       SET status = 'running',
           lease_until = NOW() + make_interval(secs => p_lease_seconds),
           attempts = c.attempts + 1
     WHERE c.id IN (
        SELECT id FROM public.import_chunks
         WHERE job_id = p_job_id
           AND attempts < p_max_attempts
           AND (status = 'queued' OR (status = 'running' AND lease_until < NOW()))
         ORDER BY idx
         FOR UPDATE SKIP LOCKED
         LIMIT p_limit
     )
    RETURNING c.*;
$$;

REVOKE ALL ON FUNCTION public.import_claim_chunks(UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_claim_chunks(UUID, INTEGER, INTEGER, INTEGER) TO service_role;

-- Token accounting (spec §13.5): the pump adds each call's usage to the job
-- row atomically, so parallel chunks and concurrent pump calls cannot lose an
-- increment. Called only by the import-job function (service role).
CREATE OR REPLACE FUNCTION public.import_bump_tokens(
    p_job_id UUID,
    p_in INTEGER,
    p_out INTEGER
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.import_jobs
       SET tokens_in = tokens_in + GREATEST(COALESCE(p_in, 0), 0),
           tokens_out = tokens_out + GREATEST(COALESCE(p_out, 0), 0),
           updated_at = NOW()
     WHERE id = p_job_id;
$$;

REVOKE ALL ON FUNCTION public.import_bump_tokens(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_bump_tokens(UUID, INTEGER, INTEGER) TO service_role;

-- ----------------------------------------------------------------------------
-- Retention (spec §9.7). The SQL half (rows, batch payloads) runs from cron
-- without the Storage API; the import-cleanup Edge Function adds the storage
-- purge (files, chunk payloads, raw responses) and passes resolved limits.
-- The fallback defaults mirror limits.js ROW_RETENTION_DAYS and
-- BATCH_PAYLOAD_RETENTION_DAYS for the no-function cron path.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.import_run_retention(
    p_row_days INTEGER DEFAULT 30,
    p_batch_days INTEGER DEFAULT 90
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rows INTEGER;
    v_batch_items INTEGER;
BEGIN
    -- Rows of finished jobs: drop the payloads, keep the counts and results.
    UPDATE public.import_rows r
       SET extracted = NULL, cells = NULL
      FROM public.import_jobs j
     WHERE r.job_id = j.id
       AND j.status IN ('done', 'cancelled')
       AND j.updated_at < NOW() - make_interval(days => p_row_days)
       AND (r.extracted IS NOT NULL OR r.cells IS NOT NULL);
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- Undo payloads past the window; the batch record itself stays.
    UPDATE public.import_batch_items i
       SET before = NULL, after = NULL
     WHERE i.batch_id IN (
        SELECT b.id FROM public.import_batches b
         WHERE b.committed_at < NOW() - make_interval(days => p_batch_days)
     )
       AND (i.before IS NOT NULL OR i.after IS NOT NULL);
    GET DIAGNOSTICS v_batch_items = ROW_COUNT;

    RETURN jsonb_build_object('rows_cleared', v_rows, 'batch_items_cleared', v_batch_items);
END;
$$;

REVOKE ALL ON FUNCTION public.import_run_retention(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_run_retention(INTEGER, INTEGER) TO service_role;

-- Daily maintenance: SQL retention, then (when configured) a call to the
-- import-cleanup function for the storage purge. The pg_net call is dynamic
-- so this function can be created on projects where pg_net is not enabled.
CREATE OR REPLACE FUNCTION public.import_daily_maintenance()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_url TEXT;
    v_secret TEXT;
BEGIN
    PERFORM public.import_run_retention();

    SELECT cleanup_url, cleanup_secret INTO v_url, v_secret
      FROM public.import_settings WHERE id;
    IF v_url IS NULL OR btrim(v_url) = '' THEN
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
        RAISE WARNING 'import_daily_maintenance: pg_net is not installed; storage cleanup call skipped';
        RETURN;
    END IF;

    EXECUTE format(
        'SELECT net.http_post(url := %L, headers := jsonb_build_object(''content-type'', ''application/json'', ''x-cleanup-secret'', %L), body := ''{}''::jsonb)',
        v_url, COALESCE(v_secret, '')
    );
END;
$$;

REVOKE ALL ON FUNCTION public.import_daily_maintenance() FROM PUBLIC, anon, authenticated;

-- Enable pg_cron/pg_net and schedule the daily run. Both extension steps are
-- guarded: where they are unavailable (or not permitted from this file) the
-- schema still applies — enable them from the dashboard and re-run this file
-- (or run cron.schedule from docs/import-agent/m2-persistence.md).
DO $$ BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not available here: %', SQLERRM;
END $$;

DO $$ BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_net;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_net not available here: %', SQLERRM;
END $$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule('import-daily-maintenance', '15 3 * * *', 'SELECT public.import_daily_maintenance()');
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;

-- ----------------------------------------------------------------------------
-- Staging bucket (spec §9.4). Private; objects live under
-- `<auth-user-id>/<job-id>/…` so the owner can upload and read through RLS.
-- The functions read/delete with the service role (which bypasses RLS).
-- ----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('import-staging', 'import-staging', FALSE)
ON CONFLICT (id) DO UPDATE SET public = FALSE;

DROP POLICY IF EXISTS "Import staging: owner uploads" ON storage.objects;
CREATE POLICY "Import staging: owner uploads" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'import-staging' AND split_part(name, '/', 1) = auth.uid()::text);

DROP POLICY IF EXISTS "Import staging: owner reads" ON storage.objects;
CREATE POLICY "Import staging: owner reads" ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'import-staging' AND split_part(name, '/', 1) = auth.uid()::text);

-- ============================================================================
-- ============================================================================
-- The commit (spec §11): the reviewed rows become patients.
--
-- The Edge Function rebuilds the plan with the shared rules engine (it does
-- not trust the browser) and hands this function the rows to write. The write
-- happens in ONE transaction: either the whole batch lands, or nothing does.
--
--   * `create`  - a new patient row.
--   * `fill`    - only the empty columns of the patient with the same
--                 national id are filled (the partner may be a patient that
--                 already exists or an earlier row of the same import).
--   * `skip`    - nothing is written; the row keeps its result and code.
--
-- Every write is recorded in `import_batch_items` (before/after) so the undo
-- (the next milestone) can reverse it, and the row's `commit_result` says
-- what happened to it.
-- ============================================================================
--
-- The Edge Function rebuilds the plan with the shared rules engine (it does
-- not trust the browser) and hands this function the rows to write. The write
-- happens in ONE transaction: either the whole batch lands, or nothing does.
--
--   * `create`  - a new patient row.
--   * `fill`    - only the empty columns of the patient with the same
--                 national id are filled (the partner may be a patient that
--                 already exists or an earlier row of the same import).
--   * `skip`    - nothing is written; the row keeps its result and code.
--
-- Every write is recorded in `import_batch_items` (before/after) so the undo
-- (the next milestone) can reverse it, and the row's `commit_result` says
-- what happened to it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.import_commit(
    p_job_id UUID,
    p_commit_key UUID,
    p_actor UUID,
    p_rows JSONB,
    p_meta JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $commit$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    -- gen_random_uuid() is a core function: uuid_generate_v4() lives in
    -- the extension's schema, which this function's search_path does not
    -- include.
    v_batch_id UUID := gen_random_uuid();
    v_created INT := 0;
    v_filled INT := 0;
    v_skipped INT := 0;
    v_row JSONB;
    v_values JSONB;
    v_fill JSONB;
    v_patient UUID;
    v_before JSONB;
    v_after JSONB;
    v_nid TEXT;
    v_code TEXT;
    v_action TEXT;
    v_row_id UUID;
BEGIN
    -- The job is locked for the whole write: two concurrent commits cannot
    -- both create the same patients.
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'import job % not found', p_job_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_job.created_by <> p_actor THEN
        RAISE EXCEPTION 'this import belongs to another account' USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- The same key twice is the same commit (the client retries with the same
    -- key); a different key on a committed job is a conflict.
    IF v_job.commit_key IS NOT NULL THEN
        IF v_job.commit_key = p_commit_key THEN
            RETURN jsonb_build_object(
                'batch_id', v_job.batch_id,
                'created', 0, 'filled', 0, 'skipped', 0,
                'idempotent', true,
                'counts', COALESCE(v_job.counts, '{}'::jsonb)
            );
        END IF;
        RAISE EXCEPTION 'this import was already committed' USING ERRCODE = 'check_violation';
    END IF;
    IF v_job.status <> 'review' THEN
        RAISE EXCEPTION 'this import is not ready (status %)', v_job.status USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.import_batches (id, job_id, committed_by, counts)
    VALUES (v_batch_id, p_job_id, p_actor, '{}'::jsonb);

    FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
        v_action := v_row->>'action';
        v_code := v_row->>'code';
        v_values := COALESCE(v_row->'values', '{}'::jsonb);
        v_fill := COALESCE(v_row->'fill', '{}'::jsonb);
        v_nid := NULLIF(v_values->>'national_id', '');
        v_row_id := NULLIF(v_row->>'row_id', '')::UUID;

        IF v_action = 'skip' OR v_row_id IS NULL THEN
            IF v_row_id IS NOT NULL THEN
                UPDATE public.import_rows
                SET commit_result = jsonb_build_object('result', 'skipped', 'code', COALESCE(v_code, 'SKIPPED'))
                WHERE id = v_row_id;
            END IF;
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        IF v_action = 'fill' THEN
            v_nid := COALESCE(NULLIF(v_row->>'target_national_id', ''), v_nid);
            SELECT p.id, to_jsonb(p) - 'id' - 'created_at' - 'updated_at'
            INTO v_patient, v_before
            FROM public.patients p
            WHERE p.national_id = v_nid
            FOR UPDATE;

            IF v_patient IS NULL THEN
                -- The partner is not in the database (it was skipped): there is
                -- nothing to fill.
                UPDATE public.import_rows
                SET commit_result = jsonb_build_object('result', 'skipped', 'code', 'PARTNER_MISSING')
                WHERE id = v_row_id;
                v_skipped := v_skipped + 1;
                CONTINUE;
            END IF;

            -- Only the empty columns are filled: the stored patient wins.
            UPDATE public.patients SET
                mobile = COALESCE(NULLIF(mobile, ''), NULLIF(v_fill->>'mobile', '')),
                date_of_birth = COALESCE(date_of_birth, NULLIF(v_fill->>'date_of_birth', '')::DATE),
                marital_status = COALESCE(NULLIF(marital_status, ''), NULLIF(v_fill->>'marital_status', '')),
                children_count = COALESCE(children_count, NULLIF(v_fill->>'children_count', '')::INT),
                governorate = COALESCE(NULLIF(governorate, ''), NULLIF(v_fill->>'governorate', '')),
                address = COALESCE(NULLIF(address, ''), NULLIF(v_fill->>'address', '')),
                problem = COALESCE(NULLIF(problem, ''), NULLIF(v_fill->>'problem', '')),
                solution = COALESCE(NULLIF(solution, ''), NULLIF(v_fill->>'solution', '')),
                visit_date = COALESCE(visit_date, NULLIF(v_fill->>'visit_date', '')::DATE),
                price = COALESCE(price, NULLIF(v_fill->>'price', '')::NUMERIC),
                follower = COALESCE(NULLIF(follower, ''), NULLIF(v_fill->>'follower', ''))
            WHERE id = v_patient
            RETURNING to_jsonb(patients) - 'id' - 'created_at' - 'updated_at' INTO v_after;

            INSERT INTO public.import_batch_items (batch_id, patient_id, action, before, after)
            VALUES (v_batch_id, v_patient, 'filled', v_before, v_after);

            UPDATE public.import_rows
            SET commit_result = jsonb_build_object('result', 'filled', 'patient_id', v_patient)
            WHERE id = v_row_id;
            v_filled := v_filled + 1;
            CONTINUE;
        END IF;

        -- create
        BEGIN
            INSERT INTO public.patients (
                name, national_id, mobile, date_of_birth, age, marital_status,
                children_count, governorate, address, problem, solution, notes,
                visit_date, price, follower, section, source_of_money,
                user_id, registered_by_name, import_batch_id
            ) VALUES (
                v_values->>'name',
                v_nid,
                NULLIF(v_values->>'mobile', ''),
                NULLIF(v_values->>'date_of_birth', '')::DATE,
                NULLIF(v_values->>'age', '')::INT,
                NULLIF(v_values->>'marital_status', ''),
                NULLIF(v_values->>'children_count', '')::INT,
                NULLIF(v_values->>'governorate', ''),
                NULLIF(v_values->>'address', ''),
                NULLIF(v_values->>'problem', ''),
                NULLIF(v_values->>'solution', ''),
                COALESCE(v_values->'notes', '[]'::jsonb),
                NULLIF(v_values->>'visit_date', '')::DATE,
                NULLIF(v_values->>'price', '')::NUMERIC,
                NULLIF(v_values->>'follower', ''),
                NULLIF(v_values->>'section', ''),
                NULLIF(v_values->>'source_of_money', ''),
                p_actor,
                p_meta->>'registered_by_name',
                v_batch_id
            )
            RETURNING id INTO v_patient;
        EXCEPTION WHEN unique_violation THEN
            -- The national id is taken (a duplicate the reviewer kept, or a
            -- patient that appeared meanwhile): the row is reported, the
            -- batch continues.
            UPDATE public.import_rows
            SET commit_result = jsonb_build_object('result', 'skipped', 'code', 'NID_TAKEN')
            WHERE id = v_row_id;
            v_skipped := v_skipped + 1;
            CONTINUE;
        WHEN check_violation THEN
            -- An unknown section or source of money: the option was deleted
            -- after the snapshot. The row is reported, the batch continues.
            UPDATE public.import_rows
            SET commit_result = jsonb_build_object('result', 'skipped', 'code', 'INVALID_OPTION')
            WHERE id = v_row_id;
            v_skipped := v_skipped + 1;
            CONTINUE;
        WHEN not_null_violation OR data_exception OR numeric_value_out_of_range THEN
            -- A value the database cannot store (an empty name, a date that
            -- is not a date). The row is reported, the batch continues.
            UPDATE public.import_rows
            SET commit_result = jsonb_build_object('result', 'skipped', 'code', 'INVALID_VALUE')
            WHERE id = v_row_id;
            v_skipped := v_skipped + 1;
            CONTINUE;
        END;

        SELECT to_jsonb(p) - 'id' - 'created_at' - 'updated_at'
        INTO v_after FROM public.patients p WHERE p.id = v_patient;

        INSERT INTO public.import_batch_items (batch_id, patient_id, action, after)
        VALUES (v_batch_id, v_patient, 'created', v_after);

        UPDATE public.import_rows
        SET commit_result = jsonb_build_object('result', 'created', 'patient_id', v_patient)
        WHERE id = v_row_id;
        v_created := v_created + 1;
    END LOOP;

    UPDATE public.import_batches
    SET counts = jsonb_build_object('created', v_created, 'filled', v_filled, 'skipped', v_skipped)
    WHERE id = v_batch_id;

    UPDATE public.import_jobs
    SET status = 'done',
        commit_key = p_commit_key,
        batch_id = v_batch_id,
        counts = jsonb_build_object('created', v_created, 'filled', v_filled, 'skipped', v_skipped),
        updated_at = NOW()
    WHERE id = p_job_id;

    RETURN jsonb_build_object(
        'batch_id', v_batch_id,
        'created', v_created,
        'filled', v_filled,
        'skipped', v_skipped,
        'idempotent', false
    );
END;
$commit$;

REVOKE ALL ON FUNCTION public.import_commit(UUID, UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_commit(UUID, UUID, UUID, JSONB, JSONB) TO service_role;
