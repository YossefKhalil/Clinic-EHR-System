-- Issue #44: stored search text, set-based section resolution, and the
-- dashboard/price aggregates. Runs inside the transaction opened by
-- _assert.sql; rolled back afterwards.

-- ---------------------------------------------------------------- fixtures --
INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data) VALUES
    ('60000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'issue44-reader@example.test', now(), '{"name":"Reader"}'),
    ('60000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'issue44-super@example.test', now(), '{"name":"Super"}');

UPDATE public.users SET is_super_admin = TRUE, is_admin = TRUE
    WHERE id = '60000000-0000-4000-8000-000000000002';
UPDATE public.users SET read_sections = '["agamy"]'::jsonb, write_sections = '[]'::jsonb
    WHERE id = '60000000-0000-4000-8000-000000000001';

INSERT INTO public.patients (name, national_id, section, mobile, price, is_completed, notes) VALUES
    ('Searchable patient', '29001011234571', 'agamy', '01000000001', 50.00, TRUE, '["cardiology"]'::jsonb),
    ('Dekhila patient', '29001011234572', 'dekhila', '01000000002', 200.00, FALSE, '[]'::jsonb),
    ('Another dekhila', '29001011234573', 'dekhila', '01000000003', 100.50, FALSE, '[]'::jsonb);

-- The trigger stores every field the old anysearch() concatenated.
SELECT public.rls_assert(
    position('Searchable patient' in (SELECT search_text FROM public.patients WHERE national_id = '29001011234571')) > 0,
    'search_text contains the name');
SELECT public.rls_assert(
    position('cardiology' in (SELECT search_text FROM public.patients WHERE national_id = '29001011234571')) > 0,
    'search_text contains notes');
SELECT public.rls_assert(
    position('complete completed' in (SELECT search_text FROM public.patients WHERE national_id = '29001011234571')) > 0,
    'search_text contains the completion words');

-- An update of a searchable column refreshes the blob.
UPDATE public.patients SET problem = 'migraine' WHERE national_id = '29001011234571';
SELECT public.rls_assert(
    position('migraine' in (SELECT search_text FROM public.patients WHERE national_id = '29001011234571')) > 0,
    'search_text follows an update');
SELECT public.rls_assert_eq(
    (SELECT public.anysearch(p) FROM public.patients p WHERE national_id = '29001011234571'),
    (SELECT search_text FROM public.patients WHERE national_id = '29001011234571'),
    'anysearch stays compatible with the stored column');

-- -------------------------------------------------------------- as reader --
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"60000000-0000-4000-8000-000000000001"}';

SELECT public.rls_assert_eq(public.readable_sections(), ARRAY['agamy']::text[],
    'reader resolves its read section once');
SELECT public.rls_assert_eq(public.writable_sections(), ARRAY[]::text[],
    'reader has no write sections');
SELECT public.rls_assert_eq((public.dashboard_stats()->>'total')::int, 1,
    'dashboard aggregate is RLS-scoped');
SELECT public.rls_assert_eq((public.dashboard_stats()->>'completed')::int, 1,
    'dashboard completed count is correct');
SELECT public.rls_assert_eq((public.dashboard_stats()->'sections'->>'agamy')::int, 1,
    'dashboard section breakdown is correct');
SELECT public.rls_assert_eq((public.price_stats()->>'grandTotal')::numeric, 50.00,
    'price aggregate is RLS-scoped');
SELECT public.rls_assert_eq((public.price_stats()->>'totalPatients')::int, 1,
    'price aggregate counts only visible rows');

-- --------------------------------------------------------- as super admin --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"60000000-0000-4000-8000-000000000002"}';

SELECT public.rls_assert(public.readable_sections() @> ARRAY['agamy', 'dekhila']::text[],
    'super admin resolves all configured sections');
SELECT public.rls_assert_eq((public.dashboard_stats()->>'total')::int, 3,
    'super admin dashboard sees every row');
SELECT public.rls_assert_eq((public.dashboard_stats()->>'pending')::int, 2,
    'super admin pending count is correct');
SELECT public.rls_assert_eq((public.price_stats()->>'grandTotal')::numeric, 350.50,
    'super admin price total includes every row');

RESET ROLE;
