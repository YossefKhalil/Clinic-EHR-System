# M2 — Persistence

| | |
|---|---|
| **Status** | Complete — schema, RLS, claim, storage, cleanup and cron are in |
| **Spec** | §9 (job model and persistence), §9.4 (RLS), §9.5 (pump claim), §9.7 (retention), §14.4 (settings) |
| **Exit criteria** | Two-section plus admin RLS tests pass; lease reclaim and idempotent insert tested — both enforced by `npm test` (see below) |

This milestone turns the design's server-owned job state into real database objects. All of it is
appended to `supabase/schema.sql` and stays idempotent like the rest of the file.

## 1. What was added

### Tables (spec §9.3)

| Table | Notes |
|---|---|
| `import_jobs` | state machine statuses with a CHECK; `token_cap`/`expires_at` have **no SQL defaults** — the import-job function sets them from `limits.js`, so every tunable lives once |
| `import_sources` | `unique (job_id, idx)`; `storage_path` uses the convention `<user-id>/<job-id>/<idx>-<name>` in `import-staging` |
| `import_chunks` | pump columns (`attempts`, `lease_until`, `status`); `unique (job_id, idx)` |
| `import_rows` | `unique (chunk_id, seq)` makes duplicate chunk delivery a no-op; `version` powers optimistic concurrency |
| `import_rejects` | the tray (invariant I8); has a `created_at` for stable ordering (not in §9.3) |
| `import_batches`, `import_batch_items` | commit bookkeeping for M6/M7; batch id is also stamped on `patients.import_batch_id` |
| `ai_usage`, `audit_log` | ids, counts, tokens, cost only — no PHI; admins read, functions write |

### Recreated from v1 (the M0 findings doc)

- `ai_settings` (single row, encrypted keys, `enabled` is the `import_agent_enabled` flag) with its
  `REVOKE` off the PostgREST surface. The key store now uses the dedicated
  `AI_SETTINGS_ENC_KEY` secret (§13.6) instead of one derived from the service-role key.
- `patients.import_batch_id` + index.
- `existing_national_ids(text[])` — cross-section duplicate detection (§8.6).

### Settings row

`import_settings` (single row): `limits` jsonb for `limits.js` overrides, and `cleanup_url` /
`cleanup_secret` for the pg_cron → `import-cleanup` call. Like `ai_settings` it is revoked from the
client API entirely.

### Row-level security (spec §9.4)

