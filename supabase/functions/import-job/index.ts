// import-job — the extraction pump (design spec §9.5, §14.3).
//
// Actions: create | add_source | start | pump | cancel | status | retry_chunk |
// add_row | enabled. The browser calls `pump` in a loop; each call claims chunks under a
// lease (import_claim_chunks), runs them through the provider in parallel,
// writes rows through the shared import-core pipeline, and returns progress.
//
// Nothing PHI leaves this function except through the provider call itself:
// responses carry counts, labels and codes — never patient values.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import yaml from 'https://esm.sh/js-yaml@4.1.0';
import { LIMITS, leaseSecondsFor, pumpParallelFor, resolveLimits } from '../_shared/import-core/limits.js';
import { prepareSources, shiftSourceIds, splitChunkPayload } from '../_shared/import-core/chunker.js';
import { runPipeline } from '../_shared/import-core/pipeline.js';
import { PROMPT_IDS } from '../_shared/import-core/yaml-contract.js';
import { readAiChain, chainFromRow, SettingsError, type AiSettingsRow } from '../_shared/ai-settings.ts';
import { createOpenRouterProvider } from '../_shared/llm/openrouter.ts';
import { createCloudflareProvider } from '../_shared/llm/cloudflare.ts';
import { createOpenAiCompatibleProvider } from '../_shared/llm/openai-compatible.ts';
import { runChunkWithFallback } from '../_shared/llm/fallback.js';
import { modelList, visionEntries } from '../_shared/llm/vision.ts';
import { affordableChunks, paceMs, rateFor } from '../_shared/llm/provider-rate.ts';
import { jobTokenCapForContext, resolveModelContext } from '../_shared/llm/model-context.ts';
import { runChunk } from '../import-extract/run-chunk.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    });
}

function fail(code: string, status = 400, params: Record<string, unknown> = {}): Response {
    return json({ ok: false, code, message_key: `importAgent.error.${code}`, params }, status);
}

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

