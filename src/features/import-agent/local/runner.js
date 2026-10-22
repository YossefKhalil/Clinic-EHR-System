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
import { loadProfile, profileComplete } from './model-profile.js';
import { setupLocalModels } from './setup.js';
import { localPump } from './pump.js';
import { probeDevice } from './manifest.js';
import { resolveLocalConfig } from './local-config.js';

function error(code, message) {
    const err = new Error(message || code);
    err.code = code;
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
