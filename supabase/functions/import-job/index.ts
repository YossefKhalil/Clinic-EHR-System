// import-job — the extraction pump (design spec §9.5, §14.3).
//
// Actions: create | add_source | start | pump | cancel | status | retry_chunk |
// add_row. The browser calls `pump` in a loop; each call claims chunks under a
// lease (import_claim_chunks), runs them through the provider in parallel,
// writes rows through the shared import-core pipeline, and returns progress.
//
// Nothing PHI leaves this function except through the provider call itself:
// responses carry counts, labels and codes — never patient values.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import yaml from 'https://esm.sh/js-yaml@4.1.0';
import { LIMITS, resolveLimits } from '../_shared/import-core/limits.js';
import { prepareSources, shiftSourceIds, splitChunkPayload } from '../_shared/import-core/chunker.js';
import { runPipeline } from '../_shared/import-core/pipeline.js';
import { PROMPT_IDS } from '../_shared/import-core/yaml-contract.js';
import { readAiSettings, SettingsError } from '../_shared/ai-settings.ts';
import { createOpenRouterProvider } from '../_shared/llm/openrouter.ts';
import { createCloudflareProvider } from '../_shared/llm/cloudflare.ts';
import { createOpenAiCompatibleProvider } from '../_shared/llm/openai-compatible.ts';
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

