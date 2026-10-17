-- Integrity: idempotent chunk delivery (§9.5), the review-edit guard (§9.4),
-- optimistic concurrency (§9.6), unique commit keys, retention (§9.7) and the
-- schema-level pieces M2 adds. Rolled back by the caller.
--
-- Fixed ids: user a3000000-…-01; job c3000000-…-01 (etc.); chunk e3000000-…-01.

INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at) VALUES
    ('a3000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'integrity-owner@example.test', now());

INSERT INTO public.import_jobs (id, created_by, status, config, token_cap, expires_at) VALUES
    ('c3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'extracting', '{}'::jsonb, 1000, now() + interval '7 days');

INSERT INTO public.import_chunks (id, job_id, idx, kind, status) VALUES
    ('e3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 0, 'text', 'done');

-- ------------------------------------------- idempotent chunk delivery --
-- The pump writes rows with ON CONFLICT (chunk_id, seq) DO NOTHING, so a
-- duplicate delivery (retry after a timeout) changes nothing.
INSERT INTO public.import_rows (job_id, chunk_id, seq, extracted, cells) VALUES
    ('c3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 1, '{"first": true}'::jsonb, '{}'::jsonb)
ON CONFLICT (chunk_id, seq) DO NOTHING;
INSERT INTO public.import_rows (job_id, chunk_id, seq, extracted, cells) VALUES
    ('c3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 1, '{"second": true}'::jsonb, '{}'::jsonb)
ON CONFLICT (chunk_id, seq) DO NOTHING;
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_rows WHERE chunk_id = 'e3000000-0000-4000-8000-000000000001'),
    1::bigint, 'duplicate chunk delivery does not duplicate rows');
SELECT public.rls_assert_eq(
    (SELECT extracted FROM public.import_rows WHERE chunk_id = 'e3000000-0000-4000-8000-000000000001'),
    '{"first": true}'::jsonb, 'the first delivery wins');
SELECT public.rls_assert_error($q$INSERT INTO public.import_rows (job_id, chunk_id, seq, extracted, cells) VALUES ('c3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 1, '{}'::jsonb, '{}'::jsonb)$q$,
    '23505', 'without ON CONFLICT a duplicate (chunk_id, seq) is rejected');

-- ------------------------------------------------- review-edit guard --
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"a3000000-0000-4000-8000-000000000001"}';

SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.import_rows SET cells = '{"name":{"value":"Y"}}'::jsonb, acknowledged = '["a1"]'::jsonb, issues = '[]'::jsonb, status = 'ready', version = version + 1 WHERE chunk_id = 'e3000000-0000-4000-8000-000000000001'$q$),
    1::bigint, 'owner edits the review fields');
SELECT public.rls_assert_error($q$UPDATE public.import_rows SET extracted = '{"tampered": true}'::jsonb, version = version + 1 WHERE chunk_id = 'e3000000-0000-4000-8000-000000000001'$q$,
    '23514', 'extracted is immutable to the owner');
SELECT public.rls_assert_error($q$UPDATE public.import_rows SET src = '["S1:L001"]'::jsonb, version = version + 1 WHERE chunk_id = 'e3000000-0000-4000-8000-000000000001'$q$,
    '23514', 'src citations are immutable to the owner');
SELECT public.rls_assert_error($q$UPDATE public.import_rows SET commit_result = '{"result":"created"}'::jsonb, version = version + 1 WHERE chunk_id = 'e3000000-0000-4000-8000-000000000001'$q$,
    '23514', 'commit results are immutable to the owner');
-- Optimistic concurrency: every client edit must carry version + 1.
SELECT public.rls_assert_error($q$UPDATE public.import_rows SET cells = '{}'::jsonb WHERE chunk_id = 'e3000000-0000-4000-8000-000000000001'$q$,
    '23514', 'an edit without a version bump is rejected');
SELECT public.rls_assert_error($q$UPDATE public.import_rows SET cells = '{}'::jsonb, version = version + 2 WHERE chunk_id = 'e3000000-0000-4000-8000-000000000001'$q$,
    '23514', 'a version jump is rejected');
RESET ROLE;

-- The updated_at trigger maintains the timestamp on edits.
INSERT INTO public.import_rows (job_id, seq, extracted, cells, updated_at) VALUES
    ('c3000000-0000-4000-8000-000000000001', 2, '{}'::jsonb, '{}'::jsonb, now() - interval '1 day');

SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"a3000000-0000-4000-8000-000000000001"}';
SELECT public.rls_assert_eq(
    public.rls_exec($q$UPDATE public.import_rows SET cells = '{"b": 2}'::jsonb, version = version + 1 WHERE seq = 2$q$),
    1::bigint, 'owner edits the second row');
RESET ROLE;
SELECT public.rls_assert(
    (SELECT updated_at > now() - interval '1 hour' FROM public.import_rows WHERE seq = 2),
    'the rows trigger maintains updated_at');

-- ------------------------------------------------- commit key --
INSERT INTO public.import_jobs (id, created_by, status, config, token_cap, expires_at, commit_key) VALUES
    ('c3000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000001', 'review', '{}'::jsonb, 1000, now() + interval '7 days', '5e000000-0000-4000-8000-000000000001');
SELECT public.rls_assert_error($q$INSERT INTO public.import_jobs (created_by, status, config, token_cap, expires_at, commit_key) VALUES ('a3000000-0000-4000-8000-000000000001', 'review', '{}'::jsonb, 1000, now() + interval '7 days', '5e000000-0000-4000-8000-000000000001')$q$,
    '23505', 'a reused commit_key is rejected (idempotent commits)');
