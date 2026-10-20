// RLS / DB layer (spec §17.1): the sibling *.sql scripts run against a real
// Postgres (PGlite) with a Supabase-like prelude, so the exit criteria of M2
// — "two-section plus admin RLS tests pass; lease reclaim and idempotent
// insert tested" — are enforced by CI, not by inspection.
//
// The same scripts can be executed against a hosted project with psql; see
// docs/import-agent/m2-persistence.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseLikeDb, runRlsScript, SCHEMA_PATH } from './harness.js';

const VERIFY_PATH = fileURLToPath(new URL('../../supabase/verify-schema.sql', import.meta.url));

describe('RLS / DB', () => {
    let db;

    beforeAll(async () => {
        db = await createSupabaseLikeDb();
    }, 120000);

    afterAll(async () => {
        await db?.close();
    });

    it('supabase/schema.sql applies a second time without error (idempotent)', async () => {
        await expect(db.exec(readFileSync(SCHEMA_PATH, 'utf8'))).resolves.toBeDefined();
    }, 60000);

    it('the post-apply verification passes against the schema (nothing missing)', async () => {
        // The same script the schema workflow runs after applying the schema:
        // it must pass on a database created from schema.sql.
        await expect(db.exec(readFileSync(VERIFY_PATH, 'utf8'))).resolves.toBeDefined();
    }, 60000);

    it('01-access: two sections plus an admin see and write exactly their own things', async () => {
        await runRlsScript(db, '01-access.sql');
    }, 60000);

    it('02-claim: leases, reclaim and the attempts cap behave like section 9.5', async () => {
        await runRlsScript(db, '02-claim.sql');
    }, 60000);

    it('03-integrity: idempotent delivery, the edit guard and retention', async () => {
        await runRlsScript(db, '03-integrity.sql');
    }, 60000);
});
