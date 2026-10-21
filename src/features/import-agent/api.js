// HTTP/database client for the import agent (spec §14.5) — every network
// touch the review UI makes, in one place.
//
// Three surfaces:
//   - `import-job` Edge Function (create/add_source/start/pump/cancel/status/
//     retry_chunk/add_row). Errors arrive as `{ ok: false, code,
//     message_key }` and become thrown `ImportApiError`s; the UI resolves the
//     message key through i18n and never shows an English server string.
//   - Tables (`import_*`): RLS-gated reads for the review load and the
//     optimistic-versioned updates for autosave (§10.8, guard trigger).
//   - Storage (`import-staging`): files leave the browser exactly once,
//     through the signed upload URLs the create step returned.
//
// Everything here awaits/returns plain data; no DOM, no Alpine.

import { supabase, getCurrentUser } from '../../services/supabase.js';
import { foldForMatch } from '@import-core/canonicalize.js';

export const ROW_PAGE = 500;

// `fetchAll` is shared by four tables with different ordering columns. Asking
// PostgREST to order import_chunks/import_sources by `seq` fails the whole
// review load, so keep the mapping explicit.
//
// The second column breaks the ties: `import_rows.seq` is unique per chunk
// only, and paging over a non-unique sort key silently duplicates and drops
// rows when a job has more rows than one page.
const TABLE_ORDER = {
    import_sources: { column: 'idx' },
    import_chunks: { column: 'idx' },
    import_rows: { column: 'seq', tiebreaker: 'id' },
    import_rejects: { column: 'created_at', tiebreaker: 'id' },
};

export function orderColumnFor(table) {
    return TABLE_ORDER[table]?.column ?? 'id';
}

export function orderTiebreakerFor(table) {
    return TABLE_ORDER[table]?.tiebreaker ?? 'id';
}

export class ImportApiError extends Error {
    constructor(code, messageKey, details = {}) {
        super(messageKey ?? `importAgent.error.${code}`);
        this.name = 'ImportApiError';
        this.code = code;
        this.messageKey = messageKey ?? `importAgent.error.${code}`;
        this.details = details;
    }
}

/** A table read failed because the access token expired, not because of RLS. */
function isAuthFailure(error) {
    return error?.code === 'PGRST301' || error?.status === 401;
}

function loadFailure(error, details = {}) {
    if (isAuthFailure(error)) {
        return new ImportApiError('UNAUTHORIZED', 'importAgent.error.UNAUTHORIZED', details);
    }
    return new ImportApiError('LOAD_FAILED', 'importAgent.error.LOAD_FAILED', details);
}

function serviceName() {
    return 'import-job';
}

/**
 * Invoke one `import-job` action. Returns the parsed body when `ok`;
 * throws `ImportApiError` with the server's code otherwise.
 */
export async function callJob(action, payload = {}) {
    const client = supabase();
    if (!client) throw new ImportApiError('OFFLINE', 'importAgent.error.OFFLINE');
    const { data, error } = await client.functions.invoke(serviceName(), {
        body: { action, ...payload },
    });

    if (error) {
        // Non-2xx responses land in `error` with the body in its context.
        let body = null;
        let status = null;
        try {
            status = error.context?.status ?? null;
            body = typeof error.context?.json === 'function' ? await error.context.json() : null;
        } catch {
            body = null;
        }
        if (String(body?.code ?? '').startsWith('UNAUTHORIZED')) {
            throw new ImportApiError('UNAUTHORIZED', 'importAgent.error.UNAUTHORIZED', { status });
        }
        if (status === 401) {
            throw new ImportApiError('UNAUTHORIZED', 'importAgent.error.UNAUTHORIZED', { status });
        }
        if (body?.code) throw new ImportApiError(body.code, body.message_key, { params: body.params ?? {} });
        throw new ImportApiError('INTERNAL', 'importAgent.error.INTERNAL', { status });
    }
    if (!data || data.ok !== true) {
        const code = data?.code ?? 'INTERNAL';
        if (String(code).startsWith('UNAUTHORIZED')) {
            throw new ImportApiError('UNAUTHORIZED', 'importAgent.error.UNAUTHORIZED');
        }
        throw new ImportApiError(code, data?.message_key, { params: data?.params ?? {} });
    }
    return data;
}

