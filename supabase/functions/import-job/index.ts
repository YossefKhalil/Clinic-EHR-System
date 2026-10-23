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
import { LIMITS, LOCAL_RUNTIME_BOUNDS, leaseSecondsFor, pumpParallelFor, resolveLimits } from '../_shared/import-core/limits.js';
import { isValidChunkPayload } from '../_shared/import-core/chunk-payload.ts';
import { prepareSources, shiftSourceIds, splitChunkPayload } from '../_shared/import-core/chunker.js';
import { runPipeline } from '../_shared/import-core/pipeline.js';
import { PROMPT_IDS } from '../_shared/import-core/yaml-contract.js';
import { readAiChain, chainFromRow, engineOf, localInferenceEnabled, SettingsError, type AiSettingsRow } from '../_shared/ai-settings.ts';
import {
    clampLocalConfig,
    isDeterministicLocalError,
    localConfigDrift,
    localModelIdentity,
    normalizeLocalIdentity,
    normalizeLocalProfile,
    sameLocalModel,
} from '../_shared/import-core/local-runtime.js';
import { createOpenRouterProvider } from '../_shared/llm/openrouter.ts';
import { createCloudflareProvider } from '../_shared/llm/cloudflare.ts';
import { createOpenAiCompatibleProvider } from '../_shared/llm/openai-compatible.ts';
import { runChunkWithFallback } from '../_shared/llm/fallback.js';
import { modelList, visionEntries } from '../_shared/llm/vision.ts';
import { affordableChunks, paceMs, rateFor } from '../_shared/llm/provider-rate.ts';
import { jobTokenCapForContext, resolveModelContext } from '../_shared/llm/model-context.ts';
import { runChunk } from '../import-extract/run-chunk.js';
import { buildRecord, planRow } from '../_shared/import-core/commit-plan.js';
import { nameDobKey } from '../_shared/import-core/dedupe.js';

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