Access helpers follow the `is_admin()` pattern (`SECURITY DEFINER`, so a policy never re-reads
`import_jobs` under the caller's own RLS):

| Table | Read | Client write |
|---|---|---|
| `import_jobs` | owner, admins | none |
| `import_sources`, `import_chunks`, `import_rejects` | owner, admins | none |
| `import_rows` | owner, admins | **owner only** — review fields, with the version bump (guard trigger) |
| `import_batches`, `import_batch_items` | committer, admins | none |
| `ai_usage`, `audit_log` | admins | none |

The `import_rows` guard trigger limits client updates to `cells, issues, acknowledged, dup,
removed, status, version` and requires `version = version + 1`. Provenance (`src`, `extracted`,
`commit_result`, identity columns) is immutable from PostgREST; service-role code and direct SQL
are unaffected. `status` is included because it is derived from the same review fields the owner
may change, and the commit path re-validates every row server-side (spec §11.2).

### Claim function (`import_claim_chunks`)

The §9.5 claim as a service-role-only function: `FOR UPDATE SKIP LOCKED`, lowest `idx` first,
expired leases reclaimable, capped at `p_max_attempts`. All three tunables (`p_limit`,
`p_lease_seconds`, `p_max_attempts`) are arguments — the pump passes resolved `limits.js` values,
so no limit exists twice in SQL.

### Retention (spec §9.7)

- `import_run_retention(p_row_days default 30, p_batch_days default 90)` — pure SQL: nulls
  `import_rows.extracted`/`cells` and `import_batch_items.before`/`after`. The defaults mirror
  `limits.js` (`ROW_RETENTION_DAYS`, `BATCH_PAYLOAD_RETENTION_DAYS`) only for the cron path; the
  Edge Function passes resolved values explicitly. This is a conscious exception to "tunables live
  once": pg_cron must be able to run retention without any JavaScript.
- `import_daily_maintenance()` — runs the SQL retention, then calls the `import-cleanup` Edge
  Function when `import_settings.cleanup_url` is set and `pg_net` is available (dynamic SQL, so
  the function still creates on projects without pg_net).
- pg_cron job `import-daily-maintenance` at 03:15 daily, scheduled only when the extension exists.
  `CREATE EXTENSION pg_cron/pg_net` is attempted and skipped gracefully where unavailable.

### Storage

Private bucket `import-staging`. Owner-only policies (by path prefix) for upload/read:
`split_part(name, '/', 1) = auth.uid()::text`. The functions read and delete with the service
role (RLS bypass). `import-cleanup` deletes files through the Storage API 24 h after a job is
done/cancelled, otherwise at expiry, and nulls the references (`import_sources.storage_path`,
`import_chunks.payload/payload_path/raw_response_path`).

## 2. Deployment checklist

1. **Apply the schema** — normal flow: push to `master`, `Supabase Schema` workflow runs
   `schema.sql`. Verify: `SELECT * FROM public.import_settings;` returns one row.
2. **Enable extensions** if the workflow could not (Dashboard → Database → Extensions):
   `pg_cron`, `pg_net`. Re-run `schema.sql` (or run the `cron.schedule` statement from §1) to
   create the daily job; check with `SELECT * FROM cron.job;`.
3. **Deploy the function** — `Deploy Edge Functions` workflow now deploys `import-cleanup` with
   `--no-verify-jwt` (it authenticates itself, see below).
4. **Set the shared secret** — `supabase secrets set IMPORT_CLEANUP_SECRET=<random>`; then update
   the settings row with the function URL and the same secret:
   ```sql
   UPDATE public.import_settings
      SET cleanup_url = 'https://<project-ref>.functions.supabase.co/import-cleanup',
          cleanup_secret = '<same random value>'
    WHERE id;
   ```
   Without a URL the cron path still runs the SQL retention; storage purge then only happens on
   manual invocation.

`import-cleanup` accepts the `x-cleanup-secret` header (the cron path) or the service-role bearer
token (manual runs); anything else is rejected, and it fails closed when no secret is configured.

## 3. Tests

The exit criteria are enforced by real SQL against real Postgres:

- `tests/rls/db.test.js` (Vitest + PGlite) applies the actual `supabase/schema.sql` — twice, to
  prove idempotency — on a Supabase-like prelude (roles, `auth.users`, `auth.uid()` reading the
  JWT claims, `storage.*`), then runs:
  - `01-access.sql` — the two-sections-plus-admin matrix: read scoping, owner-only row edits,
    no client inserts to job tables, settings/keys off the API even for admins, existence RPC
    across sections, storage prefix scoping.
  - `02-claim.sql` — parallel limit, idx order, expired-lease reclaim, attempts cap, job scoping.
  - `03-integrity.sql` — `ON CONFLICT (chunk_id, seq) DO NOTHING`, the version-bump guard,
    unique commit keys, updated_at triggers, retention incl. idempotence.

Run locally: `npm test` (or `npm run test:db` for this layer only). The same scripts can be run
against a hosted project (they roll themselves back via the transaction opened in `_assert.sql`):

```bash
psql "$SUPABASE_DB_URL" --set ON_ERROR_STOP=1 --no-psqlrc \
  -f tests/rls/_assert.sql -f tests/rls/01-access.sql -c "ROLLBACK;"
```

## 4. Deliberate choices

- `import_rows.cells` and `.extracted` are nullable although §9.3 shows `not null`: §9.7's
  retention sets both to NULL. The pipeline always writes them at extraction time.
- `import_rejects.created_at` extends the §9.3 column list so the tray has a stable order.
- The connection between pg_cron and the Edge Function is one row of `import_settings` (URL +
  secret) rather than hard-coded project coordinates, so the schema stays project-agnostic.
