-- Post-apply verification of supabase/schema.sql.
--
-- The schema is applied by psql with ON_ERROR_STOP, so a failed statement
-- already fails the job. This file catches the other half: a schema that
-- applied "successfully" but is missing the objects the Edge Functions and
-- the review screen read on every request (a column that was added to the
-- file but not to the database, a function that was not created, a trigger
-- that did not survive).
--
-- Run with:  psql "$SUPABASE_DB_URL" --set ON_ERROR_STOP=1 --no-psqlrc -f supabase/verify-schema.sql

DO $verify$
DECLARE
    missing text;
BEGIN
    -- 1. The tables the import system needs.
    SELECT string_agg(name, ', ') INTO missing
    FROM (VALUES
        ('public.patients'),
        ('public.import_jobs'),
        ('public.import_sources'),
        ('public.import_chunks'),
        ('public.import_rows'),
        ('public.import_rejects'),
        ('public.import_batches'),
        ('public.import_batch_items'),
        ('public.ai_settings')
    ) AS t(name)
    WHERE to_regclass(name) IS NULL;
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'missing tables: %', missing;
    END IF;

    -- 2. The encrypted provider credentials and the model chain.
    SELECT string_agg(expected.column_name, ', ') INTO missing
    FROM (VALUES
        ('provider'), ('model'), ('model_chain'),
        ('openrouter_key_encrypted'), ('cloudflare_account_id'),
        ('cloudflare_token_encrypted'), ('openai_base_url'),
        ('openai_key_encrypted'), ('groq_key_encrypted'),
        -- The local engine: which engine runs, the cloud consent record and
        -- the local profile and config.
        ('inference_mode'), ('cloud_consent'), ('cloud_consent_at'),
        ('local_profile'), ('local_config')
    ) AS expected(column_name)
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = 'ai_settings'
          AND c.column_name = expected.column_name
    );
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'ai_settings is missing columns: %', missing;
    END IF;

    -- 3. The review-edit guard: without it the browser could rewrite the
    --    extracted data of a row.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guard_import_row_update_trigger') THEN
        RAISE EXCEPTION 'the import_rows guard trigger is missing';
    END IF;

    -- 4. The claim function: without it the pump cannot take a chunk.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'import_claim_chunks'
    ) THEN
        RAISE EXCEPTION 'import_claim_chunks is missing';
    END IF;

    -- 5. The review load needs this index (a job's rows ordered by seq).
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_import_rows_job_seq'
    ) THEN
        RAISE EXCEPTION 'idx_import_rows_job_seq is missing';
    END IF;

    RAISE NOTICE 'schema verification passed';
END
$verify$;