INSERT INTO public.import_jobs (id, created_by, status, config, token_cap, expires_at, commit_key) VALUES
    ('c3000000-0000-4000-8000-000000000004', 'a3000000-0000-4000-8000-000000000001', 'review', '{}'::jsonb, 1000, now() + interval '7 days', NULL),
    ('c3000000-0000-4000-8000-000000000005', 'a3000000-0000-4000-8000-000000000001', 'review', '{}'::jsonb, 1000, now() + interval '7 days', NULL);
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_jobs
      WHERE commit_key IS NULL AND id IN ('c3000000-0000-4000-8000-000000000004', 'c3000000-0000-4000-8000-000000000005')),
    2::bigint, 'jobs without a commit key coexist');

-- ------------------------------------------------- retention --
-- An old done job, an old cancelled job, and old rows of a still-open job:
-- only finished jobs lose their payloads (spec §9.7).
INSERT INTO public.import_jobs (id, created_by, status, config, token_cap, expires_at, created_at, updated_at) VALUES
    ('c3000000-0000-4000-8000-000000000006', 'a3000000-0000-4000-8000-000000000001', 'done', '{}'::jsonb, 1000, now() - interval '30 days', now() - interval '40 days', now() - interval '40 days'),
    ('c3000000-0000-4000-8000-000000000007', 'a3000000-0000-4000-8000-000000000001', 'review', '{}'::jsonb, 1000, now() + interval '7 days', now() - interval '40 days', now() - interval '40 days');
INSERT INTO public.import_rows (job_id, seq, extracted, cells) VALUES
    ('c3000000-0000-4000-8000-000000000006', 1, '{"p": 1}'::jsonb, '{"name": {"value": "old"}}'::jsonb),
    ('c3000000-0000-4000-8000-000000000007', 1, '{"p": 2}'::jsonb, '{"name": {"value": "open"}}'::jsonb);

INSERT INTO public.import_batches (id, job_id, committed_by, committed_at, counts) VALUES
    ('ba300000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000006', 'a3000000-0000-4000-8000-000000000001', now() - interval '100 days', '{"created": 1}'::jsonb),
    ('ba300000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000007', 'a3000000-0000-4000-8000-000000000001', now() - interval '1 day', '{"created": 1}'::jsonb);
INSERT INTO public.import_batch_items (batch_id, patient_id, action, before, after) VALUES
    ('ba300000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'created', '{"x": 1}'::jsonb, '{"x": 2}'::jsonb),
    ('ba300000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000002', 'created', '{"y": 1}'::jsonb, '{"y": 2}'::jsonb);

SET ROLE service_role;
SELECT public.rls_assert_eq(
    (SELECT (public.import_run_retention() ->> 'rows_cleared')::int),
    1, 'retention clears exactly the payloads of finished jobs');
RESET ROLE;

SELECT public.rls_assert(
    (SELECT extracted IS NULL AND cells IS NULL FROM public.import_rows WHERE job_id = 'c3000000-0000-4000-8000-000000000006'),
    'the finished job''s row payloads are gone');
SELECT public.rls_assert(
    (SELECT extracted IS NOT NULL AND cells IS NOT NULL FROM public.import_rows WHERE job_id = 'c3000000-0000-4000-8000-000000000007'),
    'a still-open job keeps its rows untouched');
SELECT public.rls_assert(
    (SELECT before IS NULL AND after IS NULL FROM public.import_batch_items WHERE batch_id = 'ba300000-0000-4000-8000-000000000001'),
    'old batch payloads are cleared');
SELECT public.rls_assert(
    (SELECT before IS NOT NULL AND after IS NOT NULL FROM public.import_batch_items WHERE batch_id = 'ba300000-0000-4000-8000-000000000002'),
    'recent batch payloads stay for the undo window');
-- Idempotent: a second run clears nothing.
SELECT public.rls_assert_eq(
    (SELECT (public.import_run_retention() ->> 'rows_cleared')::int),
    0, 'retention is idempotent');

-- The cron entry point always runs the SQL retention and tolerates pg_net
-- being absent (it would then only call import-cleanup when configured).
UPDATE public.import_settings SET cleanup_url = 'https://example.test/functions/v1/import-cleanup';
SELECT public.import_daily_maintenance();
SELECT public.rls_assert_eq(
    (SELECT (public.import_run_retention() ->> 'rows_cleared')::int),
    0, 'daily maintenance left nothing to clear');
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"a3000000-0000-4000-8000-000000000001"}';
SELECT public.rls_assert_error($q$SELECT public.import_daily_maintenance()$q$,
    '42501', 'clients cannot run the daily maintenance');
RESET ROLE;

-- ------------------------------------------------- constraints and schema --
SELECT public.rls_assert_eq((SELECT public FROM storage.buckets WHERE id = 'import-staging'), false,
    'the staging bucket exists and is private');
SELECT public.rls_assert(
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'import_batch_id') = 1,
    'patients.import_batch_id exists');
SELECT public.rls_assert(
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'patients' AND indexname = 'idx_patients_import_batch_id') = 1,
    'the import batch id is indexed');
SELECT public.rls_assert_error($q$UPDATE public.import_jobs SET status = 'not-a-status' WHERE id = 'c3000000-0000-4000-8000-000000000003'$q$,
    '23514', 'job status values are constrained');
SELECT public.rls_assert_error($q$UPDATE public.import_rows SET status = 'not-a-status' WHERE seq = 1$q$,
    '23514', 'row status values are constrained');
SELECT public.rls_assert_error($q$INSERT INTO public.import_batch_items (batch_id, patient_id, action) VALUES ('ba300000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000003', 'deleted')$q$,
    '23514', 'batch item actions are constrained');
SELECT public.rls_assert_eq(
    (SELECT cardinality(public.existing_national_ids(ARRAY['00000000000000']))),
    0::int, 'unknown national ids come back empty');