/** Per-file signed upload; mirrors the create step's `upload_urls`. */
export async function uploadToSignedCell(path, token, file) {
    const client = supabase();
    if (!client) throw new ImportApiError('OFFLINE', 'importAgent.error.OFFLINE');
    // uploadToSignedUrl takes the bucket-relative path, not the signed URL.
    const result = await client.storage.from('import-staging').uploadToSignedUrl(path, token, file);
    if (result.error) {
        throw new ImportApiError('UPLOAD_FAILED', 'importAgent.error.UPLOAD_FAILED', {
            message: result.error.message,
        });
    }
    return result.data;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Table read with automatic range paging (PostgREST defaults to 1000). */
async function fetchAll(table, filters = []) {
    const client = supabase();
    if (!client) throw new ImportApiError('OFFLINE', 'importAgent.error.OFFLINE');
    const all = [];
    for (let from = 0; ; from += ROW_PAGE) {
        let query = client.from(table).select('*');
        for (const [column, value] of filters) query = query.eq(column, value);
        const { data, error } = await query
            .order(orderColumnFor(table), { ascending: true })
            .order(orderTiebreakerFor(table), { ascending: true })
            .range(from, from + ROW_PAGE - 1);
        if (error) throw loadFailure(error, { table });
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < ROW_PAGE) break;
    }
    return all;
}

export function fetchJob(jobId) {
    return fetchAllFirst('import_jobs', jobId);
}

async function fetchAllFirst(table, jobId) {
    const client = supabase();
    if (!client) throw new ImportApiError('OFFLINE', 'importAgent.error.OFFLINE');
    const { data, error } = await client.from(table).select('*').eq('id', jobId).maybeSingle();
    if (error) throw loadFailure(error, { table });
    return data;
}

export function fetchSources(jobId) {
    return fetchAll('import_sources', [['job_id', jobId]]);
}

export function fetchChunks(jobId) {
    return fetchAll('import_chunks', [['job_id', jobId]]);
}

export function fetchRows(jobId) {
    return fetchAll('import_rows', [['job_id', jobId]]);
}

export function fetchRejects(jobId) {
    return fetchAll('import_rejects', [['job_id', jobId]]);
}