/** A plain object, or an empty one. The client is not trusted. */
function objectAt(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
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

    const inferenceMode = body.inference_mode === 'local' ? 'local' : 'cloud';
    const localEnabled = localInferenceEnabled();

    const sourcesMeta = Array.isArray(body.sources_meta) ? body.sources_meta : [];
    if (sourcesMeta.length === 0 || sourcesMeta.length > limits.MAX_FILES) return fail('BAD_REQUEST');

    // The engine must be the one the clinic selected. A job runs in the mode
    // that was active when it was created, never in a mode that was switched
    // on later.
    if (inferenceMode === 'local') {
        if (!localEnabled) return fail('LOCAL_MODE_DISABLED', 403);
        if (!settingsRow || settingsRow.enabled !== true) return fail('FEATURE_DISABLED', 403);
        if (engineOf(settingsRow) !== 'local') return fail('ENGINE_MISMATCH', 409);
    } else {
        if (!settingsRow || settingsRow.enabled !== true) return fail('FEATURE_DISABLED', 403);
        if (engineOf(settingsRow) !== 'cloud') return fail('ENGINE_MISMATCH', 409);
    }

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

    // The resolved local setup travels with the job, so a resume or a second
    // tab cannot run the job with a different model or a different context
    // window than the one it started with. The client is not trusted: the
    // profile and the config are normalized here, not at the place that sent
    // them.
    const localProfile = inferenceMode === 'local'
        ? normalizeLocalProfile(objectAt(body.local_profile ?? settingsRow?.local_profile))
        : null;
    // Only a config the browser actually resolved is a baseline. Falling
    // back to the raw saved overrides would store a config the browser never
    // ran, and the first claim would look like drift.
    const sentLocalConfig = objectAt(body.local_config);
    const localConfig = inferenceMode === 'local' && Object.keys(sentLocalConfig).length > 0
        ? clampLocalConfig(sentLocalConfig)
        : null;

    const config = {
        prompt_ids: PROMPT_IDS,
        defaults: body.defaults ?? {},
        enum_snapshot: enumSnapshot,
        inference_mode: inferenceMode,
        provider: (inferenceMode === 'local' || !settingsRow)
            ? null
            : { provider: settingsRow.provider, model: settingsRow.model },
        model_chain: (inferenceMode === 'local' || !settingsRow) ? [] : chainFromRow(settingsRow),
        limits,
        local_models: inferenceMode === 'local'
            ? {
                profile: localProfile,
                config: localConfig ?? {},
                // The model that produced the records is part of the job, not
                // a claim by the client: a resume with another file is
                // refused instead of mixing two models in one import.
                model: localModelIdentity(localProfile),
            }
            : null,
    };

    const { data: job, error } = await service
        .from('import_jobs')
        .insert({
            created_by: user.id,
            section: body.section ?? null,
            status: 'uploaded',
            config,
            hints,
            token_cap: inferenceMode === 'local' ? 0 : limits.JOB_TOKEN_CAP,
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
        if (!isValidChunkPayload(chunk)) return fail('BAD_REQUEST');
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

    const cfg = (job.config ?? {}) as Record<string, unknown>;
    const isLocal = cfg.inference_mode === 'local';

    // Preflight the real chain before marking the job as extracting (cloud only).
    if (!isLocal) {
        let chain;
        try {
            chain = await loadReadyChain(settingsRow, String(job.id), limits);
        } catch (err) {
            const code = err instanceof SettingsError ? err.code : 'PROVIDER_NOT_READY';
            return fail(code, 409);
        }
        const primary = chain[0];
        if (!primary) return fail('NOT_CONFIGURED', 409);
        const tokenCap = await tokenCapForPrimary(primary, String(job.id), limits);
        await service
            .from('import_jobs')
            .update({ status: 'extracting', token_cap: tokenCap, updated_at: new Date().toISOString() })
            .eq('id', job.id);
        return json({ ok: true, status: 'extracting', chunks_total: count, token_cap: tokenCap });
    }

    // The local engine. The deployment flag and the clinic's own engine
    // choice must both allow it, and the browser must have picked a model.
    if (!localInferenceEnabled()) return fail('LOCAL_MODE_DISABLED', 403);
    if (!settingsRow || settingsRow.enabled !== true) return fail('FEATURE_DISABLED', 403);
    if (engineOf(settingsRow) !== 'local') return fail('ENGINE_MISMATCH', 409);
    const localModels = objectAt(cfg.local_models);
    const profile = normalizeLocalProfile(objectAt(localModels.profile));
    const identity = localModelIdentity(profile);
    // The split layout only needs its text model; the vision model is
    // optional until a photo arrives. The identity therefore names the text
    // model (and carries the vision model when one is configured).
    if (!identity.name) return fail('LOCAL_MODEL_NOT_CONFIGURED', 409);

    // A job created before the identity was stored gets it here, so every
    // later claim compares against the same baseline. The resolved config is
    // not invented on the server: only the browser knows its device tier.
    const nextConfig = {
        ...cfg,
        local_models: {
            ...localModels,
            profile,
            model: identity,
        },
    };

    // The local engine has no token budget: the cap is 0 and the interface
    // shows no token bar.
    await service
        .from('import_jobs')
        .update({
            status: 'extracting',
            token_cap: 0,
            config: nextConfig,
            updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    return json({ ok: true, status: 'extracting', chunks_total: count, token_cap: 0 });
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
async function failExhausted(service: Service, jobId: string, limits: typeof LIMITS, maxAttempts: number = limits.MAX_ATTEMPTS) {
    const now = new Date().toISOString();
    const { data: chunks } = await service
        .from('import_chunks')
        .select('id, status, attempts, lease_until')
        .eq('job_id', jobId)
        .lt('attempts', maxAttempts + 1);
    const stuck = (chunks ?? []).filter((chunk) => {
        if (chunk.status === 'queued') return false; // still claimable
        if (chunk.status !== 'running') return false;
        const expired = !chunk.lease_until || chunk.lease_until < now;
        return expired && chunk.attempts >= maxAttempts;
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
    options: {
        pipelineKind?: 'text' | 'sheet' | 'image';
        replaceRejects?: boolean;
        /** The model the job froze; local results are audited against it. */
        modelIdentity?: { name?: string; sha256?: string } | null;
    } = {},
) {
    const { service } = ctx;
    const payload = chunkRow.payload ?? {};
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const effectiveKind = options.pipelineKind ?? (payload.kind as string | undefined);
    // Local mode sends the identity of the loaded file with every submit. The
    // name and the hash are stored beside the chunk, so a review can tell
    // which model read these rows even after the clinic replaces the file.
    const modelName = options.modelIdentity?.name ?? result.model;
    const modelSha256 = options.modelIdentity?.sha256 ?? null;

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
                model: modelName,
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
                model: modelName,
                model_sha256: modelSha256,
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
    const isImage = effectiveKind === 'image';
    const pipeline = runPipeline({
        records: result.documents.map((doc) => ({ ...doc.record, _chunkIndex: doc.index })),
        sourceId: (payload.source_id as string) ?? 'S1',
        kind: effectiveKind === 'sheet' ? 'sheet' : isImage ? 'image' : 'text',
        lines: lineRecords,
        chunkLineIds,
        dataLineIds: effectiveKind === 'sheet' ? chunkLineIds : null,
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

    // The tray holds the rejects of the chunk's latest attempt. When the
    // chunk is submitted again, the previous entries are dropped first, so a
    // repeated submit leaves the same tray as the first one.
    if (options.replaceRejects) {
        const { error: oldTrayError } = await service
            .from('import_rejects')
            .delete()
            .eq('chunk_id', chunkRow.id);
        if (oldTrayError) console.error('import_rejects delete failed', chunkRow.id, oldTrayError.message);
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
                    model: modelName,
                    model_sha256: modelSha256,
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
                model: modelName,
                model_sha256: modelSha256,
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
            model: modelName,
            model_sha256: modelSha256,
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

    const jobCfg = (job.config ?? {}) as Record<string, unknown>;
    if (jobCfg.inference_mode === 'local') return fail('LOCAL_MODE_REQUIRED', 409);

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

/**
 * The commit (spec §11): the reviewed rows become patients.
 *
 * The browser's verdict is not trusted: the plan is rebuilt here with the
 * shared rules engine over the stored rows, and the write happens in one
 * transaction (the `import_commit` RPC).
 */
async function actionCommit(body: Record<string, unknown>, ctx: Context) {
  try {
    return await commitAction(body, ctx);
  } catch (err) {
    // The user must see WHY the commit failed, not "something went wrong".
    const detail = String((err as Error)?.message ?? err ?? '').slice(0, 200);
    console.error('commit failed', (err as Error)?.message, (err as Error)?.stack);
    return fail('COMMIT_FAILED', 500, { detail });
  }
}

async function commitAction(body: Record<string, unknown>, ctx: Context) {
    const { user, service, limits } = ctx;
    const jobId = String(body.job_id ?? '');
    const loaded = await loadJobForUser(service, user.id, jobId);
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    if (job.status !== 'review') return fail('JOB_STATE', 409);

    // The key makes a retry of the same commit a no-op instead of a second
    // batch of patients.
    const commitKey = String(body.commit_key ?? '');
    if (!/^[0-9a-fA-F-]{36}$/.test(commitKey)) return fail('BAD_REQUEST');

    const [{ data: chunkRows }, { data: rowRows }] = await Promise.all([
        service.from('import_chunks').select('*').eq('job_id', job.id).order('idx'),
        service.from('import_rows').select('*').eq('job_id', job.id).order('seq'),
    ]);
    const chunks = chunkRows ?? [];
    const rows = rowRows ?? [];
    if (rows.length === 0) return fail('NO_CHUNKS');

    // The patients that already exist: the existence context the rules
    // engine needs (a national id that is taken is a duplicate).
    const nids = [...new Set(rows
        .map((row) => String((row as { cells?: Record<string, { value?: unknown }> }).cells?.national_id?.value ?? ''))
        .filter((value) => /^\d{14}$/.test(value)))].slice(0, 500);
    const existing = new Map<string, { visible: boolean }>();
    const nameDobMatches = new Set<string>();
    if (nids.length > 0) {
        const { data: patients } = await service
            .from('patients')
            .select('id, national_id, name, date_of_birth')
            .in('national_id', nids);
        for (const patient of patients ?? []) {
            existing.set(String(patient.national_id), { visible: true });
            const key = nameDobKey(patient.name, patient.date_of_birth);
            if (key) nameDobMatches.add(key);
        }
    }

    const config = (job.config ?? {}) as { enum_snapshot?: object; defaults?: object };
    const jobSection = String(job.section ?? '') || null;
    const byChunk = new Map<string, typeof rows>();
    for (const row of rows) {
        const key = String((row as { chunk_id?: string | null }).chunk_id ?? 'MANUAL');
        if (!byChunk.has(key)) byChunk.set(key, []);
        byChunk.get(key)!.push(row as never);
    }

    const plan: unknown[] = [];
    for (const [chunkId, group] of byChunk) {
        const chunk = chunks.find((entry) => entry.id === chunkId);
        const payload = (chunk?.payload ?? {}) as { lines?: { id: string; text: string }[]; kind?: string; source_id?: string };
        const lines = Array.isArray(payload.lines) ? payload.lines : [];
        const lineRecords = lines.map((line) => ({
            id: line.id,
            text: line.text,
            canonical: line.canonical,
        }));
        const isImage = payload.kind === 'image';
        const outcome = runPipeline({
            records: group.map((row) => buildRecord(row as never)),
            sourceId: payload.source_id ?? 'S1',
            kind: payload.kind === 'sheet' ? 'sheet' : isImage ? 'image' : 'text',
            lines: lineRecords,
            chunkLineIds: lineRecords.map((line) => line.id),
            dataLineIds: payload.kind === 'sheet' ? lineRecords.map((line) => line.id) : null,
            snapshot: config.enum_snapshot ?? {},
            today: todayIso(),
            defaults: config.defaults ?? {},
            existing,
            nameDobMatches,
            // The section comes from the row or, when the job picked one, from
            // the job. A missing section is not an error: the clinic may file
            // a patient without one.
            requireSection: false,
            ground: !isImage,
            keepPhantoms: true,
        });
        outcome.rows.forEach((fresh, index) => {
            const stored = group[index] as {
                id: string; seq: number; chunk_id: string | null; dup: unknown; acknowledged: string[] | null; extracted: unknown;
            } | undefined;
            if (!stored) {
                // The rules engine returned more rows than the group has:
                // that must never write a patient.
                console.error('commit: the pipeline returned more rows than the group', job.id, chunkId, index);
                return;
            }
            const row = {
                ...fresh,
                id: stored.id,
                seq: stored.seq,
                chunk_id: stored.chunk_id,
                extracted: stored.extracted,
                acknowledged: stored.acknowledged ?? [],
                // The reviewer's duplicate decision wins over the pipeline's.
                dup: (stored.dup as { kind?: string; action?: string } | null)
                    ? { ...(stored.dup as object), kind: (fresh.dup as { kind?: string } | null)?.kind ?? (stored.dup as { kind?: string }).kind }
                    : fresh.dup,
            };
            const entry = planRow(row as never) as { values: Record<string, unknown> };
            if (!entry.values.section && jobSection) entry.values.section = jobSection;
            plan.push(entry);
        });
    }

    const { data: result, error } = await service.rpc('import_commit', {
        p_job_id: job.id,
        p_commit_key: commitKey,
        p_actor: user.id,
        p_rows: plan,
        p_meta: { section: jobSection },
    });
    if (error) {
        console.error('import_commit failed', job.id, error.message);
        // The database's own message: "the patients could not be written
        // (column ... violates not-null constraint)" beats "something went
        // wrong".
        return fail('COMMIT_FAILED', 500, { detail: String(error.message ?? '').slice(0, 200) });
    }

    const summary = (result ?? {}) as { created?: number; filled?: number; skipped?: number; idempotent?: boolean };
    await audit(service, user.id, 'job.committed', job.id, {
        created: summary.created ?? 0,
        filled: summary.filled ?? 0,
        skipped: summary.skipped ?? 0,
        batch_id: (result as { batch_id?: string } | null)?.batch_id ?? null,
    });
    return json({
        ok: true,
        job_id: job.id,
        created: summary.created ?? 0,
        filled: summary.filled ?? 0,
        skipped: summary.skipped ?? 0,
        idempotent: summary.idempotent === true,
    });
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
    return json({
        enabled: ctx.settingsRow?.enabled === true,
        // Which engine the card shows.
        engine: engineOf(ctx.settingsRow),
        local_enabled: localInferenceEnabled(),
        // The local setup the clinic saved: the names and the hashes of the
        // models, and the runtime settings. The files stay in the browser.
        local_profile: objectAt(ctx.settingsRow?.local_profile),
        local_config: clampLocalConfig(objectAt(ctx.settingsRow?.local_config)),
    });
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
// Local inference actions (browser-side models, server-side persistence)
// ---------------------------------------------------------------------------

/** The local runtime settings the job was started with. */
function localRuntimeFor(job: Record<string, unknown>) {
    const config = (job.config ?? {}) as Record<string, unknown>;
    const models = (config.local_models ?? null) as { config?: unknown } | null;
    return clampLocalConfig((models?.config ?? {}) as Record<string, unknown>);
}

/** The model identity and the resolved config frozen into a local job. */
function localJobFor(job: Record<string, unknown>) {
    const config = objectAt(job.config);
    const models = objectAt(config.local_models);
    const profile = objectAt(models.profile);
    const stored = objectAt(models.model);
    return {
        config: objectAt(models.config),
        profile,
        // A job created before the identity was stored still has the profile;
        // build the same identity from it rather than refusing the job.
        model: Object.keys(stored).length > 0
            ? normalizeLocalIdentity(stored)
            : localModelIdentity(profile),
    };
}

/**
 * Why this claim or submit must be refused: the model or the text/OCR
 * settings the browser is about to use are not the ones the job started
 * with. `null` when they agree.
 */
function localDrift(job: Record<string, unknown>, body: Record<string, unknown>) {
    const local = localJobFor(job);
    const incomingModel = objectAt(body.model);
    if (Object.keys(incomingModel).length > 0
        && !sameLocalModel(local.model, normalizeLocalIdentity(incomingModel))) {
        return { kind: 'model' as const, model: local.model };
    }
    const incomingConfig = objectAt(body.config);
    if (Object.keys(incomingConfig).length > 0 && localConfigDrift(local.config, incomingConfig)) {
        return { kind: 'config' as const, model: local.model };
    }
    return null;
}

function driftResponse(drift: { kind: 'model' | 'config'; model?: { name?: string } }) {
    return fail('CONFIG_DRIFT', 409, {
        kind: drift.kind,
        model: drift.model?.name ?? null,
    });
}

/**
 * The result of one chunk, before it is trusted.
 *
 * The shape is the same one `runChunk` returns; the check is deliberately
 * structural. The server cannot re-run the model, so it ensures the parts
 * the pipeline indexes (`documents[].index`, `rejected[].error`) are there
 * and refuses anything that would throw halfway through persistence.
 */
function isValidLocalResult(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const result = value as Record<string, unknown>;
    if (!['ok', 'truncated', 'failed'].includes(String(result.status ?? ''))) return false;
    if (!Array.isArray(result.documents) || !Array.isArray(result.rejected)) return false;
    if (result.documents.length > 10_000 || result.rejected.length > 10_000) return false;
    for (const entry of result.documents) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const doc = entry as Record<string, unknown>;
        if (!Number.isInteger(doc.index) || !doc.record
            || typeof doc.record !== 'object' || Array.isArray(doc.record)) return false;
    }
    for (const entry of result.rejected) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        if (typeof (entry as Record<string, unknown>).error !== 'string') return false;
    }
    if (result.usage !== undefined) {
        const usage = result.usage as Record<string, unknown> | null;
        if (!usage || typeof usage !== 'object'
            || typeof usage.in !== 'number' || typeof usage.out !== 'number') return false;
    }
    return true;
}

/** A lease timestamp from the client, or an empty string. */
function leaseToken(body: Record<string, unknown>) {
    return typeof body.lease_expires_at === 'string' ? body.lease_expires_at : '';
}

/** True when the claim in `body` still owns the chunk row. */
function ownsLease(chunk: { lease_until?: string | null }, body: Record<string, unknown>) {
    const token = leaseToken(body);
    if (token && token !== chunk.lease_until) return false;
    return Boolean(chunk.lease_until) && Date.parse(String(chunk.lease_until)) > Date.now();
}

/** The number of attempts a local chunk gets before it is given up on. */
function localMaxAttempts(job: Record<string, unknown>) {
    return localRuntimeFor(job).runtime.maxAttempts;
}

async function actionLocalClaim(body: Record<string, unknown>, ctx: Context) {
    const { user, service, limits } = ctx;
    if (!localInferenceEnabled()) return fail('LOCAL_MODE_DISABLED', 403);
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    if (job.status !== 'extracting') {
        if (['review', 'done', 'failed'].includes(job.status)) return json({ ok: true, done: true, status: job.status });
        return fail('JOB_STATE', 409);
    }
    if (job.cancelled_at) return json({ ok: true, done: true, status: 'cancelled' });

    const cfg = (job.config ?? {}) as Record<string, unknown>;
    if (cfg.inference_mode !== 'local') return fail('LOCAL_MODE_REQUIRED', 409);

    // Resume safety: the browser may have reloaded with another model or
    // changed the context/OCR settings since the job started. Refuse the
    // claim instead of mixing two model identities in one import.
    const drift = localDrift(job, body);
    if (drift) return driftResponse(drift);

    // The browser owns the runtime config; the server only clamps the lease
    // and the attempt count to the shared bounds. Local mode has no token cap.
    const bounds = LOCAL_RUNTIME_BOUNDS;
    const runtime = localRuntimeFor(job).runtime;
    const requestedLease = Number(body.lease_seconds ?? runtime.leaseSeconds);
    const leaseSeconds = Math.max(
        bounds.leaseSeconds.min,
        Math.min(bounds.leaseSeconds.max, Number.isFinite(requestedLease) ? requestedLease : runtime.leaseSeconds),
    );
    const requestedAttempts = Number(body.max_attempts ?? runtime.maxAttempts);
    const maxAttempts = Math.max(
        bounds.maxAttempts.min,
        Math.min(bounds.maxAttempts.max, Number.isFinite(requestedAttempts) ? requestedAttempts : runtime.maxAttempts),
    );
    // More than one chunk at a time multiplies the model memory, so the
    // server clamps it to the same bound the browser uses.
    const requestedParallel = Number(body.parallel ?? runtime.parallel);
    const parallel = Math.max(
        1,
        Math.min(bounds.parallel.max, Number.isFinite(requestedParallel) ? requestedParallel : runtime.parallel),
    );

    const { data, error } = await service.rpc('import_claim_chunks', {
        p_job_id: job.id,
        p_limit: parallel,
        p_lease_seconds: leaseSeconds,
        p_max_attempts: maxAttempts,
    });
    if (error) {
        console.error('local claim failed', job.id, error.message);
        return fail('INTERNAL', 500);
    }
    const claimed = (data ?? []) as {
        id: string;
        idx: number;
        payload: Record<string, unknown>;
        source_id?: string | null;
        lease_until?: string | null;
    }[];
    if (claimed.length === 0) {
        await failExhausted(service, job.id, limits, maxAttempts);
        const progress = await chunkProgress(service, job.id);
        if (progress.queued === 0 && progress.running === 0) {
            await settleToReview(service, job.id);
            const fresh = await loadJobForUser(service, user.id, String(job.id));
            const j = 'error' in fresh ? job : fresh.job;
            return json({ ok: true, done: true, status: j.status, progress });
        }
        // Another tab may hold the running chunk. Ask the client to wait
        // instead of terminating its loop.
        return json({ ok: true, done: false, chunk: null, chunks: [], progress, retry_after_ms: 2000 });
    }
    const progress = await chunkProgress(service, job.id);
    return json({
        ok: true,
        done: false,
        // The first chunk on its own, and the whole batch.
        chunk: claimed[0],
        chunks: claimed,
        progress,
        lease_seconds: leaseSeconds,
        // The claim's ownership token, mirrored here so a client that has not
        // learned to read `chunk.lease_until` still gets it.
        lease_expires_at: claimed[0]?.lease_until ?? null,
    });
}

async function actionLocalSubmit(body: Record<string, unknown>, ctx: Context) {
    const { user, service } = ctx;
    if (!localInferenceEnabled()) return fail('LOCAL_MODE_DISABLED', 403);
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    let job = loaded.job;
    if (job.status !== 'extracting' || job.cancelled_at) return fail('JOB_STATE', 409);
    const cfg = (job.config ?? {}) as Record<string, unknown>;
    if (cfg.inference_mode !== 'local') return fail('LOCAL_MODE_REQUIRED', 409);

    // The model or the text/OCR config may have changed while this chunk was
    // being extracted. Storing the result would mix two setups in one job.
    const drift = localDrift(job, body);
    if (drift) return driftResponse(drift);

    const chunkId = String(body.chunk_id ?? '');
    const { data: chunkRow } = await service
        .from('import_chunks')
        .select('id, idx, payload, source_id, status, lease_until')
        .eq('id', chunkId)
        .eq('job_id', job.id)
        .maybeSingle();
    if (!chunkRow) return fail('NOT_FOUND', 404);
    // Only the claim holder may submit. A stale or duplicate submit must not
    // store the same rows and the same tray entries twice. The lease token is
    // the claim's identity: an expired lease or another window's token means
    // this result is no longer ours.
    if (chunkRow.status !== 'running' || !ownsLease(chunkRow as never, body)) {
        return fail('CHUNK_NOT_CLAIMED', 409);
    }

    if (!isValidLocalResult(body.result)) return fail('BAD_REQUEST');
    const result = body.result as Awaited<ReturnType<typeof runChunk>>;
    // An older client may omit usage; the persistence path reads it
    // unconditionally. Normalize rather than crash halfway through a write.
    if (!result.usage || typeof result.usage !== 'object') result.usage = { in: 0, out: 0 };
    const pipelineKind = body.pipeline_kind;
    if (pipelineKind !== 'text' && pipelineKind !== 'sheet' && pipelineKind !== 'image') {
        return fail('BAD_REQUEST');
    }

    // Take a short compare-and-swap lock on the lease before touching rows.
    // Two submits can both pass the status check; only the one whose lease
    // token still matches the row may write, so the loser cannot duplicate
    // rows or tray entries.
    const lockUntil = new Date(Date.now() + 60_000).toISOString();
    const { data: locked } = await service
        .from('import_chunks')
        .update({ lease_until: lockUntil })
        .eq('id', chunkId)
        .eq('job_id', job.id)
        .eq('status', 'running')
        .eq('lease_until', chunkRow.lease_until)
        .select('id')
        .maybeSingle();
    if (!locked) return fail('CHUNK_NOT_CLAIMED', 409);

    // The job's frozen identity, not the client's claim, is what the chunk
    // audit records. A client that sent a matching identity cannot swap it
    // for another name at submit time.
    const local = localJobFor(job);
    // The tray holds the rejects of the chunk's latest attempt, so the
    // previous ones are dropped first. A second submit of the same chunk
    // therefore leaves the same tray as the first one.
    const split = await persistChunkResult(ctx, job, chunkRow as never, result, {
        pipelineKind,
        replaceRejects: true,
        modelIdentity: local.model,
    });
    if (split) await insertSplitChildren(service, job.id as string, split);

    await failExhausted(service, job.id, ctx.limits, localMaxAttempts(job));
    const progress = await chunkProgress(service, job.id);
    if (progress.queued === 0 && progress.running === 0) await settleToReview(service, job.id);

    const fresh = await loadJobForUser(service, user.id, String(job.id));
    if (!('error' in fresh)) job = fresh.job;
    return json({ ok: true, status: job.status, progress });
}

async function actionLocalFail(body: Record<string, unknown>, ctx: Context) {
    const { user, service, limits } = ctx;
    if (!localInferenceEnabled()) return fail('LOCAL_MODE_DISABLED', 403);
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    if (job.status !== 'extracting' || job.cancelled_at) return fail('JOB_STATE', 409);
    const cfg = (job.config ?? {}) as Record<string, unknown>;
    if (cfg.inference_mode !== 'local') return fail('LOCAL_MODE_REQUIRED', 409);

    const chunkId = String(body.chunk_id ?? '');
    const code = String(body.error_code ?? 'LOCAL_ERROR').slice(0, 64) || 'LOCAL_ERROR';
    const maxAttempts = localMaxAttempts(job);

    const { data: chunk } = await service
        .from('import_chunks')
        .select('id, attempts, status, lease_until')
        .eq('id', chunkId)
        .eq('job_id', job.id)
        .maybeSingle();
    if (!chunk) return fail('NOT_FOUND', 404);

    // Only the claim holder may fail a chunk: another tab may have taken it
    // over already, and its rows must not be marked as failed.
    if (chunk.status !== 'running' || !ownsLease(chunk as never, body)) {
        return json({ ok: true, requeued: false, retryable: false, chunk_status: chunk.status });
    }

    // Transient failures requeue until the attempts run out; deterministic
    // ones (a model that cannot be used) fail at once, so the user sees the
    // cause instead of a retry loop. The classification is the server's: the
    // client sends the code, not the verdict.
    const retryable = !isDeterministicLocalError(code);
    const canRetry = retryable && (chunk.attempts ?? 0) < maxAttempts;
    const { data: updated } = await service
        .from('import_chunks')
        .update(canRetry
            ? { status: 'queued', error_code: code, lease_until: null }
            : { status: 'failed', error_code: code, lease_until: null })
        .eq('id', chunkId)
        .eq('job_id', job.id)
        .eq('status', 'running')
        .eq('lease_until', chunk.lease_until)
        .select('status')
        .maybeSingle();
    if (!updated) {
        // The lease changed between the read and the update: another owner
        // has the chunk now, so this failure is not ours to record.
        return json({ ok: true, requeued: false, retryable: false, chunk_status: chunk.status });
    }

    await failExhausted(service, job.id, limits, maxAttempts);
    const progress = await chunkProgress(service, job.id);
    if (progress.queued === 0 && progress.running === 0) await settleToReview(service, job.id);
    return json({
        ok: true,
        progress,
        requeued: canRetry,
        retryable,
        chunk_status: updated.status,
    });
}

async function actionLocalHeartbeat(body: Record<string, unknown>, ctx: Context) {
    const { user, service } = ctx;
    if (!localInferenceEnabled()) return fail('LOCAL_MODE_DISABLED', 403);
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    if (job.status !== 'extracting' || job.cancelled_at) return fail('JOB_STATE', 409);
    const cfg = (job.config ?? {}) as Record<string, unknown>;
    if (cfg.inference_mode !== 'local') return fail('LOCAL_MODE_REQUIRED', 409);

    const chunkId = String(body.chunk_id ?? '');
    const { data: chunk } = await service
        .from('import_chunks')
        .select('id, status, lease_until')
        .eq('id', chunkId)
        .eq('job_id', job.id)
        .maybeSingle();
    if (!chunk) return fail('NOT_FOUND', 404);
    // A heartbeat from the previous owner must not extend the new owner's
    // lease. The token and the unexpired lease are both required.
    if (chunk.status !== 'running' || !ownsLease(chunk as never, body)) {
        return fail('CHUNK_NOT_CLAIMED', 409);
    }

    const bounds = LOCAL_RUNTIME_BOUNDS;
    const requested = Number(body.lease_seconds ?? localRuntimeFor(job).runtime.leaseSeconds);
    const lease = Math.max(
        bounds.leaseSeconds.min,
        Math.min(bounds.leaseSeconds.max, Number.isFinite(requested) ? requested : bounds.leaseSeconds.max),
    );
    const next = new Date(Date.now() + lease * 1000).toISOString();
    // Compare-and-swap on the old lease: if another worker reclaimed the
    // chunk in the meantime, its token no longer matches and we leave it be.
    const { data: updated } = await service
        .from('import_chunks')
        .update({ lease_until: next })
        .eq('id', chunkId)
        .eq('job_id', job.id)
        .eq('status', 'running')
        .eq('lease_until', chunk.lease_until)
        .select('lease_until')
        .maybeSingle();
    if (!updated?.lease_until) return fail('CHUNK_NOT_CLAIMED', 409);
    return json({ ok: true, lease_expires_at: updated.lease_until });
}

/**
 * Hand a chunk back without counting it as a failed attempt.
 *
 * The user cancelled the run, or the tab was closed. The chunk goes back to
 * the queue and the attempt the claim took is given back, so a cancelled run
 * does not use up the chunk's retries.
 */
async function actionLocalRelease(body: Record<string, unknown>, ctx: Context) {
    const { user, service } = ctx;
    if (!localInferenceEnabled()) return fail('LOCAL_MODE_DISABLED', 403);
    const loaded = await loadJobForUser(service, user.id, String(body.job_id ?? ''));
    if ('error' in loaded) return fail(loaded.error, loaded.error === 'NOT_FOUND' ? 404 : 403);
    const job = loaded.job;
    const cfg = (job.config ?? {}) as Record<string, unknown>;
    if (cfg.inference_mode !== 'local') return fail('LOCAL_MODE_REQUIRED', 409);
    const chunkId = String(body.chunk_id ?? '');

    const { data: chunk } = await service
        .from('import_chunks')
        .select('id, attempts, status, lease_until')
        .eq('id', chunkId)
        .eq('job_id', job.id)
        .maybeSingle();
    if (!chunk) return fail('NOT_FOUND', 404);
    if (chunk.status !== 'running' || !ownsLease(chunk as never, body)) {
        return json({ ok: true, released: false });
    }

    const { data: updated } = await service
        .from('import_chunks')
        .update({
            status: 'queued',
            lease_until: null,
            attempts: Math.max(0, (chunk.attempts ?? 1) - 1),
        })
        .eq('id', chunkId)
        .eq('job_id', job.id)
        .eq('status', 'running')
        .eq('lease_until', chunk.lease_until)
        .select('id')
        .maybeSingle();
    return json({ ok: true, released: Boolean(updated) });
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
            case 'commit': return await actionCommit(body, ctx);
            case 'enabled': return actionEnabled(ctx);
            case 'local_claim': return await actionLocalClaim(body, ctx);
            case 'local_submit': return await actionLocalSubmit(body, ctx);
            case 'local_fail': return await actionLocalFail(body, ctx);
            case 'local_heartbeat': return await actionLocalHeartbeat(body, ctx);
            case 'local_release': return await actionLocalRelease(body, ctx);
            default: return fail('BAD_REQUEST');
        }
    } catch (err) {
        console.error('import-job failed', action, (err as Error)?.message);
        return fail('INTERNAL', 500);
    }
});

