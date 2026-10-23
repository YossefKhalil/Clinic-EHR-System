// Falcon-OCR runtime.
//
// It loads the ONNX session and the tokenizer, runs the OCR over the strips
// of one image and returns the text lines.
//
// Performance notes:
//  - The session is created once and reused.
//  - The WebGPU execution provider is preferred; a clear error is raised when
//    it is missing.
//  - The strips are processed one after the other, which caps the peak memory.
//  - The KV cache is fed back as the output tensor, so it is never copied.
//
// The tokenizer and the config files are the ones the clinic picked in the
// setup panel. They are served to the tokenizer library through a local
// fetch, so nothing is ever requested from the internet.

import { resolveLocalConfig } from './local-config.js';
import {
    smartResize, resizeBitmap, canvasToPatches, buildPositions as buildTokenPositions,
    buildAttentionMask, assembleTokens, makeStrips, makeCanvas,
} from './preprocess.js';
import { mergeStripLines } from './ocr-lines.js';
import { createOnnxSession, loadOnnxRuntime } from './onnx-adapter.js';

// The strip and mask helpers are part of the Falcon pipeline as well as of
// the preprocessor. Re-export them here so a caller only needs this module.
export { makeStrips, buildAttentionMask } from './preprocess.js';
export { buildPositions } from './preprocess.js';
export { mergeStripLines } from './ocr-lines.js';

const EOS_ID = 11;
const IMG_ID = 227;

/** The prompt the OCR model was exported with. */
export const OCR_PROMPT = '<|image|>Extract the text content from this image.\n<|OCR_PLAIN|>';

let session = null;
let tokenizer = null;
let ready = false;
let activeOcrConfig = null;

/**
 * Serve the files the clinic picked to the tokenizer library.
 *
 * The library asks for paths like "falcon-ocr/tokenizer.json". Only the file
 * name is matched, and a request that does not match one of the picked files
 * fails instead of reaching the network.
 */
export function installLocalFileLoader(files) {
    const byName = new Map();
    for (const [name, file] of Object.entries(files || {})) byName.set(name, file);
    return async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        const name = url.split('/').pop().split('?')[0];
        const file = byName.get(name);
        if (!file) {
            const error = new Error(`MODEL_FILE_MISSING: ${name}`);
            error.code = 'MODEL_FILE_MISSING';
            throw error;
        }
        return new Response(file);
    };
}

/**
 * Load the tokenizer runtime.
 *
 * The tokenizer library is not part of the application bundle: its wasm
 * files do not fit the hosting. The OCR path is dark until it ships with
 * its own build, and says so instead of failing with a stack trace. The
 * ONNX Runtime is loaded by onnx-adapter.js only when a session is created.
 */
async function loadRuntime() {
    try {
        const transformers = await import('@huggingface/transformers');
        return { transformers };
    } catch (cause) {
        const error = new Error('the OCR runtime is not part of this build');
        error.code = 'OCR_RUNTIME_UNAVAILABLE';
        error.cause = cause;
        throw error;
    }
}

/** The ORT module, loaded once per page. */
let ortModule = null;
async function loadOrt() {
    if (!ortModule) ortModule = await loadOnnxRuntime();
    return ortModule;
}

/**
 * Load the OCR model.
 *
 * @param {Blob} modelBlob the ONNX graph
 * @param {{ files: Record<string, File> }} support the tokenizer and config files
 * @param {object} [config] the resolved local config
 * @param {string} [tier] the device tier
 */
export async function initFalcon(modelBlob, support, config = null, tier = 'mid', onProgress = null) {
    // Accept both the resolved config (`{ ocr, text, runtime }`) and a flat
    // OCR config, which is what the adapter class holds.
    const { config: resolved } = resolveLocalConfig(tier, { ocr: config?.ocr || config || {} });
    activeOcrConfig = resolved.ocr;

    const created = await createOnnxSession(modelBlob, activeOcrConfig);
    session = created.session;
    try {
        const { transformers } = await loadRuntime();
        const { env, AutoTokenizer } = transformers;

        // The tokenizer must never reach the network in local mode.
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.useBrowserCache = false;
        env.fetch = installLocalFileLoader(support?.files);

        tokenizer = await AutoTokenizer.from_pretrained('falcon-ocr', { local_files_only: true });
    } catch (error) {
        // The session is already holding memory; do not leak it when the
        // tokenizer cannot start.
        try { session?.release?.(); } catch { /* the session is going away anyway */ }
        session = null;
        activeOcrConfig = null;
        throw error;
    }
    ready = true;
    onProgress?.(1, 1);
    return { ok: true, config: activeOcrConfig, warnings: created.warnings };
}

