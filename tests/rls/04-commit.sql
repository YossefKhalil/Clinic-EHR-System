-- The commit (spec §11): the reviewed rows become patients.
--
-- Fixed ids: owner a4000000-0000-4000-8000-000000000001; job
-- c4000000-0000-4000-8000-000000000001; chunk e4000000-0000-4000-8000-000000000001;
-- rows 14000000-0000-4000-8000-00000000000{1..4}; commit key
-- d4000000-0000-4000-8000-000000000001.

-- The profile row is created by the signup trigger, like in production.
INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data) VALUES
    ('a4000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'commit-owner@example.test', now(), '{"name":"Commit Owner"}'::jsonb);

INSERT INTO public.import_jobs (id, created_by, status, config, token_cap, expires_at) VALUES
    ('c4000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'review', '{}'::jsonb, 1000, now() + interval '7 days');

INSERT INTO public.import_chunks (id, job_id, idx, kind, status) VALUES
    ('e4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 0, 'text', 'done');

-- Four reviewed rows: one to create, one to fill, one skipped, one removed.
INSERT INTO public.import_rows (id, job_id, chunk_id, seq, extracted, cells, status) VALUES
    ('14000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 1, '{"name":"Fatma"}'::jsonb, '{"name":{"value":"Fatma Ibrahim Ali","origin":"extracted"},"national_id":{"value":"28811220501187","origin":"extracted"},"mobile":{"value":"01012345678","origin":"extracted"},"section":{"value":"agamy","origin":"extracted"},"notes":{"value":["allergic to penicillin"],"origin":"extracted"}}'::jsonb, 'ready'),
    ('14000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 2, '{"name":"Mona"}'::jsonb, '{"name":{"value":"Mona Mahmoud","origin":"extracted"},"national_id":{"value":"29104011204567","origin":"extracted"}}'::jsonb, 'ready'),
    ('14000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 3, '{"name":"Skipped"}'::jsonb, '{"name":{"value":"Skipped Row","origin":"extracted"},"national_id":{"value":"29000000000000","origin":"extracted"}}'::jsonb, 'ready'),
    ('14000000-0000-4000-8000-000000000004', 'c4000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 4, '{"name":"Removed"}'::jsonb, '{"name":{"value":"Removed Row","origin":"extracted"},"national_id":{"value":"28000000000000","origin":"extracted"}}'::jsonb, 'ready');

-- A patient that already exists: the "fill" row updates it.
INSERT INTO public.patients (id, name, national_id, mobile, section) VALUES
    ('f4000000-0000-4000-8000-000000000001', 'Existing Mona', '29104011204567', '01000000000', 'agamy');

-- The plan the Edge Function hands over (the browser never sends this).
SELECT public.import_commit(
    'c4000000-0000-4000-8000-000000000001',
    'd4000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001',
    '[
        {"row_id":"14000000-0000-4000-8000-000000000001","action":"create","values":{"name":"Fatma Ibrahim Ali","national_id":"28811220501187","mobile":"01012345678","section":"agamy","notes":["allergic to penicillin"]}},
        {"row_id":"14000000-0000-4000-8000-000000000002","action":"fill","target_national_id":"29104011204567","fill":{"address":"Agamy, Alexandria","mobile":"01099999999"}},
        {"row_id":"14000000-0000-4000-8000-000000000003","action":"skip","code":"DUPLICATE"},
        {"row_id":"14000000-0000-4000-8000-000000000004","action":"skip","code":"REMOVED"}
    ]'::jsonb,
    '{}'::jsonb
);

-- --------------------------------------------- what the commit wrote --

SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.patients WHERE national_id = '28811220501187'),
    1::bigint, 'the created row is a patient now');
SELECT public.rls_assert_eq(
    (SELECT name FROM public.patients WHERE national_id = '28811220501187'),
    'Fatma Ibrahim Ali', 'the created patient carries the reviewed name');
SELECT public.rls_assert_eq(
    (SELECT notes FROM public.patients WHERE national_id = '28811220501187'),
    '["allergic to penicillin"]'::jsonb, 'the notes are a list');
SELECT public.rls_assert_eq(
    (SELECT registered_by_name FROM public.patients WHERE national_id = '28811220501187'),
    'Commit Owner', 'the registrar is recorded');
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.patients WHERE national_id = '29000000000000'),
    0::bigint, 'a skipped row writes no patient');
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.patients WHERE national_id = '28000000000000'),
    0::bigint, 'a removed row writes no patient');

