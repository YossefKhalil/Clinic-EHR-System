// Local runtime configuration.
//
// Local mode has no cloud quotas and no token caps: the only bounds are the
// model's own context window and the device's memory. Everything here is a
// configurable default, not a limit the user hits.
//
// The resolution order is defaults -> device tier -> the user's overrides.
// The bounds themselves live in `import-core/limits.js` so the browser and
// the Edge Function clamp to the same numbers.

import { clampLocalConfig, clampNumber } from '@import-core/local-runtime.js';

export { clampLocalConfig, clampNumber };

export const DEFAULT_LOCAL_CONFIG = {
    text: {
        // The model's context window. The provider clamps this to what the
        // GGUF was trained for.
        contextTokens: 8192,
        // KV cache quantization: 'f16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1'
        kvCacheType: 'f16',
        batchSize: 512,
        ubatchSize: 512,
        threads: 4,
        // -1 = all layers on the GPU; 0 = CPU only; N = partial offload.
        gpuLayers: -1,
        flashAttention: true,
        mmap: true,
        // A safety cap only. The real bound is context - prompt tokens.
        maxOutputTokens: 4096,
        temperature: 0,
        topK: 1,
        topP: 1,
        repeatPenalty: 1,
        enableThinking: false,
        // null = use the GGUF's own chat template. A string overrides it.
        chatTemplate: null,
        stopSequences: [],
        repairPass: true,
        // Input shaping, not an AI limit: the extractor splits to fit context.
        sheetRowsPerChunk: 5,
        textCharsPerChunk: 1200,
    },
    ocr: {
        executionProvider: 'webgpu',
        stripWidth: 896,
        stripHeight: 256,
        overlap: 64,
        imageLongSide: 1280,
        maxNewTokens: 512,
        graphOptimizationLevel: 'all',
        powerPreference: 'high-performance',
    },
    runtime: {
        leaseSeconds: 900,
        heartbeatSeconds: 60,
        maxAttempts: 5,
        parallel: 1,
    },
};

/** The per-tier defaults. Applied only where the user has not chosen a value. */
export function deviceDefaults(tier) {
    if (tier === 'low') {
        return {
            text: { contextTokens: 4096, threads: 2, batchSize: 256, ubatchSize: 256, maxOutputTokens: 2048, sheetRowsPerChunk: 4, textCharsPerChunk: 1000 },
            ocr: { stripWidth: 640, stripHeight: 256, overlap: 48, imageLongSide: 896, maxNewTokens: 256 },
            runtime: { leaseSeconds: 1800 },
        };
    }
    if (tier === 'high') {
        return {
            text: { contextTokens: 16384, threads: 6, batchSize: 512, ubatchSize: 512, maxOutputTokens: 8192, sheetRowsPerChunk: 6, textCharsPerChunk: 1500 },
            ocr: { stripWidth: 1024, stripHeight: 384, overlap: 80, imageLongSide: 1536, maxNewTokens: 768 },
        };
    }
    return {};
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!override) return out;
    for (const [key, value] of Object.entries(override)) {
        if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
        else out[key] = value;
    }
    return out;
}

/**
 * Clamp the runtime values to the bounds both runtimes agree on. The browser
 * clamps before it saves; the Edge Function clamps again, because the client
 * is not trusted. (clampLocalConfig is re-exported at the top of the file.)
 */

/**
 * Resolve the config: defaults -> device tier -> the user's overrides.
 *
 * @param {string} tier 'low' | 'mid' | 'high'
 * @param {object} [overrides] the user's choices
 * @returns {{ config: object, warnings: string[] }}
 */
export function resolveLocalConfig(tier, overrides = {}) {
    const merged = deepMerge(deepMerge(DEFAULT_LOCAL_CONFIG, deviceDefaults(tier)), overrides);
    const config = clampLocalConfig(merged);
    const warnings = [];
    if (config.text.contextTokens < 1024) {
        warnings.push('contextTokens below 1024; extraction quality will suffer');
    }
    if (config.text.contextTokens > 65536) {
        warnings.push('contextTokens above 64k; the KV cache may exceed the device memory');
    }
    if (config.text.kvCacheType === 'f16' && config.text.contextTokens > 16384) {
        warnings.push('an f16 KV cache above a 16k context can exceed 2 GB; use q8_0 or q4_0');
    }
    if (config.runtime.parallel > 1) {
        warnings.push('parallel > 1 multiplies the model memory; use it only on a high-end machine');
    }
    if (config.runtime.heartbeatSeconds * 2 > config.runtime.leaseSeconds) {
        warnings.push('the heartbeat interval is more than half the lease; a slow machine will lose its claim');
    }
    return { config, warnings };
}

/**
 * Derive the extraction limits from the configured context, not from a fixed
 * cap. The server still enforces the storage sanity limits (rows, chunks,
 * payload size) — those protect the database, not the AI.
 */
export function extractionBudgets(config) {
    const ctx = config.text.contextTokens;
    const reserve = Math.max(512, Math.floor(ctx * 0.25));
    const promptBudget = Math.max(256, ctx - reserve);
    return {
        // Tokens available for the source text and the instructions.
        promptBudget,
        // The output is bounded by the remaining context, not by a fixed cap.
        maxOutputTokens: Math.min(config.text.maxOutputTokens, Math.max(256, reserve)),
        sheetRowsPerChunk: config.text.sheetRowsPerChunk,
        textCharsPerChunk: config.text.textCharsPerChunk,
    };
}
