-- RLS access matrix: two section users plus an admin (spec §9.4, §17.1).
-- Runs inside the transaction opened by _assert.sql; rolled back afterwards.
--
-- Fixed ids:
--   admin ad000000-…-01 | agamy a0000000-…-01 | dekhila b0000000-…-01
--   agamy job c0000000-…-01 | dekhila job c0000000-…-02

-- ---------------------------------------------------------------- fixtures --
INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at) VALUES
    ('ad000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-admin@example.test', now()),
    ('a0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-agamy@example.test', now()),
    ('b0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-dekhila@example.test', now());

UPDATE public.users SET is_admin = TRUE WHERE id = 'ad000000-0000-4000-8000-000000000001';
UPDATE public.users SET is_admin = FALSE, section = 'agamy' WHERE id = 'a0000000-0000-4000-8000-000000000001';
UPDATE public.users SET is_admin = FALSE, section = 'dekhila' WHERE id = 'b0000000-0000-4000-8000-000000000001';

INSERT INTO public.import_jobs (id, created_by, status, config, token_cap, expires_at) VALUES
    ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'review', '{}'::jsonb, 100000, now() + interval '7 days'),
    ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'review', '{}'::jsonb, 100000, now() + interval '7 days');

INSERT INTO public.import_sources (id, job_id, idx, kind, name) VALUES
    ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 0, 'text', 'agamy.txt'),
    ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 0, 'text', 'dekhila.txt');

INSERT INTO public.import_chunks (id, job_id, source_id, idx, kind, status) VALUES
    ('e0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 0, 'text', 'done');

INSERT INTO public.import_rows (id, job_id, chunk_id, seq, extracted, cells) VALUES
    ('f0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 1, '{}'::jsonb, '{}'::jsonb),
    ('f0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', NULL, 1, '{}'::jsonb, '{}'::jsonb);

INSERT INTO public.import_rejects (job_id, reason) VALUES
    ('c0000000-0000-4000-8000-000000000001', 'phantom row');

INSERT INTO public.import_batches (id, job_id, committed_by, counts) VALUES
    ('ba000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', '{"created": 1}'::jsonb);

INSERT INTO public.import_batch_items (batch_id, patient_id, action) VALUES
    ('ba000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 'created');

-- A patient that exists in the other section; the import agent must be able
-- to detect the duplicate without being able to read the row (§8.6).
INSERT INTO public.patients (name, national_id, section) VALUES
    ('Other section patient', '29901011234567', 'dekhila');

-- A staged object under the dekhila user's prefix, to prove prefix scoping.
INSERT INTO storage.objects (bucket_id, name) VALUES
    ('import-staging', 'b0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000002/dekhila.txt');

-- Admin-only analytics data (no PHI).
INSERT INTO public.audit_log (actor, action, entity, entity_id) VALUES
    ('a0000000-0000-4000-8000-000000000001', 'job.created', 'job', 'c0000000-0000-4000-8000-000000000001');
INSERT INTO public.ai_usage (user_id, job_id, model, tokens_in, tokens_out) VALUES
    ('a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'test-model', 10, 20);

-- ------------------------------------------------------- as the agamy user --
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001"}';

SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_jobs), 1::bigint,
    'agamy user sees exactly their own job');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_jobs WHERE id = 'c0000000-0000-4000-8000-000000000002'), 0::bigint,
    'agamy user cannot see the dekhila job');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_sources), 1::bigint,
    'sources follow job access');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_chunks), 1::bigint,
    'chunks follow job access');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_rows), 1::bigint,
    'rows follow job access');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_rejects), 1::bigint,
    'rejects follow job access');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_batches), 0::bigint,
    'batches of other users stay hidden');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_batch_items), 0::bigint,
    'batch items of other users stay hidden');

-- Review edits: the owner may edit their own row with the version bump.
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.import_rows SET cells = '{"name":{"value":"X"}}'::jsonb, version = version + 1 WHERE id = 'f0000000-0000-4000-8000-000000000001'$q$),
    1::bigint, 'owner edits own row with a version bump');
-- Cross-job edits are invisible to the policy: zero rows updated.
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.import_rows SET cells = '{}'::jsonb, version = version + 1 WHERE id = 'f0000000-0000-4000-8000-000000000002'$q$),
    0::bigint, 'owner cannot edit another job''s row');

-- The client never writes job state or extraction artefacts.
SELECT public.rls_assert_error($q$INSERT INTO public.import_jobs (created_by, config, token_cap, expires_at) VALUES ('a0000000-0000-4000-8000-000000000001', '{}'::jsonb, 1, now() + interval '1 day')$q$,
    '42501', 'clients cannot create jobs');
