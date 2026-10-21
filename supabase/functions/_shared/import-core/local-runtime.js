// The local runtime's shared rules.
//
// The browser and the Edge Functions both need to clamp the local runtime
// settings to the same bounds, and the browser must not be trusted to do it.
// The rules therefore live here, in the folder both runtimes import
// (spec 14.2: one implementation, two runtimes).

import { LOCAL_RUNTIME_BOUNDS } from './limits.js';

/** Clamp a number into a range, falling back when the value is not a number. */
export function clampNumber(value, min, max, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    if (number < min) return min;
    if (number > max) return max;
    return number;
}

/**
 * Clamp the local runtime settings to the bounds both runtimes agree on.
 *
 * The result always has the three groups (text, ocr, runtime), so the code
 * that reads it never has to check for a missing key.
 */
export function clampLocalConfig(config) {
    const bounds = LOCAL_RUNTIME_BOUNDS;
    const text = config?.text ?? {};
    const ocr = config?.ocr ?? {};
    const runtime = config?.runtime ?? {};
    return {
        text: {
            ...text,
            contextTokens: clampNumber(text.contextTokens, bounds.contextTokens.min, bounds.contextTokens.max, 8192),
            batchSize: clampNumber(text.batchSize, bounds.batchSize.min, bounds.batchSize.max, 512),
            ubatchSize: clampNumber(text.ubatchSize, bounds.batchSize.min, bounds.batchSize.max, 512),
            threads: clampNumber(text.threads, bounds.threads.min, bounds.threads.max, 4),
            gpuLayers: clampNumber(text.gpuLayers, bounds.gpuLayers.min, bounds.gpuLayers.max, -1),
            maxOutputTokens: clampNumber(text.maxOutputTokens, bounds.maxOutputTokens.min, bounds.maxOutputTokens.max, 4096),
            temperature: clampNumber(text.temperature, 0, 2, 0),
            topK: clampNumber(text.topK, 1, 200, 1),
            topP: clampNumber(text.topP, 0, 1, 1),
            repeatPenalty: clampNumber(text.repeatPenalty, 0.5, 2, 1),
            sheetRowsPerChunk: clampNumber(text.sheetRowsPerChunk, bounds.sheetRowsPerChunk.min, bounds.sheetRowsPerChunk.max, 5),
            textCharsPerChunk: clampNumber(text.textCharsPerChunk, bounds.textCharsPerChunk.min, bounds.textCharsPerChunk.max, 1200),
        },
        ocr: {
            ...ocr,
            stripWidth: clampNumber(ocr.stripWidth, bounds.stripWidth.min, bounds.stripWidth.max, 896),
            stripHeight: clampNumber(ocr.stripHeight, bounds.stripHeight.min, bounds.stripHeight.max, 256),
            overlap: clampNumber(ocr.overlap, 0, bounds.overlap.max, 64),
            imageLongSide: clampNumber(ocr.imageLongSide, bounds.imageLongSide.min, bounds.imageLongSide.max, 1280),
            maxNewTokens: clampNumber(ocr.maxNewTokens, bounds.ocrMaxNewTokens.min, bounds.ocrMaxNewTokens.max, 512),
        },
        runtime: {
            ...runtime,
            leaseSeconds: clampNumber(runtime.leaseSeconds, bounds.leaseSeconds.min, bounds.leaseSeconds.max, 900),
            heartbeatSeconds: clampNumber(runtime.heartbeatSeconds, bounds.heartbeatSeconds.min, bounds.heartbeatSeconds.max, 60),
            maxAttempts: clampNumber(runtime.maxAttempts, bounds.maxAttempts.min, bounds.maxAttempts.max, 5),
            parallel: clampNumber(runtime.parallel, 1, bounds.parallel.max, 1),
        },
    };
}

const PROFILE_TEXT_KEYS = ['name', 'textName', 'visionName', 'supportName'];
const PROFILE_SIZE_KEYS = ['size', 'textSize', 'visionSize'];

function shortString(value, max = 200) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function safeSize(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 0;
    return Math.round(number);
}

function safeHash(value) {
    const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return /^[0-9A-F]{64}$/.test(text) ? text : '';
}

/**
 * Keep only the fields the local profile may hold.
 *
 * The profile names the models the clinic picked. The files themselves and
 * their handles never reach the server.
 */
export function normalizeLocalProfile(profile) {
    const out = {};
    const mode = profile?.mode;
    if (mode === 'single' || mode === 'split') out.mode = mode;
    for (const key of PROFILE_TEXT_KEYS) {
        const value = shortString(profile?.[key]);
        if (value) out[key] = value;
    }
    for (const key of PROFILE_SIZE_KEYS) {
        const value = safeSize(profile?.[key]);
        if (value) out[key] = value;
    }
    const hash = safeHash(profile?.sha256);
    if (hash) out.sha256 = hash;
    return out;
}