export function isReady() {
    return ready;
}

async function encode(text) {
    const out = await tokenizer(text, { add_special_tokens: true });
    const ids = out.input_ids;
    if (ids && ids.data) return Array.from(ids.data, (value) => Number(value));
    if (Array.isArray(ids)) return ids;
    if (ids && ids.tolist) return ids.tolist();
    throw new Error('tokenizer returned no input_ids');
}

async function decode(ids) {
    return tokenizer.decode(ids, { skip_special_tokens: true });
}

/** Release a tensor's GPU memory when the runtime supports it. */
function disposeTensor(tensor) {
    try { tensor?.dispose?.(); } catch { /* the tensor is going away anyway */ }
}

/** Release every feed except the ones the caller still needs. */
function disposeFeeds(feeds, keep = []) {
    for (const [name, tensor] of Object.entries(feeds || {})) {
        if (!keep.includes(name)) disposeTensor(tensor);
    }
}

/**
 * Run one strip through the model and return its generated tokens.
 *
 * This is the unit Task 4 can call when it wants to drive the OCR pipeline
 * itself. `ocrImageBitmap()` is the convenience wrapper: it scales the
 * image, cuts the strips and merges the lines.
 *
 * @param {{ canvas: object }|object} strip a strip from `makeStrips()`, or a
 *        canvas
 * @param {object|null} kvCache an initial `present_key_values` tensor; null
 *        starts from an empty cache
 * @param {object} [ocrConfig] the OCR config; the loaded one is used otherwise
 * @param {{ promptTokens?: number[], tokens?: number[] }} [context] tokens
 *        already encoded by the caller, so a multi-strip image encodes the
 *        prompt once
 * @returns {Promise<{ tokens: number[], text: string, lines: string[],
 *                     presentKeyValues: object|null }>}
 */
