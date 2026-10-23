// The local pump: claim, run, submit.
//
// The browser owns the work; the server only keeps the bookkeeping. The
// chunks are claimed one at a time by default, and a heartbeat keeps the
// claim alive while a slow machine is still working on it.
//
// Local mode is config-driven, not quota-driven. The only bounds are the
// model context and the device memory (local-config.js).

import { resolveLocalConfig, extractionBudgets } from './local-config.js';
import { isDeterministicLocalError } from '@import-core/local-runtime.js';

/**
 * A failure of one of these means no later chunk can succeed either: the
 * model or the job setup itself is unusable. A deterministic error about a
 * single chunk (a model that cannot read this photo, for example) fails that
 * chunk and lets the run continue.
 */
const FATAL_CODES = new Set([
    'MODEL_FILE_UNAVAILABLE',
    'MODEL_FILE_MISSING',
    'TEXT_MODEL_UNAVAILABLE',
    'NO_MODEL_PROFILE',
    'LOCAL_MODEL_NOT_CONFIGURED',
    'LOCAL_MODE_DISABLED',
    'LOCAL_MODE_REQUIRED',
    'ENGINE_MISMATCH',
    'CONFIG_DRIFT',
]);

/**
 * Run the local loop for one job.
 *
 * @param {{ api: object, jobId: string, provider: object, runChunk: Function,
 *           mode: string, ocr: Function|null, config?: object, tier?: string,
 *           model?: object, onProgress?: Function, signal?: AbortSignal }} input
 */
