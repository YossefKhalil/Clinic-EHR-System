-- The pump's claim step (spec §9.5): parallel limit, index order, lease
-- expiry reclaim, attempts cap, job scoping. Runs as service_role, exactly
-- like the import-job function does. Rolled back by the caller.
--
-- Fixed ids: job c1000000-…-01 (8 chunks) and c1000000-…-02 (1 chunk);
-- chunks e1000000-…-01 … -09.

INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at) VALUES
    ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'claim-owner@example.test', now());

INSERT INTO public.import_jobs (id, created_by, status, config, token_cap, expires_at) VALUES
    ('c1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'extracting', '{}'::jsonb, 1000, now() + interval '7 days'),
    ('c1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'extracting', '{}'::jsonb, 1000, now() + interval '7 days');

-- 0–4 queued, 5 with an expired lease (crashed pump), 6 with an active lease,
-- 7 already at the attempts cap, plus one queued chunk in the other job.
INSERT INTO public.import_chunks (id, job_id, idx, kind, status, attempts, lease_until) VALUES
    ('e1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 0, 'text', 'queued', 0, NULL),
    ('e1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 1, 'text', 'queued', 0, NULL),
    ('e1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 2, 'text', 'queued', 0, NULL),
    ('e1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 3, 'text', 'queued', 0, NULL),
    ('e1000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000001', 4, 'text', 'queued', 0, NULL),
    ('e1000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000001', 5, 'text', 'running', 1, now() - interval '1 second'),
    ('e1000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-000000000001', 6, 'text', 'running', 1, now() + interval '90 seconds'),
    ('e1000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-000000000001', 7, 'text', 'failed', 3, NULL),
    ('e1000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000002', 0, 'text', 'queued', 0, NULL);

SET ROLE service_role;

-- Claim #1: the three lowest queued chunks, in idx order.
SELECT public.rls_assert_eq(
    (SELECT array_agg(idx ORDER BY idx) FROM public.import_claim_chunks('c1000000-0000-4000-8000-000000000001', 3, 90, 3)),
    ARRAY[0, 1, 2],
    'first claim takes the lowest three queued chunks');
SELECT public.rls_assert(
    (SELECT status = 'running' AND lease_until > now() AND attempts = 1
       FROM public.import_chunks WHERE id = 'e1000000-0000-4000-8000-000000000001'),
    'a claimed chunk is running, holds a fresh lease, and counts one attempt');

-- Claim #2: the next queued pair plus the expired lease (idx 5).
SELECT public.rls_assert_eq(
    (SELECT array_agg(idx ORDER BY idx) FROM public.import_claim_chunks('c1000000-0000-4000-8000-000000000001', 3, 90, 3)),
    ARRAY[3, 4, 5],
    'second claim takes the next queued chunks and reclaims the expired lease');
SELECT public.rls_assert_eq((SELECT attempts FROM public.import_chunks WHERE id = 'e1000000-0000-4000-8000-000000000006'), 2,
    'a reclaimed chunk counts a second attempt');

-- Claim #3: nothing left — the active lease and the attempts cap hold.
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_claim_chunks('c1000000-0000-4000-8000-000000000001', 10, 90, 3)),
    0::bigint,
    'active leases and chunks at the attempts cap are not claimable');
SELECT public.rls_assert_eq((SELECT status FROM public.import_chunks WHERE id = 'e1000000-0000-4000-8000-000000000007'), 'running',
    'the actively leased chunk was never touched');
SELECT public.rls_assert_eq((SELECT status FROM public.import_chunks WHERE id = 'e1000000-0000-4000-8000-000000000009'), 'queued',
    'claims are scoped to the requested job');

-- A crashed chunk (lease expired) is reclaimed until the attempts cap.
UPDATE public.import_chunks SET lease_until = now() - interval '1 second'
 WHERE id = 'e1000000-0000-4000-8000-000000000001';
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_claim_chunks('c1000000-0000-4000-8000-000000000001', 3, 90, 3)),
    1::bigint, 'an expired lease is reclaimable again');
SELECT public.rls_assert_eq((SELECT attempts FROM public.import_chunks WHERE id = 'e1000000-0000-4000-8000-000000000001'), 2,
    'the reclaim counts a second attempt');

UPDATE public.import_chunks SET lease_until = now() - interval '1 second'
 WHERE id = 'e1000000-0000-4000-8000-000000000001';
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_claim_chunks('c1000000-0000-4000-8000-000000000001', 3, 90, 3)),
    1::bigint, 'the reclaim continues up to the attempts cap');
SELECT public.rls_assert_eq((SELECT attempts FROM public.import_chunks WHERE id = 'e1000000-0000-4000-8000-000000000001'), 3,
    'the chunk is now at the attempts cap');

UPDATE public.import_chunks SET lease_until = now() - interval '1 second'
 WHERE id = 'e1000000-0000-4000-8000-000000000001';
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_claim_chunks('c1000000-0000-4000-8000-000000000001', 3, 90, 3)),
    0::bigint, 'a chunk at the attempts cap is left for retry_chunk');

-- Limits are honoured: a zero limit claims nothing; the other job is intact.
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_claim_chunks('c1000000-0000-4000-8000-000000000002', 0, 90, 3)),
    0::bigint, 'a zero limit claims nothing');
SELECT public.rls_assert_eq(
    (SELECT array_agg(idx ORDER BY idx) FROM public.import_claim_chunks('c1000000-0000-4000-8000-000000000002', 3, 90, 3)),
    ARRAY[0], 'the other job''s queued chunk is claimable');
SELECT public.rls_assert_eq(
    (SELECT count(*) FROM public.import_claim_chunks('c1000000-0000-4000-8000-000000000002', 3, 90, 3)),
    0::bigint, 'a freshly claimed chunk is not claimed twice');

RESET ROLE;
