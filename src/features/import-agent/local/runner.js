// The local import run.
//
// The browser does the extraction: it loads the models the clinic picked,
// claims the chunks from the server one at a time, runs the same extractor
// the Edge Function runs, and hands the result back.
//
// The extractor is the same file in both runtimes, so the YAML contract, the
// repair pass and the parsing cannot drift apart.

import yaml from 'js-yaml';
import { runChunk } from '@import-extract/run-chunk.js';
import { LIMITS } from '@import-core/limits.js';
import { loadProfile, profileComplete, profileNeedsRepair } from './model-profile.js';
import { fileFromHandle } from './model-store.js';
import { setupLocalModels } from './setup.js';
import { localPump } from './pump.js';
import { probeDevice } from './manifest.js';
import { resolveLocalConfig } from './local-config.js';
import { localModelIdentity } from '@import-core/local-runtime.js';

function error(code, message) {
    const err = new Error(message || code);
    err.code = code;
    // The wizard uses this key rather than showing the raw code. A setup
    // failure is not an HTTP error, so there is no ImportApiError here.
    err.messageKey = `importAgent.chunkError.${code}`;
    return err;
}

/**
 * The chunk sizes for the local engine.
 *
 * The limits are not AI quotas: they shape the input so a chunk fits in the
 * model's context. The row and file limits stay as they are.
 */
export function localLimits(config) {
    const chars = config.text.textCharsPerChunk;
    const rows = config.text.sheetRowsPerChunk;
    return {
        ...LIMITS,
        TEXT_CHUNK_TARGET: chars,
        TEXT_CHUNK_MAX: Math.round(chars * 1.5),
        SHEET_CHUNK_ROWS: rows,
    };
}

/**
 * Run a local import.
 *
 * @param {{ api: object, jobId: string, hints?: string, config?: object,
 *           onProgress?: Function, signal?: AbortSignal }} input
 */
export async function runLocalImport(input) {
    const { api, jobId, hints = '', onProgress, signal } = input;

    const profile = await loadProfile();
    if (!profile || !profileComplete(profile)) throw error('NO_MODEL_PROFILE', 'no model profile');
    // The name alone is not enough: the runner needs a handle it can open in
    // this browser. A missing handle means the profile came from another
    // browser (or from before handles were stored), so tell the clinic to
    // pick the file again instead of failing later with a generic error.
    const slot = profile.mode === 'single' ? profile.multimodal : profile.text;
    if (!slot?.handle || profileNeedsRepair(slot)) {
        throw error('MODEL_PROFILE_HANDLE_MISSING', 'the model file has to be picked again in this browser');
    }
    const file = await fileFromHandle(slot.handle);
    if (!file) throw error('MODEL_FILE_UNREACHABLE', 'the model file is not reachable');

    const device = await probeDevice();
    // The clinic's own settings come first; the device tier fills the gaps.
    const { config } = resolveLocalConfig(device.tier, input.config ?? {});

    onProgress?.({ phase: 'loading_models' });
    const setup = await setupLocalModels({
        profile,
        config,
        tier: device.tier,
        onProgress: (role, loaded, total) => onProgress?.({ phase: 'loading_model', role, loaded, total }),
    });

    try {
        const result = await localPump({
            api,
            jobId,
            provider: setup.provider,
            mode: setup.mode,
            ocr: setup.ocr,
            config: setup.config,
            tier: device.tier,
            // The name, the hash and the layout of the model that is loaded
            // now. The server refuses a chunk when they differ from the job.
            model: localModelIdentity(profile),
            onProgress,
            signal,
            runChunk: ({ provider, chunk, maxTokens }) => runChunk({
                provider,
                chunk,
                hints,
                limits: LIMITS,
                yaml,
                signal,
                maxTokens,
            }),
        });
        return result;
    } finally {
        await setup.unload();
    }
}
