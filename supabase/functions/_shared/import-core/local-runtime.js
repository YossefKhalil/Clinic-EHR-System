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
const PROFILE_HASH_KEYS = ['sha256', 'textSha256', 'visionSha256'];

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
    for (const key of PROFILE_HASH_KEYS) {
        const hash = safeHash(profile?.[key]);
        if (hash) out[key] = hash;
    }
    return out;
}

/**
 * The profile as the server may store it: names, sizes and hashes only.
 *
 * The picked profile (IndexedDB) keeps each model under a slot with a file
 * handle; this flattens it to the shape in `normalizeLocalProfile` and drops
 * everything that must never leave the browser.
 */
export function localProfileSummary(profile) {
    const out = {};
    const mode = profile?.mode;
    if (mode === 'single' || mode === 'split') out.mode = mode;
    const slots = [
        ['multimodal', { name: 'name', size: 'size', sha256: 'sha256' }],
        ['text', { name: 'textName', size: 'textSize', sha256: 'textSha256' }],
        ['vision', { name: 'visionName', size: 'visionSize', sha256: 'visionSha256' }],
    ];
    for (const [slot, keys] of slots) {
        const entry = profile?.[slot];
        if (!entry) continue;
        const name = shortString(entry.name);
        if (name) out[keys.name] = name;
        const size = safeSize(entry.size);
        if (size) out[keys.size] = size;
        const hash = safeHash(entry.sha256);
        if (hash) out[keys.sha256] = hash;
    }
    const supportName = shortString(profile?.support?.name);
    if (supportName) out.supportName = supportName;
    return out;
}

/**
 * The identity of the model a job actually runs.
 *
 * The split layout extracts with its text model; the multimodal model is the
 * only model in the single layout. The vision model is part of a split job's
 * identity because changing it changes how a photo is read.
 *
 * Accepts both the picked profile (nested slots) and the flattened profile
 * the server stores, so the browser and the Edge Function build the same
 * identity from the same data.
 *
 * @returns {{ mode: 'single'|'split', name?: string, sha256?: string,
 *             vision?: { name?: string, sha256?: string } }}
 */
export function normalizeLocalIdentity(value) {
    const mode = value?.mode === 'split' ? 'split' : 'single';
    const entry = mode === 'split' ? value?.text : value?.multimodal;
    const name = shortString(entry?.name ?? value?.name ?? value?.textName);
    const sha256 = safeHash(entry?.sha256 ?? value?.sha256 ?? value?.textSha256);
    const identity = { mode };
    if (name) identity.name = name;
    if (sha256) identity.sha256 = sha256;
    if (mode === 'split') {
        const vision = value?.vision ?? null;
        const visionName = shortString(vision?.name ?? value?.visionName);
        const visionSha256 = safeHash(vision?.sha256 ?? value?.visionSha256);
        if (visionName || visionSha256) {
            identity.vision = {};
            if (visionName) identity.vision.name = visionName;
            if (visionSha256) identity.vision.sha256 = visionSha256;
        }
    }
    return identity;
}

/**
 * The identity of the model a picked or stored profile names.
 *
 * @returns {{ mode: 'single'|'split', name?: string, sha256?: string,
 *             vision?: { name?: string, sha256?: string } }}
 */
export function localModelIdentity(profile) {
    return normalizeLocalIdentity(profile);
}

/**
 * True when two identities name the same model in the same layout.
 *
 * A missing hash is not proof of a different file: a file the clinic picked
 * without verifying has no hash yet. When both sides carry one, it must
 * match.
 */
export function sameLocalModel(a, b) {
    const left = normalizeLocalIdentity(a);
    const right = normalizeLocalIdentity(b);
    if (left.mode !== right.mode) return false;
    if (left.name && right.name && left.name.toLowerCase() !== right.name.toLowerCase()) return false;
    if (left.sha256 && right.sha256 && left.sha256 !== right.sha256) return false;
    if (Boolean(left.vision) !== Boolean(right.vision)) return false;
    if (left.vision && right.vision) {
        if (left.vision.name && right.vision.name
            && left.vision.name.toLowerCase() !== right.vision.name.toLowerCase()) return false;
        if (left.vision.sha256 && right.vision.sha256
            && left.vision.sha256 !== right.vision.sha256) return false;
    }
    return true;
}

/** A stable value comparison for the parts of the config that travel as JSON. */
function sameValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((value, index) => sameValue(value, b[index]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key)
            && sameValue(a[key], b[key]));
    }
    return false;
}

/** Whether a config carries a real baseline (not the empty object). */
function hasConfig(config) {
    return Boolean(config)
        && typeof config === 'object'
        && (Object.keys(config.text ?? {}).length > 0 || Object.keys(config.ocr ?? {}).length > 0);
}

/**
 * True when the current config would run the job differently than the one
 * frozen into it.
 *
 * The runtime knobs (lease, heartbeat, attempts, parallel) deliberately do
 * not count: changing how fast a job is claimed does not change what the
 * model reads or writes. The text and OCR settings do.
 *
 * A job created before the resolved config was stored has no baseline; it is
 * not drift, because refusing it would strand a resumable job.
 */
export function localConfigDrift(stored, current) {
    if (!hasConfig(stored) || !hasConfig(current)) return false;
    const before = clampLocalConfig(stored);
    const after = clampLocalConfig(current);
    return !sameValue(before.text, after.text) || !sameValue(before.ocr, after.ocr);
}

/**
 * Errors that will fail the same way on every attempt.
 *
 * Shared so the browser can stop on a fatal one and the Edge Function can
 * decide whether to requeue without trusting the client's own verdict.
 */
export const LOCAL_DETERMINISTIC_CODES = Object.freeze([
    'MODEL_NOT_MULTIMODAL',
    'MODEL_INCOMPATIBLE',
    'MODEL_FILE_UNAVAILABLE',
    'MODEL_FILE_MISSING',
    'VISION_GGUF_UNSUPPORTED',
    'TEXT_MODEL_UNAVAILABLE',
    'VISION_MODEL_UNAVAILABLE',
    'VISION_MODEL_MISSING',
    'OCR_SUPPORT_FILES_MISSING',
    'OCR_RUNTIME_UNAVAILABLE',
    'NO_MODEL_PROFILE',
    'LOCAL_MODEL_NOT_CONFIGURED',
    'LOCAL_MODE_DISABLED',
    'LOCAL_MODE_REQUIRED',
    'ENGINE_MISMATCH',
    'CONFIG_DRIFT',
    // The rows were not stored. Repeating the same result cannot fix that.
    'PERSIST_FAILED',
    // A malformed submit or a chunk this client no longer owns.
    'BAD_REQUEST',
    'BAD_RESULT',
]);

const DETERMINISTIC_ERRORS = new Set(LOCAL_DETERMINISTIC_CODES);

/** True when retrying the same payload cannot succeed. */
export function isDeterministicLocalError(code) {
    return DETERMINISTIC_ERRORS.has(String(code ?? ''));
}
