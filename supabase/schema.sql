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
    section TEXT CHECK (section IN ('agamy', 'dekhila')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Patients table
CREATE TABLE IF NOT EXISTS public.patients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    national_id TEXT UNIQUE NOT NULL,
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
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- SECURITY DEFINER helper to check admin status without RLS recursion
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND is_admin = TRUE
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
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_section_user(TEXT) TO authenticated;

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
    FOR SELECT USING (public.is_admin());

DROP POLICY IF EXISTS "Admins can insert users" ON public.users;
CREATE POLICY "Admins can insert users" ON public.users
    FOR INSERT WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins can update users" ON public.users;
CREATE POLICY "Admins can update users" ON public.users
    FOR UPDATE USING (public.is_admin());

DROP POLICY IF EXISTS "Admins can delete users" ON public.users;
CREATE POLICY "Admins can delete users" ON public.users
    FOR DELETE USING (public.is_admin());

-- Patients policies
DROP POLICY IF EXISTS "Admins can do everything with patients" ON public.patients;
CREATE POLICY "Admins can do everything with patients" ON public.patients
    FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "Section users can view patients in their section" ON public.patients;
CREATE POLICY "Section users can view patients in their section" ON public.patients
    FOR SELECT USING (public.is_section_user(patients.section));

DROP POLICY IF EXISTS "Section users can insert patients in their section" ON public.patients;
CREATE POLICY "Section users can insert patients in their section" ON public.patients
    FOR INSERT WITH CHECK (public.is_section_user(patients.section));

DROP POLICY IF EXISTS "Section users can update patients in their section" ON public.patients;
CREATE POLICY "Section users can update patients in their section" ON public.patients
    FOR UPDATE USING (public.is_section_user(patients.section));

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
        p.source_of_money, p.section,
        p.age, p.children_count, p.visit_date, p.created_at, p.price,
        CASE WHEN p.is_completed THEN 'complete completed' ELSE 'pending' END,
        p.notes
    );
$$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_patients_national_id ON public.patients(national_id);
CREATE INDEX IF NOT EXISTS idx_patients_user_id ON public.patients(user_id);
CREATE INDEX IF NOT EXISTS idx_patients_section ON public.patients(section);
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
-- money live here instead of being hard-coded in the client, the SQL CHECK
-- constraints and the AI prompt. `key` is the immutable value stored on
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

-- Single-row table holding the OpenRouter integration settings (issue #10).
-- The API key is stored as AES-GCM ciphertext produced by the ai-settings
-- Edge Function; the encryption key is derived from the service-role key, so
-- no caller can ever read the plaintext back out of Postgres.
CREATE TABLE IF NOT EXISTS public.ai_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    openrouter_key_encrypted TEXT,
    model TEXT DEFAULT 'google/gemini-2.5-flash-lite',
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;
-- RLS with no policies denies every anon/authenticated request; the explicit
-- REVOKE keeps the table off the PostgREST API surface entirely. Only
-- service-role calls from Edge Functions can touch it.
REVOKE ALL ON TABLE public.ai_settings FROM PUBLIC, anon, authenticated;

-- Idempotent column migrations for databases created by an older schema.
-- Safe to re-run: each line is a no-op when the column is already present.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS mobile TEXT;
-- Medical/lab papers & images are stored on Cloudinary; the row keeps only
-- the metadata array [{ public_id, url, name, size, mime, uploaded_at }].
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;

-- The per-user OpenRouter key was superseded by the shared ai_settings row
-- above; drop the legacy column wherever it exists.
ALTER TABLE public.users DROP COLUMN IF EXISTS openrouter_api_key;

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