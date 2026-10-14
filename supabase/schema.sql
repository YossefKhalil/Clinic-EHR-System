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

-- Idempotent column migrations for databases created by an older schema.
-- Safe to re-run: each line is a no-op when the column is already present.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS mobile TEXT;

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