/** The newest own job that can still be resumed (spec §10.1 resumability). */
export async function latestResumableJob() {
    const client = supabase();
    if (!client) return null;
    const user = getCurrentUser();
    if (!user) return null;
    const { data } = await client
        .from('import_jobs')
        .select('id, status, created_at, section, hints, config')
        .eq('created_by', user.id)
        .in('status', ['uploaded', 'extracting', 'review', 'failed'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data ?? null;
}

// ---------------------------------------------------------------------------
// Writes (autosave)
// ---------------------------------------------------------------------------

/**
 * Persist one row's review fields. `version` is checked inline, so a stale
 * tab cannot clobber the current one; a missed update throws `SAVE_CONFLICT`.
 */
export async function saveRow(row, snapshot) {
    const client = supabase();
    if (!client) throw new ImportApiError('OFFLINE', 'importAgent.error.OFFLINE');
    const nextVersion = (snapshot.version ?? row.version ?? 1) + 1;
    const { data, error } = await client
        .from('import_rows')
        .update({
            cells: snapshot.cells,
            issues: snapshot.issues,
            acknowledged: snapshot.acknowledged,
            dup: snapshot.dup,
            removed: snapshot.removed,
            status: snapshot.status,
            version: nextVersion,
        })
        .eq('id', row.id)
        .eq('version', snapshot.version ?? row.version ?? 1)
        .select('id, version')
        .maybeSingle();
    if (error) throw new ImportApiError('SAVE_FAILED', 'importAgent.error.SAVE_FAILED');
    if (!data) throw new ImportApiError('SAVE_CONFLICT', 'importAgent.error.SAVE_CONFLICT', { id: row.id });
    return data;
}

/**
 * Save a list of change snapshots sequentially; rows keep an order-safe pace
 * and one failure stops the run (the caller re-checks state).
 */
export async function saveRows(changes) {
    const saved = [];
    for (const change of changes) {
        saved.push(await saveRow(change, change.after));
    }
    return saved;
}

/**
 * Load the existence context for dedupe (spec §8.6):
 *   - `existing`: every national ID that exists in `patients` at all (the RPC
 *     is SECURITY DEFINER, so it sees other sections: invisible to the user),
 *   - visible ones map to the patient row the user can open,
 *   - `nameDobMatches`: visible patients whose folded name + DOB pair matches,
 *     to catch a mistyped national ID.
 * The browser folds names with the same canonicalization the pipeline uses,
 * so review and the pipeline agree on duplicates.
 */
export async function loadExistingContext(rows) {
    const client = supabase();
    if (!client) return { existing: new Map(), nameDobMatches: new Set() };

    const existing = new Map();
    const nameDobMatches = new Set();

    const ids = [...new Set(rows
        .map((row) => row.cells?.national_id?.value)
        .filter((value) => typeof value === 'string' && /^\d{14}$/.test(value)))].slice(0, 2000);

    const dobs = [...new Set(rows
        .map((row) => row.cells?.date_of_birth?.value)
        .filter((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)))].slice(0, 400);

    if (ids.length === 0 && dobs.length === 0) {
        return { existing, nameDobMatches };
    }

    for (let from = 0; from < ids.length; from += 200) {
        const slice = ids.slice(from, from + 200);
        // Existence regardless of section visibility.
        const { data: rpcIds, error } = await client.rpc('existing_national_ids', { ids: slice });
        if (error) throw loadFailure(error, { rpc: 'existing_national_ids' });
        for (const nid of rpcIds ?? []) existing.set(nid, { visible: false });
        // Which of those the user can actually see (RLS-filtered).
        if (slice.length > 0) {
            const { data: visible, error: visError } = await client
                .from('patients')
                .select('id, national_id, name, date_of_birth')
                .in('national_id', slice);
            if (visError) throw loadFailure(visError, { table: 'patients' });
            for (const patient of visible ?? []) {
                existing.set(patient.national_id, { visible: true, patient_id: patient.id });
                nameDobMatches.add(nameDobKey(patient.name, patient.date_of_birth));
            }
        }
    }

    // Name+DOB pairs for every visible patient sharing a row's DOB — this is
    // what catches a mistyped national ID (“same name, same birthday, wrong
    // ID”). Keys are built exactly like the pipeline's `nameDobKey`.
    if (dobs.length > 0) {
        for (let from = 0; from < dobs.length; from += 100) {
            const slice = dobs.slice(from, from + 100);
            const { data: byDob, error: dobError } = await client
                .from('patients')
                .select('id, name, date_of_birth')
                .in('date_of_birth', slice);
            if (dobError) continue; // advisory only
            for (const patient of byDob ?? []) {
                const key = nameDobKey(patient.name, patient.date_of_birth);
                if (key) nameDobMatches.add(key);
            }
        }
    }

    return { existing, nameDobMatches };
}

/** Hashes this account imported before, for the "seen before" warning. */
export async function fetchSeenHashes(hashes) {
    const client = supabase();
    const seen = new Map();
    if (!client || hashes.length === 0) return seen;
    for (let from = 0; from < hashes.length; from += 100) {
        const slice = hashes.slice(from, from + 100);
        const { data } = await client
            .from('import_sources')
            .select('sha256, created_at')
            .in('sha256', slice)
            .order('created_at', { ascending: true });
        for (const source of data ?? []) {
            if (source.sha256) seen.set(source.sha256, source.created_at);
        }
    }
    return seen;
}

/**
 * The pipeline's own key for (folded name, date of birth) — see
 * `import-core/dedupe.js nameDobKey()`; the browser must build the same keys.
 */
export function nameDobKey(name, value) {
    const folded = foldForMatch(String(name ?? ''));
    if (!folded || !value) return null;
    return `${folded}\u0000${String(value)}`;
}

/** A small prettifier used by the wizard when it reports upload sizes. */
export function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n;
    let unitIndex = 0;
    while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex += 1;
    }
    return `${value < 10 && unitIndex > 0 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}
