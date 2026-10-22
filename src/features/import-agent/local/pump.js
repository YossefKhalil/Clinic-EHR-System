// The local pump: claim, run, submit.
//
// The browser owns the work; the server only keeps the bookkeeping. The
// chunks are claimed one at a time by default, and a heartbeat keeps the
// claim alive while a slow machine is still working on it.
//
// Local mode is config-driven, not quota-driven. The only bounds are the
// model context and the device memory (local-config.js).

import { resolveLocalConfig, extractionBudgets } from './local-config.js';

/** Failures that will fail again the same way, so they are not retried. */
const DETERMINISTIC_CODES = [
    'MODEL_NOT_MULTIMODAL',
    'MODEL_INCOMPATIBLE',
    'MODEL_FILE_UNAVAILABLE',
    'MODEL_FILE_MISSING',
    'OCR_SUPPORT_FILES_MISSING',
    'OCR_RUNTIME_UNAVAILABLE',
    'VISION_GGUF_UNSUPPORTED',
    'TEXT_MODEL_UNAVAILABLE',
    'VISION_MODEL_UNAVAILABLE',
    'NO_MODEL_PROFILE',
];

/**
 * Run the local loop for one job.
 *
 * @param {{ api: object, jobId: string, provider: object, runChunk: Function,
 *           mode: string, ocr: Function|null, config?: object, tier?: string,
 *           onProgress?: Function, signal?: AbortSignal }} input
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

    let running = true;
    const abort = () => { running = false; };
    signal?.addEventListener('abort', abort, { once: true });

    /** One chunk, from the claim to the submit. */
    const processChunk = async (chunk) => {
        // The server returns the chunk row; the extractor works on the
        // payload (the lines, the header and the images).
        const payload = chunk.payload ?? {};
        const heartbeatTimer = setInterval(() => {
            api.callJob('local_heartbeat', { job_id: jobId, chunk_id: chunk.id, lease_seconds: lease }).catch(() => {});
        }, heartbeat * 1000);

        let result;
        try {
            let workChunk = payload;
            if (!isSingle && ocr && Array.isArray(payload.images) && payload.images.length > 0 && payload.kind !== 'text') {
                onProgress?.({ phase: 'ocr', chunk: chunk.id });
                const lines = await ocr(payload, onProgress);
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
            const retryable = !DETERMINISTIC_CODES.includes(code);
            // A cancelled run hands the chunk back without burning an attempt.
            if (code === 'CANCELLED') {
                await api.callJob('local_release', { job_id: jobId, chunk_id: chunk.id }).catch(() => {});
                onProgress?.({ phase: 'chunk_released', chunk: chunk.id });
                return;
            }
            await api.callJob('local_fail', {
                job_id: jobId, chunk_id: chunk.id, error_code: code, retryable,
            }).catch(() => {});
            onProgress?.({ phase: 'chunk_failed', chunk: chunk.id, error, retryable });
            return;
        }
        clearInterval(heartbeatTimer);

        // A cancelled extraction is not a result: the chunk goes back to the
        // queue without being counted as a failed attempt. Storing it as a
        // finished chunk would lose the patients it held.
        if (result?.status === 'cancelled') {
            await api.callJob('local_release', { job_id: jobId, chunk_id: chunk.id }).catch(() => {});
            onProgress?.({ phase: 'chunk_released', chunk: chunk.id });
            return;
        }

        try {
            // The kind of the chunk decides how the records are checked: a
            // sheet is checked against its rows, a photo is not checked
            // against a source text at all.
            const pipelineKind = payload.kind === 'sheet' || payload.kind === 'image' ? payload.kind : 'text';
            await api.callJob('local_submit', {
                job_id: jobId, chunk_id: chunk.id, result, pipeline_kind: pipelineKind,
            });
        } catch (error) {
            await api.callJob('local_fail', {
                job_id: jobId, chunk_id: chunk.id, error_code: 'PERSIST_FAILED', retryable: false,
            }).catch(() => {});
            onProgress?.({ phase: 'submit_failed', chunk: chunk.id, error });
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
            });
        } catch (error) {
            onProgress?.({ phase: 'error', error });
            break;
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

    return { stopped: !running };
}
