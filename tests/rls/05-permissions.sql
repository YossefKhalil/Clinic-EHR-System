-- Per-section permissions (issue #39): the Super Admin role, the read/write
-- grant arrays, "write implies read", and the Super-Admin-only users table.
-- Runs inside the transaction opened by _assert.sql; rolled back afterwards.
--
-- Fixed ids:
--   super 50000000-...-01 | reader 50000000-...-02 | writer 50000000-...-03
--   write-only 50000000-...-04 | legacy 50000000-...-05

-- ---------------------------------------------------------------- fixtures --
INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data) VALUES
    ('50000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'perm-super@example.test', now(), '{"name":"Super Admin"}'),
    ('50000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'perm-reader@example.test', now(), '{"name":"Reader"}'),
    ('50000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'perm-writer@example.test', now(), '{"name":"Writer"}'),
    ('50000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'perm-writeonly@example.test', now(), '{"name":"Write Only"}'),
    ('50000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'perm-legacy@example.test', now(), '{"name":"Legacy"}');

UPDATE public.users SET is_super_admin = TRUE, is_admin = TRUE
    WHERE id = '50000000-0000-4000-8000-000000000001';

-- Read agamy only.
UPDATE public.users SET read_sections = '["agamy"]'::jsonb, write_sections = '[]'::jsonb
    WHERE id = '50000000-0000-4000-8000-000000000002';

-- Read agamy + dekhila, write dekhila only.
UPDATE public.users SET read_sections = '["agamy","dekhila"]'::jsonb, write_sections = '["dekhila"]'::jsonb
    WHERE id = '50000000-0000-4000-8000-000000000003';

-- Write only: the write grant must imply read.
UPDATE public.users SET read_sections = '[]'::jsonb, write_sections = '["dekhila"]'::jsonb
    WHERE id = '50000000-0000-4000-8000-000000000004';

-- Legacy shape: no arrays, one primary section. Built by a pre-refactor row.
UPDATE public.users SET is_admin = FALSE, section = 'agamy',
    read_sections = '[]'::jsonb, write_sections = '[]'::jsonb
    WHERE id = '50000000-0000-4000-8000-000000000005';

INSERT INTO public.patients (name, national_id, section) VALUES
    ('Agamy patient', '29001011234561', 'agamy'),
    ('Dekhila patient', '29001011234562', 'dekhila');

-- -------------------------------------------------------------- as reader --
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000002"}';

SELECT public.rls_assert(public.can_read_section('agamy'), 'reader may read the granted section');
SELECT public.rls_assert(NOT public.can_read_section('dekhila'), 'reader may not read an ungranted section');
SELECT public.rls_assert(NOT public.can_write_section('agamy'), 'read grant alone is not a write grant');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.patients), 1::bigint,
    'reader sees only the granted section');
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.patients SET problem = 'x' WHERE section = 'agamy'$q$),
    0::bigint, 'reader cannot edit a read-only section');
SELECT public.rls_assert_error(
    $q$INSERT INTO public.patients (name, section) VALUES ('nope', 'agamy')$q$,
    '42501', 'reader cannot insert into a read-only section');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.users), 1::bigint,
    'staff sees only their own profile row');
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.users SET name = 'Hacked' WHERE id = '50000000-0000-4000-8000-000000000002'$q$),
    0::bigint, 'staff cannot edit even their own profile row');

-- -------------------------------------------------------------- as writer --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000003"}';

SELECT public.rls_assert(public.can_read_section('agamy'), 'writer may read the read-only section');
SELECT public.rls_assert(public.can_write_section('dekhila'), 'writer may write the granted section');
SELECT public.rls_assert(NOT public.can_write_section('agamy'), 'writer may not write a read-only section');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.patients), 2::bigint,
    'writer sees both granted sections');
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.patients SET problem = 'seen' WHERE section = 'dekhila'$q$),
    1::bigint, 'writer may edit the writable section');
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.patients SET problem = 'nope' WHERE section = 'agamy'$q$),
    0::bigint, 'writer cannot edit the read-only section');
SELECT public.rls_assert_error(
    $q$INSERT INTO public.patients (name, national_id, section) VALUES ('Writer patient', '29001011234569', 'agamy')$q$,
    '42501', 'writer cannot insert into a read-only section');
SELECT public.rls_assert_eq(
    public.rls_exec($q$INSERT INTO public.patients (name, national_id, section) VALUES ('Writer patient', '29001011234569', 'dekhila')$q$),
    1::bigint, 'writer may insert into the writable section');

-- ----------------------------------------------------------- as write-only --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000004"}';

SELECT public.rls_assert(public.can_read_section('dekhila'), 'write implies read');
SELECT public.rls_assert(NOT public.can_read_section('agamy'), 'write on one section grants nothing on another');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.patients), 2::bigint,
    'write-only staff still see the section they may edit (the two dekhila rows)');

-- --------------------------------------------------------------- as legacy --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000005"}';

SELECT public.rls_assert(public.can_read_section('agamy'), 'legacy section row keeps read access');
SELECT public.rls_assert(public.can_write_section('agamy'), 'legacy section row keeps write access');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.patients), 1::bigint,
    'legacy section row sees only its own section');

-- ----------------------------------------------------------- as super admin --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000001"}';

SELECT public.rls_assert(public.can_read_section('agamy') AND public.can_read_section('dekhila'),
    'super admin reads every section');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.patients), 3::bigint,
    'super admin sees every patient');
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.patients SET problem = 'all'$q$),
    3::bigint, 'super admin writes every section');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.users), 5::bigint,
    'super admin sees every user');
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.users SET name = 'Renamed' WHERE id = '50000000-0000-4000-8000-000000000002'$q$),
    1::bigint, 'super admin may edit another user');

RESET ROLE;