export async function localPump(input) {
    const { api, jobId, provider, runChunk, mode, ocr, onProgress, signal } = input;
    const isSingle = mode === 'single';
    const { config, warnings } = resolveLocalConfig(input.tier || 'mid', input.config || {});
    for (const warning of warnings) onProgress?.({ phase: 'warning', message: warning });
    const budgets = extractionBudgets(config);
    const lease = config.runtime.leaseSeconds;
    const heartbeat = config.runtime.heartbeatSeconds;
    const parallel = Math.max(1, Math.min(4, Number(config.runtime.parallel) || 1));
    // The identity the job was started with. Every claim and submit carries
    // it back, and the server refuses the work when it no longer matches.
    const model = input.model ?? null;

    let running = true;
    // A drift discovered after a chunk was extracted is not thrown from
    // inside the parallel batch (that would unload the models while the other
    // chunks are still writing). It is returned so the UI can show it after
    // the batch has settled.
    let stopError = null;
    const abort = () => { running = false; };
    signal?.addEventListener('abort', abort, { once: true });

    /** One chunk, from the claim to the submit. */
    const processChunk = async (chunk) => {
        // The server returns the chunk row; the extractor works on the
        // payload (the lines, the header and the images).
        const payload = chunk.payload ?? {};
        // The lease is the claim's ownership token. It changes on every
        // heartbeat, so the newest value is sent with the submit: a chunk
        // another window has taken over since then is not ours to finish.
        let leaseExpiresAt = chunk.lease_until ?? null;
        const heartbeatTimer = setInterval(() => {
            api.callJob('local_heartbeat', {
                job_id: jobId,
                chunk_id: chunk.id,
                lease_seconds: lease,
                lease_expires_at: leaseExpiresAt,
            }).then((beat) => {
                if (beat?.lease_expires_at) leaseExpiresAt = beat.lease_expires_at;
            }).catch(() => {});
        }, heartbeat * 1000);

        let result;
        let ocrRan = false;
        try {
            let workChunk = payload;
            if (!isSingle && ocr && Array.isArray(payload.images) && payload.images.length > 0 && payload.kind !== 'text') {
                onProgress?.({ phase: 'ocr', chunk: chunk.id });
                const lines = await ocr(payload, onProgress);
                ocrRan = true;
                workChunk = {
                    ...payload,
                    kind: 'text',
                    images: [],
                    lines: lines.map((text, index) => ({ id: `L${String(index + 1).padStart(3, '0')}`, text })),
                    meta: { ...(payload.meta || {}), ocr: true },
                };
            }
            onProgress?.({ phase: 'extract', chunk: chunk.id });
            result = await runChunk({ provider, chunk: workChunk, maxTokens: budgets.maxOutputTokens });
        } catch (error) {
            clearInterval(heartbeatTimer);
            const code = error?.code || 'LOCAL_ERROR';
            const retryable = !isDeterministicLocalError(code);
            // A cancelled run hands the chunk back without burning an attempt.
            if (code === 'CANCELLED') {
                await api.callJob('local_release', {
                    job_id: jobId, chunk_id: chunk.id, lease_expires_at: leaseExpiresAt,
                }).catch(() => {});
                onProgress?.({ phase: 'chunk_released', chunk: chunk.id });
                return;
            }
            // The server classifies the code; the browser only says what
            // happened. It does not get to decide that a broken model is
            // retryable.
            await api.callJob('local_fail', {
                job_id: jobId, chunk_id: chunk.id, error_code: code, lease_expires_at: leaseExpiresAt,
            }).catch(() => {});
            onProgress?.({ phase: 'chunk_failed', chunk: chunk.id, error, retryable });
            if (FATAL_CODES.has(code)) running = false;
            return;
        }
        clearInterval(heartbeatTimer);

        // A cancelled extraction is not a result: the chunk goes back to the
        // queue without being counted as a failed attempt. Storing it as a
        // finished chunk would lose the patients it held.
        if (result?.status === 'cancelled') {
            await api.callJob('local_release', {
                job_id: jobId, chunk_id: chunk.id, lease_expires_at: leaseExpiresAt,
            }).catch(() => {});
            onProgress?.({ phase: 'chunk_released', chunk: chunk.id });
            return;
        }

        try {
            // The kind of the chunk decides how the records are checked: a
            // sheet is checked against its rows, a photo the multimodal model
            // read directly is not checked against a source text at all, and
            // OCR output is text and can be grounded against its lines.
            const pipelineKind = payload.kind === 'sheet'
                ? 'sheet'
                : (payload.kind === 'image' && !ocrRan ? 'image' : 'text');
            await api.callJob('local_submit', {
                job_id: jobId,
                chunk_id: chunk.id,
                result,
                pipeline_kind: pipelineKind,
                model,
                config,
                lease_expires_at: leaseExpiresAt,
            });
        } catch (error) {
            const code = error?.code || 'PERSIST_FAILED';
            // The lease expired or another window took the chunk over: its
            // result is not ours to store, and its new owner is working.
            if (code === 'CHUNK_NOT_CLAIMED' || code === 'LEASE_EXPIRED') {
                onProgress?.({ phase: 'chunk_not_claimed', chunk: chunk.id });
                return;
            }
            // The model or the settings changed while this chunk was being
            // extracted. Failing it would burn another attempt, so hand it
            // back and stop: every later chunk would be refused the same way.
            if (code === 'CONFIG_DRIFT') {
                await api.callJob('local_release', {
                    job_id: jobId, chunk_id: chunk.id, lease_expires_at: leaseExpiresAt,
                }).catch(() => {});
                running = false;
                stopError = error;
                onProgress?.({ phase: 'config_drift', chunk: chunk.id, error });
                return;
            }
            await api.callJob('local_fail', {
                job_id: jobId, chunk_id: chunk.id, error_code: code, lease_expires_at: leaseExpiresAt,
            }).catch(() => {});
            onProgress?.({ phase: 'submit_failed', chunk: chunk.id, error, retryable: !isDeterministicLocalError(code) });
            return;
        }
        onProgress?.({ phase: 'chunk_done', chunk: chunk.id });
    };

    while (running) {
        if (signal?.aborted) break;

        let claim;
        try {
            claim = await api.callJob('local_claim', {
                job_id: jobId,
                lease_seconds: lease,
                max_attempts: config.runtime.maxAttempts,
                parallel,
                // The job compares these with the setup it was started with
                // and refuses the claim if the model or the text/OCR config
                // has changed since then.
                model,
                config,
            });
        } catch (error) {
            // A refused claim (config drift, a revoked engine) must reach the
            // wizard's error banner; swallowing it would stop the run with no
            // explanation.
            onProgress?.({ phase: 'error', error });
            throw error;
        }

        if (!claim || claim.done) {
            if (claim?.status) onProgress?.({ phase: 'done', status: claim.status, progress: claim.progress });
            break;
        }

        const chunks = Array.isArray(claim.chunks)
            ? claim.chunks
            : (claim.chunk ? [claim.chunk] : []);
        if (chunks.length === 0) {
            // Another tab holds the running chunk. Wait instead of giving up.
            const wait = Math.max(500, Number(claim.retry_after_ms) || 2000);
            onProgress?.({ phase: 'progress', progress: claim.progress });
            await new Promise((resolve) => setTimeout(resolve, wait));
            continue;
        }
        onProgress?.({ phase: 'progress', progress: claim.progress });

        await Promise.all(chunks.map((chunk) => processChunk(chunk)));
    }

    return { stopped: !running, error: stopError };
}