-- The fill only fills the empty columns.
SELECT public.rls_assert_eq(
    (SELECT address FROM public.patients WHERE national_id = '29104011204567'),
    'Agamy, Alexandria', 'the fill wrote the empty column');
SELECT public.rls_assert_eq(
    (SELECT mobile FROM public.patients WHERE national_id = '29104011204567'),
    '01000000000', 'the fill keeps the value that was already there');
SELECT public.rls_assert_eq(
    (SELECT name FROM public.patients WHERE national_id = '29104011204567'),
    'Existing Mona', 'the fill never overwrites the name');

-- The audit trail: a batch with one item per write.
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_batches WHERE job_id = 'c4000000-0000-4000-8000-000000000001'),
    1::bigint, 'the commit wrote a batch');
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_batch_items WHERE batch_id = (SELECT batch_id FROM public.import_jobs WHERE id = 'c4000000-0000-4000-8000-000000000001')),
    2::bigint, 'the batch holds one item per write');
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_batch_items WHERE action = 'created'),
    1::bigint, 'one patient was created');
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_batch_items WHERE action = 'filled'),
    1::bigint, 'one patient was filled');
SELECT public.rls_assert(
    (SELECT before IS NOT NULL FROM public.import_batch_items WHERE action = 'filled'),
    'the filled item keeps the values from before');

-- The rows know what happened to them.
SELECT public.rls_assert_eq(
    (SELECT commit_result ->> 'result' FROM public.import_rows WHERE id = '14000000-0000-4000-8000-000000000001'),
    'created', 'the created row says so');
SELECT public.rls_assert_eq(
    (SELECT commit_result ->> 'result' FROM public.import_rows WHERE id = '14000000-0000-4000-8000-000000000002'),
    'filled', 'the filled row says so');
SELECT public.rls_assert_eq(
    (SELECT commit_result ->> 'code' FROM public.import_rows WHERE id = '14000000-0000-4000-8000-000000000003'),
    'DUPLICATE', 'the skipped row keeps its reason');

-- The job is done and remembers the key.
SELECT public.rls_assert_eq(
    (SELECT status FROM public.import_jobs WHERE id = 'c4000000-0000-4000-8000-000000000001'),
    'done', 'the job is done');
SELECT public.rls_assert_eq(
    (SELECT commit_key FROM public.import_jobs WHERE id = 'c4000000-0000-4000-8000-000000000001'),
    'd4000000-0000-4000-8000-000000000001'::uuid, 'the commit key is stored');

-- --------------------------------------------- the same key twice --

SELECT public.rls_assert(
    (public.import_commit(
        'c4000000-0000-4000-8000-000000000001',
        'd4000000-0000-4000-8000-000000000001',
        'a4000000-0000-4000-8000-000000000001',
        '[]'::jsonb, '{}'::jsonb) ->> 'idempotent') = 'true',
    'the same commit key is a no-op');
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.patients WHERE national_id = '28811220501187'),
    1::bigint, 'the retry did not create a second patient');

-- --------------------------------------------- nobody else can commit --

SELECT public.rls_assert_error(
    $q$SELECT public.import_commit('c4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000002','a4000000-0000-4000-8000-000000000009','[]'::jsonb,'{}'::jsonb)$q$,
    '42501', 'another account cannot commit this import');
