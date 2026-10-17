-- Shared helpers for the RLS / DB test scripts (spec section 17.1).
--
-- These scripts are executed two ways:
--   * in CI by tests/rls/db.test.js (PGlite, a real Postgres in WASM), with a
--     Supabase-like prelude: roles, auth.users, auth.uid(), storage.*;
--   * optionally against a hosted project with psql:
--       psql "$SUPABASE_DB_URL" --set ON_ERROR_STOP=1 --no-psqlrc \
--         -f tests/rls/_assert.sql -f tests/rls/01-access.sql -c "ROLLBACK;"
--
-- This file opens the transaction; the script that follows runs inside it and
-- the caller rolls it back, so the scripts never touch persistent data.
-- Run order matters: _assert.sql must come first in the same session.

BEGIN;

CREATE OR REPLACE FUNCTION public.rls_assert(p_cond boolean, p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_cond IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'RLS ASSERT FAILED: %', p_msg;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rls_assert_eq(p_actual anyelement, p_expected anyelement, p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_actual IS DISTINCT FROM p_expected THEN
        RAISE EXCEPTION 'RLS ASSERT FAILED: % (expected %, got %)', p_msg, p_expected, p_actual;
    END IF;
END $$;

-- Runs a statement as the current role and reports the affected row count, so
-- scripts can assert RLS-filtered no-ops (UPDATE ... returns 0 rows).
CREATE OR REPLACE FUNCTION public.rls_exec(p_sql text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_rows bigint;
BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END $$;

-- Asserts that the statement fails with a specific SQLSTATE:
--   '42501' insufficient_privilege (permission or RLS violation)
--   '23505' unique_violation
--   '23514' check_violation (the import_rows guard trigger)
CREATE OR REPLACE FUNCTION public.rls_assert_error(p_sql text, p_sqlstate text, p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = p_sqlstate THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'RLS ASSERT FAILED: % (expected SQLSTATE %, got %: %)',
            p_msg, p_sqlstate, SQLSTATE, SQLERRM;
    END;
    RAISE EXCEPTION 'RLS ASSERT FAILED: % (statement succeeded)', p_msg;
END $$;
