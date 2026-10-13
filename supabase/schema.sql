-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (extends Supabase auth.users)
CREATE TABLE public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    section TEXT CHECK (section IN ('agamy', 'dekhila')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Patients table
CREATE TABLE public.patients (
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
        COALESCE((NEW.raw_user_meta_data->>'is_admin')::boolean, FALSE),
        NEW.raw_user_meta_data->>'section'
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

-- Users policies
CREATE POLICY "Users can view own profile" ON public.users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Admins can view all users" ON public.users
    FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can insert users" ON public.users
    FOR INSERT WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update users" ON public.users
    FOR UPDATE USING (public.is_admin());

CREATE POLICY "Admins can delete users" ON public.users
    FOR DELETE USING (public.is_admin());

-- Patients policies
CREATE POLICY "Admins can do everything with patients" ON public.patients
    FOR ALL USING (public.is_admin());

CREATE POLICY "Section users can view patients in their section" ON public.patients
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = auth.uid() AND is_admin = FALSE AND section = patients.section
        )
    );

CREATE POLICY "Section users can insert patients in their section" ON public.patients
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = auth.uid() AND is_admin = FALSE AND section = patients.section
        )
    );

CREATE POLICY "Section users can update patients in their section" ON public.patients
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = auth.uid() AND is_admin = FALSE AND section = patients.section
        )
    );

CREATE POLICY "Section users can delete patients in their section" ON public.patients
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE id = auth.uid() AND is_admin = FALSE AND section = patients.section
        )
    );

-- Indexes
CREATE INDEX idx_patients_national_id ON public.patients(national_id);
CREATE INDEX idx_patients_user_id ON public.patients(user_id);
CREATE INDEX idx_patients_section ON public.patients(section);
CREATE INDEX idx_patients_is_completed ON public.patients(is_completed);
CREATE INDEX idx_patients_created_at ON public.patients(created_at);

-- Updated at trigger
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER update_patients_updated_at
    BEFORE UPDATE ON public.patients
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Migration for databases created before the age column existed.
-- Safe to re-run: no-op when the column is already present.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS age INTEGER;