function sanitizeName(name: string): string {
    return String(name ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'file';
}

/** Mirror of the reader's textToLines for pasted text (ids L001…). */
function linesOfText(text: string): { id: string; text: string }[] {
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
    const raw = normalized.split('\n');
    if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    return raw.map((line, i) => ({ id: `L${String(i + 1).padStart(3, '0')}`, text: line }));
}

/** Build the provider from validated, decrypted credentials. */
function buildProvider(
    credentials: { provider: string; model: string; apiKey: string | null; accountId: string | null; baseUrl: string | null },
    limits: typeof LIMITS = LIMITS,
) {
    if (credentials.provider === 'openrouter') {
        return createOpenRouterProvider({
            apiKey: credentials.apiKey ?? '',
            // One chain row is exactly one model. Passing an array prevents the
            // adapter from splitting a model id on whitespace or commas.
            model: [credentials.model],
            appTitle: 'Clinic EHR import agent',
            timeoutMs: limits.PROVIDER_TIMEOUT_MS,
            maxAttempts: limits.PROVIDER_MAX_ATTEMPTS,
        });
    }
    if (credentials.provider === 'cloudflare') {
        return createCloudflareProvider({
            accountId: credentials.accountId ?? '',
            apiKey: credentials.apiKey ?? '',
            model: credentials.model,
            timeoutMs: limits.PROVIDER_TIMEOUT_MS,
            maxAttempts: limits.PROVIDER_MAX_ATTEMPTS,
        });
    }
    return createOpenAiCompatibleProvider({
        baseUrl: credentials.baseUrl ?? '',
        apiKey: credentials.apiKey,
        model: credentials.model,
        // Groq (and the OpenAI o-series) reject `max_tokens` with HTTP 400.
        timeoutMs: limits.PROVIDER_TIMEOUT_MS,
        maxAttempts: limits.PROVIDER_MAX_ATTEMPTS,
        preferMaxCompletionTokens: credentials.provider === 'groq',
    });
}

/**
 * Decrypt the ordered chain and build one client per ready entry. Unready
 * entries are skipped with a logged reason so a broken secondary cannot block
 * a working primary. If no entry is ready the whole extraction fails loudly.
 */
async function loadReadyChain(
    settingsRow: AiSettingsRow | null,
    context: string,
    limits: typeof LIMITS = LIMITS,
) {
    if (!settingsRow || settingsRow.enabled !== true) {
        throw new SettingsError('FEATURE_DISABLED', 'The import agent is disabled in AI settings');
    }
    const resolved = await readAiChain(settingsRow, Deno.env.get('AI_SETTINGS_ENC_KEY') ?? '');
    if (resolved.entries.length === 0) {
        console.error('AI chain has no ready entries', context, resolved.skipped);
        const codes = new Set(resolved.skipped.map((entry) => entry.code));
        const code = codes.has('ENCRYPTION_KEY_MISSING')
            ? 'ENCRYPTION_KEY_MISSING'
            : codes.has('DECRYPT_FAILED')
                ? 'DECRYPT_FAILED'
                : 'NOT_CONFIGURED';
        throw new SettingsError(code, 'No ready model in the AI chain');
    }
    if (resolved.skipped.length > 0) {
        console.warn('AI chain skipped unready entries', context, resolved.skipped);
    }
    return resolved.entries.map((entry) => ({
        ...entry,
        client: buildProvider(entry, limits),
    }));
}

async function tokenCapForPrimary(
    primary: { provider: string; model: string; apiKey?: string | null; accountId?: string | null; baseUrl?: string | null },
    ownerId: string,
    limits: typeof LIMITS,
): Promise<number> {
    let context: number | null = null;
    try {
        context = await resolveModelContext(primary);
    } catch (err) {
        console.warn('model context lookup failed, using fallback token cap', ownerId, (err as Error)?.message);
    }
    const cap = jobTokenCapForContext(context, limits);
    if (context) {
        console.info('job token cap from model context', ownerId, primary.provider, primary.model, context, cap);
    } else {
        console.warn('model context unavailable, using fallback token cap', ownerId, primary.provider, primary.model, cap);
    }
    return cap;
}

type Service = ReturnType<typeof createClient>;

async function audit(service: Service, actor: string, action: string, entityId: string, meta: Record<string, unknown> = {}) {
    try {
        await service.from('audit_log').insert({ actor, action, entity: 'import_job', entity_id: entityId, meta });
    } catch {
        // Audit is best-effort; never blocks the action.
    }
}

async function loadJobForUser(service: Service, userId: string, jobId: string) {
    const { data, error } = await service.from('import_jobs').select('*').eq('id', jobId).maybeSingle();
    if (error || !data) return { error: 'NOT_FOUND' as const };
    if (data.created_by !== userId) return { error: 'FORBIDDEN' as const };
    return { job: data };
}

/**
 * The tokens this account already spent in the last minute. The provider's
 * per-minute budget is checked against it, so a big import slows itself
 * down instead of collecting 429s.
 */
async function sumUsageSince(service: Service, userId: string, since: Date): Promise<number> {
    const { data } = await service
        .from('ai_usage')
        .select('tokens_in, tokens_out')
        .eq('user_id', userId)
        .gte('created_at', since.toISOString());
    let total = 0;
    for (const row of data ?? []) total += (row.tokens_in ?? 0) + (row.tokens_out ?? 0);
    return total;
}

type OpenRouterFreeQuota = {
    remaining: number | null;
    limit: number | null;
    used: number | null;
};

/**
 * OpenRouter's `/key` endpoint reports how many free-model requests remain
 * today. It is a read-only GET and does not consume a model request, so a
 * rate-limited pump can show "0 of 50 left" without guessing.
 */
async function openRouterFreeQuota(
    chain: { provider: string; apiKey: string | null }[],
): Promise<OpenRouterFreeQuota | null> {
    const entry = chain.find((item) => item.provider === 'openrouter' && item.apiKey);
    if (!entry?.apiKey) return null;
    try {
        const response = await fetch('https://openrouter.ai/api/v1/key', {
            headers: { Authorization: `Bearer ${entry.apiKey}` },
            signal: AbortSignal.timeout(4_000),
        });
        if (!response.ok) return null;
        const payload = await response.json() as {
            data?: { free_model_daily_requests?: Record<string, unknown> };
        };
        const daily = payload?.data?.free_model_daily_requests;
        if (!daily) return null;
        const count = (value: unknown) => (
            typeof value === 'number' && Number.isFinite(value) ? value : null
        );
        return {
            remaining: count(daily.remaining),
            limit: count(daily.limit),
            used: count(daily.used),
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Context = {
    user: { id: string };
    service: Service;
    settingsRow: AiSettingsRow | null;
    limits: typeof LIMITS;
};

async function actionCreate(body: Record<string, unknown>, ctx: Context) {
    const { user, service, settingsRow, limits } = ctx;
    const hints = String(body.hints ?? '');
    if (hints.length > limits.MAX_HINT_CHARS) return fail('HINTS_TOO_LONG');

    const sourcesMeta = Array.isArray(body.sources_meta) ? body.sources_meta : [];
    if (sourcesMeta.length === 0 || sourcesMeta.length > limits.MAX_FILES) return fail('BAD_REQUEST');

    if (!settingsRow || settingsRow.enabled !== true) return fail('FEATURE_DISABLED', 403);

    // Rate limits: the provider's own limits are the only ones. The app does
    // not count imports per day and does not cut a job off after a token
    // budget - a provider that refuses a request says so, and that error is
    // what the user sees. (The daily job quota and the daily token cap were
    // removed: they blocked accounts while the provider was wide open.)
    // The only guard left is the concurrency of one account's own imports.
    const { data: active } = await service
        .from('import_jobs')
        .select('id')
        .eq('created_by', user.id)
        .in('status', ['extracting', 'committing']);
    if ((active?.length ?? 0) >= limits.MAX_CONCURRENT_JOBS) {
        await audit(service, user.id, 'job.rejected', 'n/a', { code: 'TOO_MANY_JOBS' });
        return fail('TOO_MANY_JOBS', 429, { limit: limits.MAX_CONCURRENT_JOBS });
    }

    // Freeze the live option lists into the job (spec §4.3, §9.3 config).
    const { data: options } = await service
        .from('app_options')
        .select('kind, key, label_en, label_ar, sort_order')
        .eq('active', true)
        .order('sort_order');
    const enumSnapshot: Record<string, unknown[]> = { follower: [], section: [], sourceOfMoney: [] };
    for (const option of options ?? []) {
        const bucket = option.kind === 'source' ? 'sourceOfMoney' : option.kind;
        (enumSnapshot[bucket] ??= []).push({
            key: option.key,
            label_en: option.label_en,
            label_ar: option.label_ar,
        });
    }

    const config = {
        prompt_ids: PROMPT_IDS,
        defaults: body.defaults ?? {},
        enum_snapshot: enumSnapshot,
        provider: settingsRow
            ? { provider: settingsRow.provider, model: settingsRow.model }
            : null,
        model_chain: settingsRow ? chainFromRow(settingsRow) : [],
        limits,
    };

    const { data: job, error } = await service
        .from('import_jobs')
        .insert({
            created_by: user.id,
            section: body.section ?? null,
            status: 'uploaded',
            config,
            hints,
            token_cap: limits.JOB_TOKEN_CAP,
            expires_at: new Date(Date.now() + limits.STAGING_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        })
        .select()
        .single();
    if (error || !job) return fail('INTERNAL', 500);

    const uploadUrls = [];
    for (let i = 0; i < sourcesMeta.length; i += 1) {
        const meta = (sourcesMeta[i] ?? {}) as Record<string, unknown>;
        const path = `${user.id}/${job.id}/${i + 1}-${sanitizeName(String(meta.name ?? `file-${i + 1}`))}`;
        const { data: signed, error: signError } = await service.storage
            .from('import-staging')
            .createSignedUploadUrl(path);
        uploadUrls.push({
            idx: i + 1,
            path,
            url: signError ? null : signed?.signedUrl ?? null,
            token: signError ? null : signed?.token ?? null,
        });
    }

    await audit(service, user.id, 'job.created', job.id, { sources: sourcesMeta.length });
    return json({ ok: true, job_id: job.id, upload_urls: uploadUrls });
}

function validateChunkPayload(payload: unknown): payload is { kind?: string; lines: { id: string; text: string }[]; images?: unknown[] } {
    const chunk = payload as { kind?: unknown; lines?: unknown; images?: unknown };
    if (!chunk) return false;
    // A photo of a note is a chunk without text lines: it carries the image
    // tiles instead (spec §5.4).
    if (chunk.kind === 'image') {
        if (!Array.isArray(chunk.images) || chunk.images.length === 0) return false;
        return chunk.images.every((image) => {
            const entry = image as { id?: unknown; dataUrl?: unknown };
            return entry
                && typeof entry.id === 'string'
                && typeof entry.dataUrl === 'string'
                && entry.dataUrl.startsWith('data:image/');
        });
    }
    if (!Array.isArray(chunk.lines) || chunk.lines.length === 0) return false;
    return chunk.lines.every((line) => {
        const entry = line as { id?: unknown; text?: unknown };
        return entry && typeof entry.id === 'string' && typeof entry.text === 'string';
    });
}

async function actionAddSource(body: Record<string, unknown>, ctx: Context) {
    const { user, service, limits } = ctx;
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    if (job.status !== 'uploaded') return fail('JOB_STATE', 409);

    const kind = String(body.kind ?? 'text');
    const name = String(body.name ?? '').slice(0, 200);

    // Sources are numbered by add order (spec §6.2) — the text path needs the
    // number up front so its pooled ids do not reuse `S1`.
    const sourceIdx = ((await service.from('import_sources').select('idx').eq('job_id', job.id)).data ?? [])
        .reduce((max, row) => Math.max(max, row.idx), 0) + 1;

    let chunks: unknown[] | null = Array.isArray(body.chunks) ? body.chunks : null;
    const sourceWarnings: unknown[] = [];
    if (!chunks && typeof body.text === 'string') {
        // Pasted text: the server chunks it with the shared chunker, so the
        // browser and the function produce identical payloads (spec §6.2).
        const prepared = prepareSources(
            [{ kind: 'text', layout: 'text', name, header: null, lines: linesOfText(String(body.text)) }],
            limits,
        );
        chunks = shiftSourceIds(prepared.chunks, sourceIdx);
        sourceWarnings.push(...prepared.warnings);
    }
    if (!chunks || chunks.length === 0) return fail('NO_CHUNKS');
    for (const chunk of chunks) {
        if (!validateChunkPayload(chunk)) return fail('BAD_REQUEST');
    }

    const { data: existingChunks } = await service.from('import_chunks').select('idx, payload, kind').eq('job_id', job.id);
    const usedChunks = existingChunks?.length ?? 0;
    if (usedChunks + chunks.length > limits.MAX_CHUNKS) return fail('CHUNK_CAP');

    // Server-side re-check of the shared spreadsheet row budget (spec §6.4).
    let sheetRows = 0;
    for (const chunk of existingChunks ?? []) {
        if (chunk.kind === 'sheet') sheetRows += chunk.payload?.lines?.length ?? 0;
    }
    for (const chunk of chunks) {
        const payload = chunk as { kind?: string; lines: unknown[] };
        if ((payload.kind ?? kind) === 'sheet') sheetRows += payload.lines.length;
    }
    if (sheetRows > limits.MAX_ROWS) return fail('ROW_CAP');

    const { data: source, error: sourceError } = await service
        .from('import_sources')
        .insert({
            job_id: job.id,
            idx: sourceIdx,
            kind,
            name,
            mime: body.mime ?? null,
            bytes: body.bytes ?? null,
            sha256: body.sha256 ?? null,
            storage_path: body.storage_path ?? null,
            meta: body.meta ?? {},
            warnings: [...(Array.isArray(body.warnings) ? body.warnings : []), ...sourceWarnings],
        })
        .select()
        .single();
    if (sourceError || !source) return fail('INTERNAL', 500);

    const rows = chunks.map((payload, offset) => ({
        job_id: job.id,
        source_id: source.id,
        idx: usedChunks + offset + 1,
        kind: (payload as { kind?: string }).kind ?? kind,
        payload,
        status: 'queued',
    }));
    const { error: chunksError } = await service.from('import_chunks').insert(rows);
    if (chunksError) return fail('CONFLICT', 409);

    return json({ ok: true, source_id: source.id, chunks: rows.length });
}

async function actionStart(body: Record<string, unknown>, ctx: Context) {
    const { user, service, settingsRow, limits } = ctx;
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    if (job.status !== 'uploaded') return fail('JOB_STATE', 409);

    const { count } = await service
        .from('import_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', job.id);
    if (!count) return fail('NO_CHUNKS');

    // Preflight the real chain before marking the job as extracting. Without
    // this a job with no decryptable key enters extraction and fails every
    // chunk in the pump, which looks like a provider outage instead of a
    // settings problem.
    let chain;
    try {
        chain = await loadReadyChain(settingsRow, String(job.id), limits);
    } catch (err) {
        const code = err instanceof SettingsError ? err.code : 'PROVIDER_NOT_READY';
        return fail(code, 409);
    }

    // The job cap is a budget, not the per-call context size. Follow the
    // selected model's context window when the provider exposes it, and keep
    // the deployment fallback when it does not. A failed lookup never blocks.
    const primary = chain[0];
    if (!primary) return fail('NOT_CONFIGURED', 409);
    const tokenCap = await tokenCapForPrimary(primary, String(job.id), limits);

    await service
        .from('import_jobs')
        .update({ status: 'extracting', token_cap: tokenCap, updated_at: new Date().toISOString() })
        .eq('id', job.id);
    return json({ ok: true, status: 'extracting', chunks_total: count, token_cap: tokenCap });
}

async function chunkProgress(service: Service, jobId: string) {
    const { data: chunks } = await service
        .from('import_chunks')
        .select('idx, status, attempts, lease_until, truncated, error_code')
        .eq('job_id', jobId)
        .order('idx');
    const progress = {
        total: 0, done: 0, failed: 0, queued: 0, running: 0, split: 0,
        truncated: 0, rate_limited: 0, next_label: null as string | null,
    };
    const now = Date.now();
    for (const chunk of chunks ?? []) {
        progress.total += 1;
        if (chunk.status === 'done' || chunk.status === 'split') progress.done += 1;
        else if (chunk.status === 'failed') {
            progress.failed += 1;
            if (chunk.error_code === 'PROVIDER_RATE_LIMITED') progress.rate_limited += 1;
        } else if (chunk.status === 'running') progress.running += 1;
        else progress.queued += 1;
        const expired = chunk.status === 'running' && chunk.lease_until && Date.parse(chunk.lease_until) < now;
        if (progress.next_label === null && (chunk.status === 'queued' || expired)) {
            progress.next_label = `c${chunk.idx}`;
        }
        if (chunk.status === 'split') progress.split += 1;
        if (chunk.truncated) progress.truncated += 1;
    }
    return progress;
}

async function progressPayload(
    ctx: Context,
    job: Record<string, unknown>,
    banners: unknown[] = [],
    extra: { paceMs?: number } = {},
) {
    const progress = await chunkProgress(ctx.service, job.id as string);
    return json({
        ok: true,
        status: job.status,
        done: progress.done,
        total: progress.total,
        failed: progress.failed,
        truncated: progress.truncated,
        next_label: progress.next_label,
        tokens: {
            in: job.tokens_in ?? 0,
            out: job.tokens_out ?? 0,
            cap: job.token_cap ?? null,
        },
        // How long the client should wait before the next call (the
        // provider's per-minute budget decides).
        pace_ms: extra.paceMs ?? 0,
        banners,
    });
}

/** Mark chunks that ran out of attempts as failed — they can never be claimed. */
async function failExhausted(service: Service, jobId: string, limits: typeof LIMITS) {
    const now = new Date().toISOString();
    const { data: chunks } = await service
        .from('import_chunks')
        .select('id, status, attempts, lease_until')
        .eq('job_id', jobId)
        .lt('attempts', limits.MAX_ATTEMPTS + 1);
    const stuck = (chunks ?? []).filter((chunk) => {
        if (chunk.status === 'queued') return false; // still claimable
        if (chunk.status !== 'running') return false;
        const expired = !chunk.lease_until || chunk.lease_until < now;
        return expired && chunk.attempts >= limits.MAX_ATTEMPTS;
    });
    for (const chunk of stuck) {
        await service
            .from('import_chunks')
            .update({ status: 'failed', error_code: 'MAX_ATTEMPTS', lease_until: null })
            .eq('id', chunk.id);
    }
}

async function persistChunkResult(
    ctx: Context,
    job: Record<string, unknown>,
    chunkRow: { id: string; idx: number; payload: Record<string, unknown>; source_id?: string | null },
    result: Awaited<ReturnType<typeof runChunk>>,
) {
    const { service } = ctx;
    const payload = chunkRow.payload ?? {};
    const lines = Array.isArray(payload.lines) ? payload.lines : [];

    // Failed chains still made real provider calls. Record their aggregated
    // usage before returning, otherwise a chain that exhausts every entry
    // hides its cost from the job cap and the daily cap.
    const recordUsage = async () => {
        const usage = result.usage ?? { in: 0, out: 0 };
        if (usage.in > 0 || usage.out > 0 || result.cost != null) {
            const { error: bumpError } = await service.rpc('import_bump_tokens', {
                p_job_id: job.id,
                p_in: usage.in,
                p_out: usage.out,
            });
            if (bumpError) console.error('token bump failed', job.id, bumpError.message);
            const { error: usageError } = await service.from('ai_usage').insert({
                user_id: job.created_by,
                job_id: job.id,
                chunk_id: chunkRow.id,
                model: result.model,
                tokens_in: usage.in,
                tokens_out: usage.out,
                cost_est: result.cost ?? null,
            });
            if (usageError) console.error('ai_usage insert failed', job.id, usageError.message);
        }
    };

    if (result.status === 'failed') {
        const { error: failError } = await service
            .from('import_chunks')
            .update({
                status: 'failed',
                error_code: result.errorCode ?? 'PROVIDER_ERROR',
                prompt_id: result.promptId,
                model: result.model,
                tokens_in: result.usage.in,
                tokens_out: result.usage.out,
                lease_until: null,
            })
            .eq('id', chunkRow.id);
        if (failError) console.error('chunk fail update failed', chunkRow.id, failError.message);
        await recordUsage();
        return null;
    }

    // Stages 5–6 in the shared pipeline (spec §8): the same code the browser
    // reruns on every cell edit.
    const lineRecords = lines.map((line: { id: string; text: string }) => ({ id: line.id, text: line.text }));
    const chunkLineIds = lineRecords.map((line: { id: string }) => line.id);
    const extractedByIndex = new Map(result.documents.map((doc) => [doc.index, doc.record]));
    // A photo of a note has no text lines: the model read the image, so the
    // values cannot be grounded against a source text.
    const isImage = payload.kind === 'image';
    const pipeline = runPipeline({
        records: result.documents.map((doc) => ({ ...doc.record, _chunkIndex: doc.index })),
        sourceId: (payload.source_id as string) ?? 'S1',
        kind: payload.kind === 'sheet' ? 'sheet' : isImage ? 'image' : 'text',
        lines: lineRecords,
        chunkLineIds,
        dataLineIds: payload.kind === 'sheet' ? chunkLineIds : null,
        snapshot: (job.config as { enum_snapshot?: object })?.enum_snapshot ?? {},
        today: todayIso(),
        defaults: (job.config as { defaults?: object })?.defaults ?? {},
        requireSection: false,
        ground: !isImage,
    });

    const rowPayload = pipeline.rows.map((row, offset) => ({
        job_id: job.id,
        chunk_id: chunkRow.id,
        seq: offset + 1,
        src: row.src ?? [],
        extracted: extractedByIndex.get(row.chunkIndex) ?? null,
        cells: row.cells,
        issues: row.issues,
        status: row.status,
        dup: row.dup ?? null,
    }));
    if (rowPayload.length > 0) {
        const { error: rowsError } = await service
            .from('import_rows')
            .upsert(rowPayload, { onConflict: 'chunk_id,seq', ignoreDuplicates: true });
        if (rowsError) {
            // The chunk must not be reported as done when its rows were not
            // stored: the review would show an empty job with no error.
            console.error('import_rows upsert failed', chunkRow.id, rowsError.message);
            await service
                .from('import_chunks')
                .update({ status: 'failed', error_code: 'PERSIST_FAILED', lease_until: null })
                .eq('id', chunkRow.id);
            return null;
        }
    }

    const trayPayload = [
        ...pipeline.rejected.map((row) => ({
            job_id: job.id,
            chunk_id: chunkRow.id,
            reason: row.reason ?? 'REJECTED',
            raw: row.raw ?? null,
            src: lineRecords,
        })),
        ...result.rejected.map((entry) => ({
            job_id: job.id,
            chunk_id: chunkRow.id,
            reason: 'PARSE_FAILED',
            raw: `${entry.error}\n\n${entry.raw}`,
            src: lineRecords,
        })),
    ];
    if (trayPayload.length > 0) {
        const { error: trayError } = await service.from('import_rejects').insert(trayPayload);
        if (trayError) console.error('import_rejects insert failed', chunkRow.id, trayError.message);
    }

    // Unmapped text stays visible in the tray (invariant I8, spec 10.7): one
    // reject row per entry, carrying its row's seq so the tray can move the
    // text into a cell and then resolve (delete) the item.
    const unmappedPayload = pipeline.rows.flatMap((row, offset) => (row.unmapped ?? []).map((text: string) => ({
        job_id: job.id,
        chunk_id: chunkRow.id,
        reason: 'UNMAPPED',
        raw: text,
        src: { seq: offset + 1 },
    })));
    if (unmappedPayload.length > 0) {
        const { error: unmappedError } = await service.from('import_rejects').insert(unmappedPayload);
        if (unmappedError) console.error('unmapped reject insert failed', chunkRow.id, unmappedError.message);
    }

    await recordUsage();

    const needsSplit = result.truncated || pipeline.requeueSplit;
    if (needsSplit) {
        const children = splitChunkPayload(payload as never);
        if (!children) {
            // A one-line chunk cannot be split: fail it so the tray can take it.
            await service
                .from('import_chunks')
                .update({
                    status: 'failed',
                    error_code: 'SPLIT_IMPOSSIBLE',
                    truncated: true,
                    prompt_id: result.promptId,
                    model: result.model,
                    tokens_in: result.usage.in,
                    tokens_out: result.usage.out,
                    lease_until: null,
                })
                .eq('id', chunkRow.id);
            return null;
        }
        // The children re-extract the same lines, so the parent's partial rows
        // and tray entries would show every patient twice. Drop them before
        // the children take over.
        const { error: parentRowsError } = await service
            .from('import_rows')
            .delete()
            .eq('chunk_id', chunkRow.id);
        if (parentRowsError) console.error('parent rows delete failed', chunkRow.id, parentRowsError.message);
        const { error: parentRejectsError } = await service
            .from('import_rejects')
            .delete()
            .eq('chunk_id', chunkRow.id);
        if (parentRejectsError) console.error('parent rejects delete failed', chunkRow.id, parentRejectsError.message);
        await service
            .from('import_chunks')
            .update({
                status: 'split',
                truncated: true,
                prompt_id: result.promptId,
                model: result.model,
                tokens_in: result.usage.in,
                tokens_out: result.usage.out,
                lease_until: null,
            })
            .eq('id', chunkRow.id);
        return { parentId: chunkRow.id, sourceId: chunkRow.source_id ?? null, children };
    }

    const { error: doneError } = await service
        .from('import_chunks')
        .update({
            status: 'done',
            prompt_id: result.promptId,
            model: result.model,
            tokens_in: result.usage.in,
            tokens_out: result.usage.out,
            lease_until: null,
        })
        .eq('id', chunkRow.id);
    if (doneError) console.error('chunk done update failed', chunkRow.id, doneError.message);
    return null;
}

/**
 * Insert children of a split chunk. Runs sequentially (never inside the
 * parallel chunk phase) so two splits cannot race for the same idx.
 */
async function insertSplitChildren(service: Service, jobId: string, request: { parentId: string; sourceId: string | null; children: { kind?: string }[] }) {
    const { data: maxIdxRow } = await service
        .from('import_chunks')
        .select('idx')
        .eq('job_id', jobId)
        .order('idx', { ascending: false })
        .limit(1)
        .maybeSingle();
    const baseIdx = maxIdxRow?.idx ?? 0;
    const rows = request.children.map((child, offset) => ({
        job_id: jobId,
        source_id: request.sourceId,
        idx: baseIdx + offset + 1,
        parent_chunk: request.parentId,
        kind: child.kind,
        payload: child,
        status: 'queued',
    }));
    const { error } = await service.from('import_chunks').insert(rows);
    if (error) console.error('split insert failed', request.parentId, error.message);
}

/**
 * Move a job to `review` without ever overwriting a cancellation: an
 * in-flight pump used to flip a cancelled job back to `review`, so the
 * cancelled job came back as a resumable one.
 */
async function settleToReview(service: Service, jobId: string) {
    const { error } = await service
        .from('import_jobs')
        .update({ status: 'review', updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .is('cancelled_at', null)
        .neq('status', 'cancelled');
    if (error) console.error('settle to review failed', jobId, error.message);
}

async function actionPump(body: Record<string, unknown>, ctx: Context) {
    const { user, service, settingsRow, limits } = ctx;
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    let job = loaded.job;

    if (job.cancelled_at) {
        return progressPayload(ctx, job, [{ code: 'JOB_CANCELLED' }]);
    }
    if (job.status !== 'extracting') {
        if (['review', 'done', 'failed'].includes(job.status)) return progressPayload(ctx, job);
        return fail('JOB_STATE', 409);
    }

    // No local budget stops the extraction: the provider's own limits are the
    // only ones, and a provider that refuses a request says so (the error
    // reaches the user). `token_cap` stays on the job as the number the
    // progress bar shows (the model's context window), but it never cuts a
    // job short.

    let chain;
    try {
        chain = await loadReadyChain(settingsRow, String(job.id), limits);
    } catch (err) {
        const code = err instanceof SettingsError ? err.code : 'PROVIDER_NOT_READY';
        return fail(code, 409);
    }

    // Jobs created before the model-context resolver still carry the old
    // 500k fallback. Recompute it on the next pump/retry so an existing job
    // gets the same cap as a newly started one.
    if (chain[0] && job.token_cap === limits.JOB_TOKEN_CAP) {
        const contextCap = await tokenCapForPrimary(chain[0], String(job.id), limits);
        if (contextCap !== job.token_cap) {
            await service
                .from('import_jobs')
                .update({ token_cap: contextCap, updated_at: new Date().toISOString() })
                .eq('id', job.id);
            job = { ...job, token_cap: contextCap };
        }
    }

    // Cancel stops billing (spec §9.5): a light watcher aborts in-flight calls
    // when the user cancels while this pump invocation is running.
    const controller = new AbortController();
    const watcher = setInterval(async () => {
        try {
            const { data } = await service.from('import_jobs').select('cancelled_at').eq('id', job.id).maybeSingle();
            if (data?.cancelled_at) controller.abort();
        } catch {
            // Keep pumping; the next pump re-checks.
        }
    }, 2000);

    // The platform kills a function that runs too long (150 s on the free
    // plan). The pump answers before that: the chunks that did not fit are
    // re-queued and the next pump continues them.
    let deadlineHit = false;
    const deadline = setTimeout(() => {
        deadlineHit = true;
        controller.abort();
    }, limits.PUMP_DEADLINE_MS);

    const splitRequests: { parentId: string; sourceId: string | null; children: { kind?: string }[] }[] = [];
    const parallel = pumpParallelFor(chain[0]?.provider, chain[0]?.model, limits);
    // The lease must outlive the work it protects, otherwise a second worker
    // claims the same chunk while the first one is still calling the provider.
    const leaseSeconds = leaseSecondsFor(chain.length, limits);

    // The provider's per-minute budget decides how much may start now.
    const rate = rateFor(chain[0]?.provider ?? '', limits);
    const usedInWindow = await sumUsageSince(service, user.id, new Date(Date.now() - 60_000));
    const doneChunks = Math.max(1, Number(job.chunks_done ?? 0) || 1);
    const tokensPerChunk = Math.max(0, (Number(job.tokens_in ?? 0) + Number(job.tokens_out ?? 0)) / doneChunks);
    const affordable = affordableChunks({ usedInWindow, tokensPerChunk, max: parallel, rate });
    const claimLimit = Math.max(1, Math.min(parallel, affordable));
    try {
        if (usedInWindow >= rate.tokensPerMinute) {
            // The provider is full for this minute: do not call it, let the
            // window empty.
            const wait = paceMs({ usedInWindow, rate });
            const banners = [{
                code: 'PROVIDER_RATE_LIMITED',
                params: { limit: rate.tokensPerMinute },
                retryAfterMs: wait,
            }];
            return progressPayload(ctx, job, banners, { paceMs: wait });
        }
        const { data, error } = await service.rpc('import_claim_chunks', {
            p_job_id: job.id,
            p_limit: claimLimit,
            p_lease_seconds: leaseSeconds,
            p_max_attempts: limits.MAX_ATTEMPTS,
        });
        if (error) {
            console.error('claim chunks failed', job.id, error.message);
            return fail('INTERNAL', 500);
        }
        const claimed = (data ?? []) as { id: string; idx: number; payload: Record<string, unknown>; source_id?: string | null }[];
        let lastProviderFailure: {
            code: string;
            detail: string | null;
            retryAfterMs: number | null;
            model: string | null;
            provider: string | null;
            freeDaily?: OpenRouterFreeQuota | null;
        } | null = null;

        await Promise.all(claimed.map(async (row) => {
            try {
                // A photo of a note needs a model that can look at it. When
                // the chain has none, the chunk fails with an explicit
                // "no vision model" instead of a provider error the admin
                // cannot act on.
                const chunkImages = Array.isArray((row.payload as { images?: unknown })?.images)
                    ? (row.payload as { images: unknown[] }).images
                    : [];
                let chunkChain = chain;
                if (chunkImages.length > 0) {
                    chunkChain = visionEntries(chain);
                    if (chunkChain.length === 0) {
                        const detail = `No vision model in the chain (${modelList(chain) || 'no models configured'})`;
                        console.error('no vision model for an image chunk', job.id, row.id, detail);
                        await service
                            .from('import_chunks')
                            .update({ status: 'failed', error_code: 'NO_VISION_MODEL', lease_until: null })
                            .eq('id', row.id);
                        if (!lastProviderFailure) {
                            lastProviderFailure = {
                                code: 'NO_VISION_MODEL',
                                detail,
                                retryAfterMs: null,
                                model: chain[0]?.model ?? null,
                                provider: chain[0]?.provider ?? null,
                            };
                        }
                        return;
                    }
                }

                const outcome = await runChunkWithFallback({
                    chain: chunkChain,
                    run: (entry) => runChunk({
                        provider: entry.client as never,
                        chunk: row.payload,
                        hints: String(job.hints ?? ''),
                        limits,
                        yaml,
                        signal: controller.signal,
                    }),
                    signal: controller.signal,
                });
                const result = outcome.result;
                if (outcome.fallback.length > 0) {
                    console.warn('AI fallback used', job.id, row.id, outcome.attempts.map((attempt) => (
                        `${attempt.provider}/${attempt.model}:${attempt.status}${attempt.errorCode ? `/${attempt.errorCode}` : ''}`
                    )).join(' | '));
                }
                if (result.status === 'failed' && outcome.attempts.length > 1) {
                    console.error('AI chain exhausted', job.id, row.id, outcome.attempts.map((attempt) => (
                        `${attempt.provider}/${attempt.model}:${attempt.errorCode ?? 'FAILED'}`
                    )).join(' | '));
                }
                if (result.status === 'failed') {
                    // Prefer the rate-limit attempt: it is the actionable one.
                    if (!lastProviderFailure || result.errorCode === 'PROVIDER_RATE_LIMITED') {
                        lastProviderFailure = {
                            code: result.errorCode ?? 'PROVIDER_ERROR',
                            detail: result.errorDetail ?? null,
                            retryAfterMs: result.retryAfterMs ?? null,
                            model: result.model ?? null,
                            provider: chain.find((entry) => entry.model === result.model)?.provider ?? null,
                        };
                    }
                    if (result.errorDetail) {
                        console.error('chunk provider detail', job.id, row.id, result.errorDetail);
                    }
                }
                if (result.status === 'cancelled') {
                    await service
                        .from('import_chunks')
                        .update({ status: 'queued', lease_until: null })
                        .eq('id', row.id);
                    return;
                }
                const split = await persistChunkResult(ctx, job, row, result);
                if (split) splitRequests.push(split);
            } catch (err) {
                console.error('chunk failed', row.id, (err as Error)?.message);
                await service
                    .from('import_chunks')
                    .update({ status: 'failed', error_code: 'INTERNAL', lease_until: null })
                    .eq('id', row.id);
            }
        }));

        // Splits are appended after the parallel phase, one at a time.
        for (const request of splitRequests) {
            await insertSplitChildren(service, job.id as string, request);
        }

        // Persist the *why* with the job so the review banner can show the
        // provider's own 429 body instead of a generic code, including after
        // a page reload. Clear it once a later pump has no failure.
        const currentConfig = { ...(job.config ?? {}) } as Record<string, unknown>;
        if (lastProviderFailure) {
            if (lastProviderFailure.code === 'PROVIDER_RATE_LIMITED'
                && lastProviderFailure.provider === 'openrouter') {
                lastProviderFailure.freeDaily = await openRouterFreeQuota(chain);
            }
            currentConfig.last_provider_error = {
                ...lastProviderFailure,
                at: new Date().toISOString(),
            };
            await service.from('import_jobs').update({ config: currentConfig }).eq('id', job.id);
            job = { ...job, config: currentConfig };
        } else if (currentConfig.last_provider_error) {
            delete currentConfig.last_provider_error;
            await service.from('import_jobs').update({ config: currentConfig }).eq('id', job.id);
            job = { ...job, config: currentConfig };
        }
    } finally {
        clearInterval(watcher);
        clearTimeout(deadline);
    }

    await failExhausted(service, job.id, limits);

    const progress = await chunkProgress(service, job.id);
    const providerError = (job.config as Record<string, unknown> | null)?.last_provider_error as {
        code?: string;
        detail?: string | null;
        retryAfterMs?: number | null;
        model?: string | null;
        freeDaily?: OpenRouterFreeQuota | null;
    } | undefined;
    const banners: unknown[] = [];
    if (progress.queued === 0 && progress.running === 0) {
        if (progress.failed > 0) {
            const dataPolicyBlocked = providerError?.code === 'DATA_POLICY_BLOCKED'
                || /No endpoints found matching your data policy/i.test(providerError?.detail ?? '');
            banners.push({
                code: dataPolicyBlocked ? 'DATA_POLICY_BLOCKED' : 'CHUNKS_FAILED',
                params: { count: progress.failed },
                model: providerError?.model ?? chain[0]?.model ?? null,
                detail: providerError?.detail ?? null,
                retryAfterMs: providerError?.retryAfterMs ?? null,
            });
        }
        if (progress.rate_limited > 0) {
            banners.push({
                code: 'CHUNKS_RATE_LIMITED',
                params: { count: progress.rate_limited },
                model: providerError?.model ?? chain[0]?.model ?? null,
                detail: providerError?.detail ?? null,
                retryAfterMs: providerError?.retryAfterMs ?? null,
                freeDaily: providerError?.freeDaily ?? null,
            });
        }
        await settleToReview(service, job.id);
        job = { ...job, status: 'review' };
    }
    if (controller.signal.aborted && !deadlineHit) banners.push({ code: 'JOB_CANCELLED' });
    if (deadlineHit) {
        // The pump answered before the platform killed it: the chunks that
        // did not fit are re-queued and the next pump continues.
        banners.push({ code: 'PUMP_DEADLINE', params: { ms: limits.PUMP_DEADLINE_MS } });
    }

    const { data: fresh } = await service
        .from('import_jobs')
        .select('status, tokens_in, tokens_out, token_cap')
        .eq('id', job.id)
        .maybeSingle();
    // How long the client should wait before the next call: the provider's
    // per-minute budget decides.
    const usedNow = await sumUsageSince(service, user.id, new Date(Date.now() - 60_000));
    const pace = paceMs({ usedInWindow: usedNow, rate });
    return progressPayload(ctx, { ...job, ...(fresh ?? {}) }, banners, { paceMs: pace });
}

async function actionCancel(body: Record<string, unknown>, ctx: Context) {
    const { user, service } = ctx;
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    if (['done', 'cancelled'].includes(job.status)) {
        return json({ ok: true, status: job.status });
    }
    await service
        .from('import_jobs')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', job.id);
    await audit(service, user.id, 'job.cancelled', job.id);
    return json({ ok: true, status: 'cancelled' });
}

async function actionRetryChunk(body: Record<string, unknown>, ctx: Context) {
    const { user, service } = ctx;
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;

    const { data: chunk } = await service
        .from('import_chunks')
        .select('id, status')
        .eq('id', String(body.chunk_id ?? ''))
        .eq('job_id', job.id)
        .maybeSingle();
    if (!chunk) return fail('NOT_FOUND', 404);

    // Only a failed chunk can be retried. Re-running a chunk that already
    // succeeded would bill the provider again and mix the old rows with the
    // new ones.
    if (chunk.status !== 'failed') {
        return fail('CHUNK_STATE', 409);
    }

    // The retry starts from scratch: the chunk's own rows and tray entries
    // are removed so a second run cannot duplicate them.
    const { error: rowsError } = await service.from('import_rows').delete().eq('chunk_id', chunk.id);
    if (rowsError) return fail('SAVE_FAILED', 500);
    const { error: rejectsError } = await service.from('import_rejects').delete().eq('chunk_id', chunk.id);
    if (rejectsError) return fail('SAVE_FAILED', 500);

    const { error: resetError } = await service
        .from('import_chunks')
        .update({ status: 'queued', attempts: 0, error_code: null, lease_until: null })
        .eq('id', chunk.id);
    if (resetError) return fail('SAVE_FAILED', 500);
    if (['review', 'failed'].includes(job.status)) {
        await service
            .from('import_jobs')
            .update({ status: 'extracting', updated_at: new Date().toISOString() })
            .eq('id', job.id)
            .is('cancelled_at', null);
    }
    return json({ ok: true, status: 'extracting' });
}

async function actionAddRow(body: Record<string, unknown>, ctx: Context) {
    const { user, service } = ctx;
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    if (job.status !== 'review') return fail('JOB_STATE', 409);

    const { data: last } = await service
        .from('import_rows')
        .select('seq')
        .eq('job_id', job.id)
        .order('seq', { ascending: false })
        .limit(1)
        .maybeSingle();
    const seq = (last?.seq ?? 0) + 1;

    // The client cannot insert rows (RLS), so the function builds the manual
    // row through the same pipeline — validation, derivations and the job's
    // bulk defaults apply; grounding does not (nothing to ground against).
    const config = (job.config ?? {}) as { enum_snapshot?: object; defaults?: object };
    const pipeline = runPipeline({
        records: [{}],
        sourceId: 'MANUAL',
        kind: 'text',
        lines: [],
        snapshot: config.enum_snapshot ?? {},
        today: todayIso(),
        defaults: config.defaults ?? {},
        requireSection: false,
        ground: false,
    });
    const row = pipeline.rows[0];

    const { data: inserted, error } = await service
        .from('import_rows')
        .insert({
            job_id: job.id,
            chunk_id: null,
            seq,
            src: [],
            extracted: null,
            cells: row.cells,
            issues: row.issues,
            status: row.status,
        })
        .select()
        .single();
    if (error || !inserted) return fail('INTERNAL', 500);
    return json({ ok: true, row: inserted });
}

/** Feature flag read: any signed-in user may ask; it exposes only the switch. */
function actionEnabled(ctx: Context) {
    return json({ enabled: ctx.settingsRow?.enabled === true });
}

async function actionStatus(body: Record<string, unknown>, ctx: Context) {
    const { user, service } = ctx;
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    const banners: unknown[] = [];
    if (job.cancelled_at) banners.push({ code: 'JOB_CANCELLED' });
    const caps = (job.tokens_in ?? 0) + (job.tokens_out ?? 0);
    if (job.token_cap && caps >= job.token_cap) banners.push({ code: 'JOB_TOKEN_CAP', params: { limit: job.token_cap } });
    const progress = await chunkProgress(service, job.id);
    const providerError = (job.config as Record<string, unknown> | null)?.last_provider_error as {
        code?: string;
        detail?: string | null;
        retryAfterMs?: number | null;
        model?: string | null;
        freeDaily?: OpenRouterFreeQuota | null;
    } | undefined;
    if (progress.failed > 0) {
        const dataPolicyBlocked = providerError?.code === 'DATA_POLICY_BLOCKED'
            || /No endpoints found matching your data policy/i.test(providerError?.detail ?? '');
        banners.push({
            code: dataPolicyBlocked ? 'DATA_POLICY_BLOCKED' : 'CHUNKS_FAILED',
            params: { count: progress.failed },
            model: providerError?.model ?? null,
            detail: providerError?.detail ?? null,
            retryAfterMs: providerError?.retryAfterMs ?? null,
        });
    }
    if (progress.rate_limited > 0) {
        banners.push({
            code: 'CHUNKS_RATE_LIMITED',
            params: { count: progress.rate_limited },
            model: providerError?.model ?? null,
            detail: providerError?.detail ?? null,
            retryAfterMs: providerError?.retryAfterMs ?? null,
            freeDaily: providerError?.freeDaily ?? null,
        });
    }
    return progressPayload(ctx, job, banners);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
    if (req.method !== 'POST') return fail('BAD_REQUEST', 405);
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) return fail('INTERNAL', 500);

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return fail('BAD_REQUEST');
    }
    const action = String(body.action ?? '');

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
        auth: { persistSession: false },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return fail('UNAUTHORIZED', 401);

    const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    const [{ data: settingsRow }, { data: importSettings }] = await Promise.all([
        service.from('ai_settings').select('*').eq('id', true).maybeSingle(),
        service.from('import_settings').select('limits').eq('id', true).maybeSingle(),
    ]);
    let limits = LIMITS;
    try {
        limits = resolveLimits((importSettings?.limits ?? {}) as Record<string, unknown>);
    } catch {
        limits = LIMITS;
    }

    const ctx: Context = { user: { id: user.id }, service, settingsRow: settingsRow ?? null, limits };

    try {
        switch (action) {
            case 'create': return await actionCreate(body, ctx);
            case 'add_source': return await actionAddSource(body, ctx);
            case 'start': return await actionStart(body, ctx);
            case 'pump': return await actionPump(body, ctx);
            case 'cancel': return await actionCancel(body, ctx);
            case 'status': return await actionStatus(body, ctx);
            case 'retry_chunk': return await actionRetryChunk(body, ctx);
            case 'add_row': return await actionAddRow(body, ctx);
            case 'enabled': return actionEnabled(ctx);
            default: return fail('BAD_REQUEST');
        }
    } catch (err) {
        console.error('import-job failed', action, (err as Error)?.message);
        return fail('INTERNAL', 500);
    }
});