export async function runStrip(strip, kvCache = null, ocrConfig = null, context = {}) {
    if (!ready) throw new Error('Falcon not initialized');
    const cfg = ocrConfig || activeOcrConfig;
    if (!cfg) throw new Error('OCR_CONFIG_MISSING');
    const ort = await loadOrt();

    const canvas = strip?.canvas || strip;
    const { h, w } = smartResize(canvas.height, canvas.width);
    const resized = await resizeBitmap(canvas, w, h);
    const { patches, pH, pW, N } = canvasToPatches(resized);
    const promptTokens = context.promptTokens || await encode(OCR_PROMPT);
    const tokens = context.tokens || assembleTokens(promptTokens, N);
    const spatialMask = new Uint8Array(tokens.length);
    for (let i = 0; i < tokens.length; i += 1) if (tokens[i] === IMG_ID) spatialMask[i] = 1;
    const { posT, posHw } = buildTokenPositions(tokens, spatialMask, pH, pW);
    const attention = buildAttentionMask(tokens.length, spatialMask);
    const lastPromptPos = Number(posT[posT.length - 1]);

    const feeds = {
        tokens: new ort.Tensor('int64', BigInt64Array.from(tokens.map((token) => BigInt(token))), [1, tokens.length]),
        image_patches: new ort.Tensor('float32', patches, [1, N, 768]),
        pos_t: new ort.Tensor('int64', posT, [1, tokens.length]),
        pos_hw: new ort.Tensor('float32', posHw, [1, tokens.length, 2]),
        attention_mask: new ort.Tensor('bool', attention, [1, tokens.length, tokens.length]),
        past_key_values: kvCache || new ort.Tensor('float32', new Float32Array(0), [22, 2, 1, 16, 0, 64]),
    };

    let result;
    try {
        result = await session.run(feeds);
    } catch (error) {
        if (kvCache) {
            disposeFeeds(feeds, ['past_key_values']);
            throw error;
        }
        // Some builds of the runtime refuse a cache with a length of zero.
        // A one-token dummy cache is used instead; the mask treats it as an
        // always-visible prefix.
        const length = tokens.length;
        disposeTensor(feeds.past_key_values);
        feeds.past_key_values = new ort.Tensor('float32', new Float32Array(22 * 2 * 1 * 16 * 1 * 64), [22, 2, 1, 16, 1, 64]);
        const mask = new Uint8Array(length * (1 + length));
        for (let q = 0; q < length; q += 1) {
            mask[q * (1 + length)] = 1;
            for (let k = 0; k < length; k += 1) {
                const causal = q >= k;
                const bothImage = spatialMask[q] && spatialMask[k];
                if (causal || bothImage) mask[q * (1 + length) + 1 + k] = 1;
            }
        }
        disposeTensor(feeds.attention_mask);
        feeds.attention_mask = new ort.Tensor('bool', mask, [1, length, 1 + length]);
        try {
            result = await session.run(feeds);
        } catch (retryError) {
            disposeFeeds(feeds);
            throw retryError;
        }
    }

    // The prompt feeds are no longer needed once the cache exists. The
    // initial cache is normally a separate tensor from the output cache;
    // keep it if the runtime returned the same object, or if the caller
    // supplied it and still owns it.
    const keepPromptCache = feeds.past_key_values === result.present_key_values
        || (kvCache && feeds.past_key_values === kvCache);
    disposeFeeds(feeds, keepPromptCache ? ['past_key_values'] : []);
    feeds.image_patches = null;

    let nextToken = Number(result.next_token.data[0]);
    disposeTensor(result.next_token);
    let present = result.present_key_values;
    const generated = [];
    let lastPos = lastPromptPos;

    for (let step = 0; step < cfg.maxNewTokens; step += 1) {
        if (nextToken === EOS_ID) break;
        generated.push(nextToken);
        lastPos += 1;
        const currentLength = tokens.length + generated.length;
        const stepFeeds = {
            tokens: new ort.Tensor('int64', BigInt64Array.from([BigInt(nextToken)]), [1, 1]),
            image_patches: new ort.Tensor('float32', new Float32Array(0), [1, 0, 768]),
            pos_t: new ort.Tensor('int64', BigInt64Array.from([BigInt(lastPos)]), [1, 1]),
            pos_hw: new ort.Tensor('float32', new Float32Array([0, 0]), [1, 1, 2]),
            attention_mask: new ort.Tensor('bool', new Uint8Array(currentLength).fill(1), [1, 1, currentLength]),
            past_key_values: present,
        };
        const next = await session.run(stepFeeds);
        const keepCache = stepFeeds.past_key_values === next.present_key_values;
        // The previous cache has been consumed by the run; on WebGPU it can
        // be freed before the next step allocates another one.
        if (!keepCache) disposeTensor(present);
        disposeFeeds(stepFeeds, keepCache ? ['past_key_values'] : []);
        nextToken = Number(next.next_token.data[0]);
        disposeTensor(next.next_token);
        present = next.present_key_values;
    }

    let text = '';
    try {
        text = await decode(generated);
    } catch {
        text = generated.join(' ');
    }
    return {
        tokens: generated,
        text,
        lines: text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        presentKeyValues: present,
    };
}

/**
 * Read one image.
 *
 * @param {ImageBitmap} bitmap the image
 * @param {object} [ocrConfig] the OCR config; the loaded one is used otherwise
 * @returns {Promise<{ lines: {id: string, text: string}[], raw: string, meta: object }>}
 */
export async function ocrImageBitmap(bitmap, ocrConfig = null) {
    if (!ready) throw new Error('Falcon not initialized');
    const cfg = ocrConfig || activeOcrConfig;
    if (!cfg) throw new Error('OCR_CONFIG_MISSING');

    // The long side is capped first, so the strips stay small.
    const scale = Math.min(1, cfg.imageLongSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(16, Math.round(bitmap.width * scale));
    const height = Math.max(16, Math.round(bitmap.height * scale));
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);

    const strips = makeStrips(canvas, cfg.stripWidth, cfg.stripHeight, cfg.overlap);
    const stripResults = [];
    // The prompt is the same for every strip; encode it once.
    const promptTokens = await encode(OCR_PROMPT);

    for (const strip of strips) {
        const result = await runStrip(strip, null, cfg, { promptTokens });
        // The cache belongs to this strip; the next strip starts fresh.
        disposeTensor(result.presentKeyValues);
        stripResults.push({ lines: result.lines, raw: result.text });
    }

    const merged = mergeStripLines(stripResults);
    return {
        lines: merged,
        raw: stripResults.map((strip) => strip.raw).join('\n'),
        meta: { strips: strips.length, config: cfg },
    };
}

export function unloadFalcon() {
    if (session) {
        try {
            session.release();
        } catch { /* the session is going away anyway */ }
    }
    session = null;
    tokenizer = null;
    activeOcrConfig = null;
    ready = false;
}

/**
 * Task 3's name for the same teardown. It frees the ONNX session, the
 * tokenizer and every WebGPU buffer the session owned.
 */
export function release() {
    unloadFalcon();
}
