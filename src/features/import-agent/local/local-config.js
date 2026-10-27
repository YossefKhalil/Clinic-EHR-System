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
import { LOCAL_RUNTIME_BOUNDS } from '@import-core/limits.js';
import { detectTier } from './manifest.js';

export { clampLocalConfig, clampNumber, detectTier };

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
        // 0 = not entered. The card asks for it on browsers that do not
        // expose navigator.deviceMemory (Firefox, Safari).
        systemMemoryGb: 0,
    },
};

/** The tier names the rest of the engine uses. `medium` is an alias. */
export const TIERS = Object.freeze(['low', 'mid', 'high']);

/** Normalize the public `medium` spelling onto the internal `mid`. */
export function normalizeTier(tier) {
    if (tier === 'medium' || tier === 'middle') return 'mid';
    if (tier === 'low' || tier === 'high') return tier;
    return 'mid';
}

/** The per-tier defaults. Applied only where the user has not chosen a value. */
export function deviceDefaults(tier) {
    const normalized = normalizeTier(tier);
    if (normalized === 'low') {
        return {
            text: { contextTokens: 4096, threads: 2, batchSize: 256, ubatchSize: 256, maxOutputTokens: 2048, sheetRowsPerChunk: 4, textCharsPerChunk: 1000 },
            ocr: { stripWidth: 640, stripHeight: 256, overlap: 48, imageLongSide: 896, maxNewTokens: 256 },
            runtime: { leaseSeconds: 1800 },
        };
    }
    if (normalized === 'high') {
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
 * Resolve the config with the public argument order:
 * `resolveConfig(userConfig, tier)`. The older `resolveLocalConfig(tier,
 * overrides)` stays for the existing callers and returns the warnings too.
 */
export function resolveConfig(userConfig = {}, tier = 'mid') {
    return resolveLocalConfig(tier, userConfig).config;
}

/** The defaults for each tier, fully resolved. */
export const DEFAULTS = Object.freeze({
    low: Object.freeze(resolveLocalConfig('low').config),
    medium: Object.freeze(resolveLocalConfig('mid').config),
    mid: Object.freeze(resolveLocalConfig('mid').config),
    high: Object.freeze(resolveLocalConfig('high').config),
});

// The numeric bounds the form checks, and the same bounds the Edge Function
// clamps to. Keeping the two tables together is what stops the browser from
// accepting a value the server will silently change.
const NUMERIC_BOUNDS = Object.freeze({
    'text.contextTokens': LOCAL_RUNTIME_BOUNDS.contextTokens,
    'text.batchSize': LOCAL_RUNTIME_BOUNDS.batchSize,
    'text.ubatchSize': LOCAL_RUNTIME_BOUNDS.batchSize,
    'text.threads': LOCAL_RUNTIME_BOUNDS.threads,
    'text.gpuLayers': LOCAL_RUNTIME_BOUNDS.gpuLayers,
    'text.maxOutputTokens': LOCAL_RUNTIME_BOUNDS.maxOutputTokens,
    'text.temperature': { min: 0, max: 2 },
    'text.topK': { min: 1, max: 200 },
    'text.topP': { min: 0, max: 1 },
    'text.repeatPenalty': { min: 0.5, max: 2 },
    'text.sheetRowsPerChunk': LOCAL_RUNTIME_BOUNDS.sheetRowsPerChunk,
    'text.textCharsPerChunk': LOCAL_RUNTIME_BOUNDS.textCharsPerChunk,
    'ocr.stripWidth': LOCAL_RUNTIME_BOUNDS.stripWidth,
    'ocr.stripHeight': LOCAL_RUNTIME_BOUNDS.stripHeight,
    'ocr.overlap': LOCAL_RUNTIME_BOUNDS.overlap,
    'ocr.imageLongSide': LOCAL_RUNTIME_BOUNDS.imageLongSide,
    'ocr.maxNewTokens': LOCAL_RUNTIME_BOUNDS.ocrMaxNewTokens,
    'runtime.leaseSeconds': LOCAL_RUNTIME_BOUNDS.leaseSeconds,
    'runtime.heartbeatSeconds': LOCAL_RUNTIME_BOUNDS.heartbeatSeconds,
    'runtime.maxAttempts': LOCAL_RUNTIME_BOUNDS.maxAttempts,
    'runtime.parallel': LOCAL_RUNTIME_BOUNDS.parallel,
    'runtime.systemMemoryGb': LOCAL_RUNTIME_BOUNDS.systemMemoryGb,
});

const BOOLEAN_FIELDS = Object.freeze([
    'text.flashAttention',
    'text.mmap',
    'text.enableThinking',
    'text.repairPass',
]);

const KV_CACHE_TYPES = Object.freeze(['f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1']);
const EXECUTION_PROVIDERS = Object.freeze(['webgpu', 'wasm']);
const GRAPH_OPTIMIZATION_LEVELS = Object.freeze(['disabled', 'basic', 'extended', 'all']);

function valueAt(config, path) {
    const [group, key] = path.split('.');
    return config?.[group]?.[key];
}

function hasValue(value) {
    return value !== undefined && value !== null && value !== '';
}

/**
 * Validate the user's config before it is saved.
 *
 * The result is a list of stable dotted paths (`text.contextTokens`), not
 * sentences: the card translates them with the label of the field. Missing
 * keys are valid; the defaults fill them. The Edge Function clamps the same
 * bounds again, so a client that skips this check cannot widen them.
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateLocalConfig(config = {}) {
    const errors = [];

    for (const [path, bounds] of Object.entries(NUMERIC_BOUNDS)) {
        const value = valueAt(config, path);
        if (!hasValue(value)) continue;
        const number = Number(value);
        if (!Number.isFinite(number)) {
            errors.push(path);
            continue;
        }
        if (number < bounds.min || number > bounds.max) errors.push(path);
    }

    for (const path of BOOLEAN_FIELDS) {
        const value = valueAt(config, path);
        if (value !== undefined && typeof value !== 'boolean') errors.push(path);
    }

    const kvCache = valueAt(config, 'text.kvCacheType');
    if (hasValue(kvCache) && !KV_CACHE_TYPES.includes(kvCache)) errors.push('text.kvCacheType');

    const provider = valueAt(config, 'ocr.executionProvider');
    if (hasValue(provider) && !EXECUTION_PROVIDERS.includes(provider)) errors.push('ocr.executionProvider');

    const graph = valueAt(config, 'ocr.graphOptimizationLevel');
    if (hasValue(graph) && !GRAPH_OPTIMIZATION_LEVELS.includes(graph)) errors.push('ocr.graphOptimizationLevel');

    const template = valueAt(config, 'text.chatTemplate');
    if (template !== undefined && template !== null && typeof template !== 'string') errors.push('text.chatTemplate');

    const stops = valueAt(config, 'text.stopSequences');
    if (stops !== undefined && !Array.isArray(stops)) errors.push('text.stopSequences');

    // The relations the two runtimes rely on. They are checked on the values
    // the user chose, with the defaults filling the rest.
    const merged = deepMerge(deepMerge(DEFAULT_LOCAL_CONFIG, deviceDefaults('mid')), config ?? {});
    if (merged.text.batchSize < merged.text.ubatchSize) errors.push('text.ubatchSize');
    if (merged.runtime.heartbeatSeconds * 2 > merged.runtime.leaseSeconds) {
        errors.push('runtime.heartbeatSeconds');
    }

    return { valid: errors.length === 0, errors };
}

/** The name the task/spec uses. */
export const validateConfig = validateLocalConfig;

/** Merge a partial config over another, without dropping nested keys. */
export const mergeConfig = deepMerge;

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