function fail(code: string, status = 400): Response {
    return json({ ok: false, code, message_key: `importAgent.error.${code}` }, status);
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
function buildProvider(credentials: { provider: string; model: string; apiKey: string | null; accountId: string | null; baseUrl: string | null }) {
    if (credentials.provider === 'openrouter') {
        return createOpenRouterProvider({
            apiKey: credentials.apiKey ?? '',
            model: credentials.model,
            appTitle: 'Clinic EHR import agent',
        });
    }
    if (credentials.provider === 'cloudflare') {
        return createCloudflareProvider({
            accountId: credentials.accountId ?? '',
            apiKey: credentials.apiKey ?? '',
            model: credentials.model,
        });
    }
    return createOpenAiCompatibleProvider({
        baseUrl: credentials.baseUrl ?? '',
        apiKey: credentials.apiKey,
        model: credentials.model,
    });
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

async function sumUsageToday(service: Service, userId: string): Promise<number> {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const { data } = await service
        .from('ai_usage')
        .select('tokens_in, tokens_out')
        .eq('user_id', userId)
        .gte('created_at', dayStart.toISOString());
    let total = 0;
    for (const row of data ?? []) total += (row.tokens_in ?? 0) + (row.tokens_out ?? 0);
    return total;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Context = {
    user: { id: string };
    service: Service;
    settingsRow: Record<string, unknown> | null;
    limits: typeof LIMITS;
};

async function actionCreate(body: Record<string, unknown>, ctx: Context) {
    const { user, service, settingsRow, limits } = ctx;
    const hints = String(body.hints ?? '');
    if (hints.length > limits.MAX_HINT_CHARS) return fail('HINTS_TOO_LONG');

    const sourcesMeta = Array.isArray(body.sources_meta) ? body.sources_meta : [];
    if (sourcesMeta.length === 0 || sourcesMeta.length > limits.MAX_FILES) return fail('BAD_REQUEST');

    if (!settingsRow || settingsRow.enabled !== true) return fail('FEATURE_DISABLED', 403);

    // Rate limits (spec §13.5): concurrent jobs, jobs per day.
    const { data: active } = await service
        .from('import_jobs')
        .select('id')
        .eq('created_by', user.id)
        .in('status', ['extracting', 'committing']);
    if ((active?.length ?? 0) >= limits.MAX_CONCURRENT_JOBS) {
        await audit(service, user.id, 'job.rejected', 'n/a', { code: 'TOO_MANY_JOBS' });
        return fail('TOO_MANY_JOBS', 429);
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await service
        .from('import_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('created_by', user.id)
        .gte('created_at', since);
    if ((count ?? 0) >= limits.JOBS_PER_USER_DAY) {
        await audit(service, user.id, 'job.rejected', 'n/a', { code: 'JOBS_PER_DAY' });
        return fail('JOBS_PER_DAY', 429);
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

function validateChunkPayload(payload: unknown): payload is { kind?: string; lines: { id: string; text: string }[] } {
    const chunk = payload as { lines?: unknown };
    if (!chunk || !Array.isArray(chunk.lines) || chunk.lines.length === 0) return false;
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
    const { user, service } = ctx;
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    if (job.status !== 'uploaded') return fail('JOB_STATE', 409);

    const { count } = await service
        .from('import_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', job.id);
    if (!count) return fail('NO_CHUNKS');

    await service.from('import_jobs').update({ status: 'extracting', updated_at: new Date().toISOString() }).eq('id', job.id);
    return json({ ok: true, status: 'extracting', chunks_total: count });
}

async function chunkProgress(service: Service, jobId: string) {
    const { data: chunks } = await service
        .from('import_chunks')
        .select('idx, status, attempts, lease_until, truncated')
        .eq('job_id', jobId)
        .order('idx');
    const progress = {
        total: 0, done: 0, failed: 0, queued: 0, running: 0, split: 0,
        truncated: 0, next_label: null as string | null,
    };
    const now = Date.now();
    for (const chunk of chunks ?? []) {
        progress.total += 1;
        if (chunk.status === 'done' || chunk.status === 'split') progress.done += 1;
        else if (chunk.status === 'failed') progress.failed += 1;
        else if (chunk.status === 'running') progress.running += 1;
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

async function progressPayload(ctx: Context, job: Record<string, unknown>, banners: unknown[] = []) {
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

    if (result.status === 'failed') {
        await service
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
        return null;
    }

    // Stages 5–6 in the shared pipeline (spec §8): the same code the browser
    // reruns on every cell edit.
    const lineRecords = lines.map((line: { id: string; text: string }) => ({ id: line.id, text: line.text }));
    const chunkLineIds = lineRecords.map((line: { id: string }) => line.id);
    const extractedByIndex = new Map(result.documents.map((doc) => [doc.index, doc.record]));
    const pipeline = runPipeline({
        records: result.documents.map((doc) => ({ ...doc.record, _chunkIndex: doc.index })),
        sourceId: (payload.source_id as string) ?? 'S1',
        kind: payload.kind === 'sheet' ? 'sheet' : 'text',
        lines: lineRecords,
        chunkLineIds,
        dataLineIds: payload.kind === 'sheet' ? chunkLineIds : null,
        snapshot: (job.config as { enum_snapshot?: object })?.enum_snapshot ?? {},
        today: todayIso(),
        defaults: (job.config as { defaults?: object })?.defaults ?? {},
        requireSection: false,
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
        await service.from('import_rows').upsert(rowPayload, { onConflict: 'chunk_id,seq', ignoreDuplicates: true });
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
        await service.from('import_rejects').insert(trayPayload);
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
        await service.from('import_rejects').insert(unmappedPayload);
    }

    const usageRecord = {
        user_id: job.created_by,
        job_id: job.id,
        chunk_id: chunkRow.id,
        model: result.model,
        tokens_in: result.usage.in,
        tokens_out: result.usage.out,
        cost_est: result.cost ?? null,
    };
    if (result.usage.in > 0 || result.usage.out > 0 || result.cost != null) {
        await service.rpc('import_bump_tokens', { p_job_id: job.id, p_in: result.usage.in, p_out: result.usage.out });
        await service.from('ai_usage').insert(usageRecord);
    }

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

    await service
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

    // Caps before any call (spec §9.5): job token cap stops extraction.
    const tokens = (job.tokens_in ?? 0) + (job.tokens_out ?? 0);
    if (job.token_cap && tokens >= job.token_cap) {
        await service.from('import_jobs').update({ status: 'review', updated_at: new Date().toISOString() }).eq('id', job.id);
        job = { ...job, status: 'review' };
        return progressPayload(ctx, job, [{ code: 'JOB_TOKEN_CAP', params: { limit: job.token_cap } }]);
    }
    const dailyTokens = await sumUsageToday(service, user.id);
    if (dailyTokens >= limits.USER_DAILY_TOKEN_CAP) {
        return progressPayload(ctx, job, [{
            code: 'USER_DAILY_TOKEN_CAP',
            params: { limit: limits.USER_DAILY_TOKEN_CAP },
        }]);
    }

    let provider;
    try {
        provider = buildProvider(await readAiSettings(settingsRow as never, Deno.env.get('AI_SETTINGS_ENC_KEY') ?? ''));
    } catch (err) {
        const code = err instanceof SettingsError ? err.code : 'PROVIDER_NOT_READY';
        return fail(code, 409);
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

    const splitRequests: { parentId: string; sourceId: string | null; children: { kind?: string }[] }[] = [];
    try {
        const { data, error } = await service.rpc('import_claim_chunks', {
            p_job_id: job.id,
            p_limit: limits.PUMP_PARALLEL,
            p_lease_seconds: limits.LEASE_SECONDS,
            p_max_attempts: limits.MAX_ATTEMPTS,
        });
        if (error) return fail('INTERNAL', 500);
        const claimed = (data ?? []) as { id: string; idx: number; payload: Record<string, unknown>; source_id?: string | null }[];

        await Promise.all(claimed.map(async (row) => {
            try {
                const result = await runChunk({
                    provider: provider as never,
                    chunk: row.payload,
                    hints: String(job.hints ?? ''),
                    limits,
                    yaml,
                    signal: controller.signal,
                });
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
    } finally {
        clearInterval(watcher);
    }

    await failExhausted(service, job.id, limits);

    const progress = await chunkProgress(service, job.id);
    const banners: unknown[] = [];
    if (progress.queued === 0 && progress.running === 0) {
        if (progress.failed > 0) banners.push({ code: 'CHUNKS_FAILED', params: { count: progress.failed } });
        await service.from('import_jobs').update({ status: 'review', updated_at: new Date().toISOString() }).eq('id', job.id);
        job = { ...job, status: 'review' };
    }
    if (controller.signal.aborted) banners.push({ code: 'JOB_CANCELLED' });

    const { data: fresh } = await service
        .from('import_jobs')
        .select('status, tokens_in, tokens_out, token_cap')
        .eq('id', job.id)
        .maybeSingle();
    return progressPayload(ctx, { ...job, ...(fresh ?? {}) }, banners);
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

    await service
        .from('import_chunks')
        .update({ status: 'queued', attempts: 0, error_code: null, lease_until: null })
        .eq('id', chunk.id);
    if (['review', 'failed'].includes(job.status)) {
        await service.from('import_jobs').update({ status: 'extracting', updated_at: new Date().toISOString() }).eq('id', job.id);
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

async function actionStatus(body: Record<string, unknown>, ctx: Context) {
    const { user, service } = ctx;
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    const banners: unknown[] = [];
    if (job.cancelled_at) banners.push({ code: 'JOB_CANCELLED' });
    const caps = (job.tokens_in ?? 0) + (job.tokens_out ?? 0);
    if (job.token_cap && caps >= job.token_cap) banners.push({ code: 'JOB_TOKEN_CAP', params: { limit: job.token_cap } });
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
            default: return fail('BAD_REQUEST');
        }
    } catch (err) {
        console.error('import-job failed', action, (err as Error)?.message);
        return fail('INTERNAL', 500);
    }
});
