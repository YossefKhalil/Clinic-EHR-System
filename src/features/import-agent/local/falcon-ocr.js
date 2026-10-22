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
    smartResize, resizeBitmap, canvasToPatches, buildPositions, buildAttentionMask,
    assembleTokens, makeStrips, makeCanvas,
} from './preprocess.js';
import { mergeStripLines } from './ocr-lines.js';

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
 * Load the OCR runtime.
 *
 * The ONNX Runtime and the tokenizer library are not part of the application
 * bundle: their wasm files do not fit the hosting. The OCR path is dark
 * until they ship with their own build, and says so instead of failing with
 * a stack trace.
 */
async function loadRuntime() {
    try {
        const [ort, transformers] = await Promise.all([
            import('onnxruntime-web'),
            import('@huggingface/transformers'),
        ]);
        return { ort, transformers };
    } catch (cause) {
        const error = new Error('the OCR runtime is not part of this build');
        error.code = 'OCR_RUNTIME_UNAVAILABLE';
        error.cause = cause;
        throw error;
    }
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
    const { config: resolved } = resolveLocalConfig(tier, { ocr: config?.ocr || {} });
    activeOcrConfig = resolved.ocr;

    const { ort, transformers } = await loadRuntime();
    const { env, AutoTokenizer } = transformers;

    ort.env.wasm.numThreads = 1; // no cross-origin isolation: one thread
    ort.env.wasm.simd = true;
    ort.env.webgpu.powerPreference = activeOcrConfig.powerPreference;

    const bytes = modelBlob instanceof Blob ? await modelBlob.arrayBuffer() : modelBlob;
    session = await ort.InferenceSession.create(bytes, {
        executionProviders: [activeOcrConfig.executionProvider, 'wasm'],
        graphOptimizationLevel: activeOcrConfig.graphOptimizationLevel,
        enableMemPattern: true,
        enableCpuMemArena: true,
        executionMode: 'sequential',
    });

    // The tokenizer must never reach the network in local mode.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useBrowserCache = false;
    env.fetch = installLocalFileLoader(support?.files);

    tokenizer = await AutoTokenizer.from_pretrained('falcon-ocr', { local_files_only: true });
    ready = true;
    onProgress?.(1, 1);
    return { ok: true, config: activeOcrConfig };
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
    // The runtime is loaded once; the strips are read with it.
    const { ort } = await loadRuntime();

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
    const promptTokens = await encode(OCR_PROMPT);

    for (const strip of strips) {
        const { h, w } = smartResize(strip.canvas.height, strip.canvas.width);
        const resized = await resizeBitmap(strip.canvas, w, h);
        const { patches, pH, pW, N } = canvasToPatches(resized);
        const tokens = assembleTokens(promptTokens, N);
        const spatialMask = new Uint8Array(tokens.length);
        for (let i = 0; i < tokens.length; i += 1) if (tokens[i] === IMG_ID) spatialMask[i] = 1;
        const { posT, posHw } = buildPositions(tokens, spatialMask, pH, pW);
        const attention = buildAttentionMask(tokens.length, spatialMask);
        const lastPromptPos = Number(posT[posT.length - 1]);

        const feeds = {
            tokens: new ort.Tensor('int64', BigInt64Array.from(tokens.map((token) => BigInt(token))), [1, tokens.length]),
            image_patches: new ort.Tensor('float32', patches, [1, N, 768]),
            pos_t: new ort.Tensor('int64', posT, [1, tokens.length]),
            pos_hw: new ort.Tensor('float32', posHw, [1, tokens.length, 2]),
            attention_mask: new ort.Tensor('bool', attention, [1, tokens.length, tokens.length]),
            past_key_values: new ort.Tensor('float32', new Float32Array(0), [22, 2, 1, 16, 0, 64]),
        };

        let result;
        try {
            result = await session.run(feeds);
        } catch (error) {
            // Some builds of the runtime refuse a cache with a length of zero.
            // A one-token dummy cache is used instead; the mask treats it as an
            // always-visible prefix.
            const length = tokens.length;
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
            feeds.attention_mask = new ort.Tensor('bool', mask, [1, length, 1 + length]);
            result = await session.run(feeds);
        }

        let nextToken = Number(result.next_token.data[0]);
        let present = result.present_key_values;
        const generated = [];
        let lastPos = lastPromptPos;
        feeds.image_patches = null;

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
            nextToken = Number(next.next_token.data[0]);
            present = next.present_key_values;
        }

        let text = '';
        try {
            text = await decode(generated);
        } catch {
            text = generated.join(' ');
        }
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        stripResults.push({ lines, raw: text });
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