SELECT public.rls_assert_error($q$INSERT INTO public.import_rows (job_id, seq, extracted, cells) VALUES ('c0000000-0000-4000-8000-000000000001', 9, '{}'::jsonb, '{}'::jsonb)$q$,
    '42501', 'clients cannot insert rows');
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.import_jobs SET status = 'done' WHERE id = 'c0000000-0000-4000-8000-000000000001'$q$),
    0::bigint, 'clients cannot advance jobs');
SELECT public.rls_assert_eq(
    public.rls_exec($q$DELETE FROM public.import_rows WHERE id = 'f0000000-0000-4000-8000-000000000001'$q$),
    0::bigint, 'clients cannot delete rows');
SELECT public.rls_assert_error($q$SELECT * FROM public.import_claim_chunks('c0000000-0000-4000-8000-000000000001', 3, 90, 3)$q$,
    '42501', 'clients cannot claim chunks');
SELECT public.rls_assert_error($q$SELECT * FROM public.import_run_retention()$q$,
    '42501', 'clients cannot run retention');
SELECT public.rls_assert_error($q$SELECT * FROM public.import_settings$q$,
    '42501', 'import_settings stays off the client API');
SELECT public.rls_assert_error($q$SELECT * FROM public.ai_settings$q$,
    '42501', 'ai_settings (encrypted keys) stays off the client API');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.audit_log), 0::bigint,
    'section staff see no audit rows');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.ai_usage), 0::bigint,
    'section staff see no usage rows');

-- Cross-section duplicate detection still answers (invariant of §8.6).
SELECT public.rls_assert_eq((SELECT count(*) FROM public.patients), 0::bigint,
    'agamy staff cannot read the dekhila patient');
SELECT public.rls_assert_eq((SELECT cardinality(public.existing_national_ids(ARRAY['29901011234567', '29901019999999']))), 1::int,
    'existence RPC answers across sections without exposing rows');
SELECT public.rls_assert_eq((SELECT cardinality(public.existing_national_ids(ARRAY['29901011234567', '29901011234567']))), 1::int,
    'existence RPC returns distinct ids');

-- Staging storage: the owner uploads and reads only under their own prefix.
SELECT public.rls_assert_eq((SELECT count(*) FROM storage.objects WHERE bucket_id = 'import-staging'), 0::bigint,
    'staged objects of other users stay hidden');
SELECT public.rls_assert_eq(
    public.rls_exec($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('import-staging', 'a0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/0-notes.txt')$q$),
    1::bigint, 'owner may upload under their own prefix');
SELECT public.rls_assert_eq((SELECT count(*) FROM storage.objects WHERE bucket_id = 'import-staging'), 1::bigint,
    'owner sees their staged file');
SELECT public.rls_assert_error($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('import-staging', 'b0000000-0000-4000-8000-000000000001/x/y.txt')$q$,
    '42501', 'uploads under another prefix are rejected');
-- Nothing public: catch-all on the whole table.
SELECT public.rls_assert_eq((SELECT count(*) FROM storage.objects), 1::bigint,
    'storage policy is bucket-scoped');

-- ----------------------------------------------------- as the dekhila user --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-000000000001"}';

SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_jobs), 1::bigint,
    'dekhila user sees exactly their own job');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_rows), 1::bigint,
    'dekhila user sees their own row');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_batches), 1::bigint,
    'the committer sees their own batch');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_batch_items), 1::bigint,
    'the committer sees their own batch items');
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.import_rows SET cells = '{}'::jsonb, version = version + 1 WHERE id = 'f0000000-0000-4000-8000-000000000001'$q$),
    0::bigint, 'dekhila user cannot edit the agamy row');

-- ------------------------------------------------------------- as an admin --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"ad000000-0000-4000-8000-000000000001"}';

SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_jobs), 2::bigint,
    'admin sees every job');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_sources), 2::bigint,
    'admin sees every source');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_rows), 2::bigint,
    'admin sees every row');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_rejects), 1::bigint,
    'admin sees every reject');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.import_batches), 1::bigint,
    'admin sees every batch');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.audit_log), 1::bigint,
    'admin reads the audit log');
SELECT public.rls_assert_eq((SELECT count(*) FROM public.ai_usage), 1::bigint,
    'admin reads usage accounting');

-- Admins observe everything but still edit nothing directly: row edits stay
-- owner-only, and settings/keys stay off the API entirely.
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.import_rows SET cells = '{}'::jsonb, version = version + 1 WHERE id = 'f0000000-0000-4000-8000-000000000001'$q$),
    0::bigint, 'admin cannot edit another user''s row cells');
SELECT public.rls_assert_error($q$SELECT * FROM public.import_settings$q$,
    '42501', 'even admins read import settings through functions only');
SELECT public.rls_assert_error($q$SELECT * FROM public.ai_settings$q$,
    '42501', 'even admins read ai_settings through functions only');

RESET ROLE;
