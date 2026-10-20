// import-cleanup — retention for the AI import agent (design spec §9.7).
//
// Invoked daily by pg_cron through public.import_daily_maintenance() (pg_net),
// or manually with the service-role key. Two jobs:
//
//   1. SQL retention: rows of finished jobs lose `extracted`/`cells` after
//      ROW_RETENTION_DAYS; batch payloads lose `before`/`after` after
//      BATCH_PAYLOAD_RETENTION_DAYS. Idempotent; also runs from cron alone.
//
//   2. Staging purge: staged files, chunk payloads and raw model responses
//      are deleted STAGING_TTL_HOURS_AFTER_DONE hours after the job is
//      done/cancelled, or when the job expires (STAGING_TTL_DAYS). Storage
//      objects are removed through the Storage API, hence this function.
//
// Deployed with --no-verify-jwt (the gateway cannot check a shared secret);
// this function authenticates callers itself and fails closed. No PHI goes
// into logs or responses — only job ids and counts.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { LIMITS } from '../_shared/import-core/limits.js';

const BUCKET = 'import-staging';
const MAX_JOBS_PER_RUN = 200;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cleanup-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? Deno.env.get('SERVICE_ROLE_KEY')
    ?? '';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    serviceRoleKey,
);

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

// The only gate (the gateway is deployed with --no-verify-jwt): the shared
// secret set for the cron call, or the service-role key for manual runs.
function authorized(req: Request): boolean {
    const secret = Deno.env.get('IMPORT_CLEANUP_SECRET') ?? '';
    const presented = req.headers.get('x-cleanup-secret') ?? '';
    if (secret && presented === secret) return true;
    const authorization = req.headers.get('Authorization') ?? '';
    if (serviceRoleKey && authorization === `Bearer ${serviceRoleKey}`) return true;
    return false;
}

// Recursively lists every object under a prefix. Folder entries come back
// with a null id and no metadata; files are collected with their full path.
async function listObjects(prefix: string): Promise<string[]> {
    const filePaths: string[] = [];
    const folders = [prefix];
    while (folders.length > 0) {
        const folder = folders.pop() as string;
        const pageSize = 1000;
        for (let offset = 0; ; offset += pageSize) {
            const { data, error } = await supabase.storage
                .from(BUCKET)
                .list(folder, { limit: pageSize, offset });
            if (error) throw new Error(`list ${folder}: ${error.message}`);
            if (!data || data.length === 0) break;
            for (const entry of data) {
                if (entry.id === null) {
                    folders.push(`${folder}${entry.name}/`);
                } else {
                    filePaths.push(`${folder}${entry.name}`);
                }
            }
            if (data.length < pageSize) break;
        }
    }
    return filePaths;
}

async function removeObjects(paths: string[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < paths.length; i += 100) {
        const batch = paths.slice(i, i + 100);
        const { error } = await supabase.storage.from(BUCKET).remove(batch);
        if (error) throw new Error(`remove: ${error.message}`);
        removed += batch.length;
    }
    return removed;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return json({ ok: true }, 200);
    }
    if (!authorized(req)) {
        return json({ ok: false, code: 'unauthorized' }, 401);
    }

    try {
        // 1. Row and batch-payload retention (idempotent; cron runs it too).
        const { data: retention, error: retentionError } = await supabase.rpc('import_run_retention', {
            p_row_days: LIMITS.ROW_RETENTION_DAYS,
            p_batch_days: LIMITS.BATCH_PAYLOAD_RETENTION_DAYS,
        });
        if (retentionError) throw new Error(`retention: ${retentionError.message}`);

        // 2. Jobs whose staged data has outlived its TTL.
        //    A job that is still open (uploads, extracting, review) keeps its
        //    chunk payloads: the review screen re-runs the pipeline against
        //    those source lines, and without them every row would come back
        //    as an error with empty fields - and the review would write that
        //    destruction back to the database.
        const doneCutoff = new Date(
            Date.now() - LIMITS.STAGING_TTL_HOURS_AFTER_DONE * 60 * 60 * 1000,
        ).toISOString();
        const nowIso = new Date().toISOString();
        const { data: jobs, error: jobsError } = await supabase
            .from('import_jobs')
            .select('id, created_by, status')
            .or(`and(status.in.(done,cancelled),updated_at.lte.${doneCutoff}),and(expires_at.lte.${nowIso},status.in.(failed))`)
            .limit(MAX_JOBS_PER_RUN);
        if (jobsError) throw new Error(`jobs: ${jobsError.message}`);

        let objectsRemoved = 0;
        for (const job of jobs ?? []) {
            const prefix = `${job.created_by}/${job.id}/`;
            const paths = await listObjects(prefix);
            if (paths.length > 0) {
                objectsRemoved += await removeObjects(paths);
            }
            // Null the references; the rows, counts and reports stay (spec §9.7).
            const { error: sourcesError } = await supabase
                .from('import_sources')
                .update({ storage_path: null })
                .eq('job_id', job.id);
            if (sourcesError) throw new Error(`sources: ${sourcesError.message}`);
            const { error: chunksError } = await supabase
                .from('import_chunks')
                .update({ payload: null, payload_path: null, raw_response_path: null })
                .eq('job_id', job.id);
            if (chunksError) throw new Error(`chunks: ${chunksError.message}`);
        }

        return json({
            ok: true,
            retention,
            jobs_purged: (jobs ?? []).length,
            objects_removed: objectsRemoved,
        });
    } catch (e) {
        return json({ ok: false, code: 'cleanup_failed', message: e instanceof Error ? e.message : String(e) }, 500);
    }
});
