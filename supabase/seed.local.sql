-- Local-only seed. Runs during `supabase db reset` on a developer machine.
--
-- It does NOT create the login account: that is done by
-- docs/local-host-testing/setup.ps1 through the Auth admin API, which is
-- portable across GoTrue versions (a hand-written auth.users INSERT is not).
--
-- This file is harmless on a hosted project because the local stack is the
-- only place `sql_paths` from supabase/config.toml is read.

-- A few sample patients so the dashboard and the review table are not empty.
-- Inserted only when the table has no rows, and only in the local database.
INSERT INTO public.patients (name, national_id, mobile, record_type, section, source_of_money, problem, notes)
SELECT * FROM (VALUES
    ('Local Test Patient',  '10000000000001', '01000000001', 'patient', 'agamy',   'charity', 'High blood pressure', '[]'::jsonb),
    ('Local Test Patient 2','10000000000002', '01000000002', 'patient', 'dekhila', 'country', 'Diabetes follow-up',  '[]'::jsonb),
    ('Local Food Case',     NULL,             '01000000003', 'food',    'agamy',   'charity', 'Monthly food support','[]'::jsonb)
) AS seed(name, national_id, mobile, record_type, section, source_of_money, problem, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.patients);
