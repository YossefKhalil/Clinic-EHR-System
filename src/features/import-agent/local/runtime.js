// The CPU runtime. It loads the pinned GGUF files into a wllama worker and
// exposes one text/vision chat call. The UI thread never runs the token loop.

import { Wllama } from './wllama-js.js';
import { MODEL_MANIFEST } from './manifest.js';

const BASE = import.meta.env.BASE_URL || '/';

// The wasm artifacts are served with a long cache lifetime, so their URL has
// to change when the build changes. Bump this on every wllama rebuild.
const ASSET_VERSION = '3';

function asset(path) {
    const url = new URL(`${BASE}${path}`, window.location.origin);
    url.searchParams.set('v', ASSET_VERSION);
    return url.href;
}

// The stock wllama chooses its compat path from browser features. Our wasm is
// always wasm32 (never Memory64) and the JS layer is patched to say so, so the
// same bridge works in Chromium and Firefox. The wasm artifacts differ only in
// the kernel and suspension strategy:
//   relaxed + JSPI      -> Chrome/Edge today (fastest)
//   relaxed + Asyncify  -> Firefox (relaxed SIMD without JSPI)
//   standard + Asyncify -> anything else with WebAssembly SIMD
const RELAXED = {
    wasm: asset('wllama/wllama.wasm'),
    worker: asset('wllama/wllama-worker.js'),
    mode: 'relaxed',
};
const RELAXED_ASYNCIFY = {
    wasm: asset('wllama/wllama-relaxed-asyncify.wasm'),
    worker: asset('wllama/wllama-relaxed-asyncify-worker.js'),
    mode: 'relaxed',
};
const STANDARD = {
    wasm: asset('wllama/wllama-standard.wasm'),
    worker: asset('wllama/wllama-standard-worker.js'),
    mode: 'standard',
};

function simdModule() {
    // The tiny known-good SIMD probe from the wasm-feature-detect suite: a
    // v128.const needs a 16-byte immediate, and a hand-rolled short form is
    // invalid in every browser.
    return new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0,
        1, 5, 1, 96, 0, 1, 123,
        3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]);
}

function relaxedModule() {
    // i32x4.relaxed_dot_i8x16_i7x16_add(ones, ones, zero)
    const v128 = (byte) => [0xfd, 0x0c, ...Array(16).fill(byte)];
    const body = [
        0x00,
        ...v128(0x01),
        ...v128(0x01),
        ...v128(0x00),
        0xfd, 0x93, 0x02, 0xfd, 0x1b, 0x00, 0x0b,
    ];
    const code = [0x01, body.length, ...body];
    return new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0,
        1, 5, 1, 0x60, 0, 1, 0x7f,
        3, 2, 1, 0,
        7, 5, 1, 1, 0x66, 0, 0,
        10, code.length, ...code,
    ]);
}

export function probeRuntime() {
    const simd = (() => {
        try { return WebAssembly.validate(simdModule()); } catch { return false; }
    })();
    const relaxed = (() => {
        try { return WebAssembly.validate(relaxedModule()); } catch { return false; }
    })();
    const jspi = typeof WebAssembly !== 'undefined' && 'Suspending' in WebAssembly;
    const threads = typeof SharedArrayBuffer !== 'undefined' && Boolean(window.crossOriginIsolated);
    const opfs = Boolean(navigator.storage?.getDirectory);
    // Any SIMD browser can run the model: the Asyncify artifact needs no JSPI
    // and no relaxed SIMD, it is only slower. OPFS is required to download and
    // keep the model; local .gguf files work without it.
    return {
        simd,
        relaxed,
        jspi,
        threads,
        opfs,
        isolated: Boolean(window.crossOriginIsolated),
        hardwareConcurrency: Math.max(1, navigator.hardwareConcurrency || 1),
        deviceMemory: Number(navigator.deviceMemory || 0),
        usable: simd,
        mode: variantFor({ relaxed, jspi }).mode,
    };
}

/** The fastest artifact this browser can actually run. */
function variantFor(probe) {
    if (probe.relaxed && probe.jspi) return RELAXED;
    if (probe.relaxed) return RELAXED_ASYNCIFY;
    return STANDARD;
}

export function defaultConfig() {
    const probe = probeRuntime();
    const cores = probe.hardwareConcurrency;
    const threads = Math.max(1, Math.min(8, Math.floor(cores / 2) || 1));
    return {
        threads,
        threadsBatch: Math.max(threads, Math.min(cores, Math.max(4, threads * 2))),
        context: 4096,
        batch: 256,
        ubatch: 256,
        kvType: 'q4_0',
        flashAttention: true,
        maxOutputTokens: 1024,
        temperature: 0.1,
        topK: 50,
        topP: 1,
        minP: 0,
        repeatPenalty: 1.1,
        imageMinTokens: 64,
        imageMaxTokens: 512,
        vision: true,
    };
}

let workerCodeCache = null;

async function workerCode(url) {
    if (workerCodeCache?.url === url) return workerCodeCache.code;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`WORKER_FETCH_${response.status}`);
    const code = await response.text();
    workerCodeCache = { url, code };
    return code;
}

export class LocalEngine {
    constructor() {
        this.wllama = null;
        this.loaded = false;
        this.loading = false;
        this.modelId = null;
        this.build = null;
        this.probe = probeRuntime();
        this.lastConfig = null;
    }

    get ready() {
        return this.loaded;
    }

    async load({ model, projector, config = defaultConfig(), onProgress } = {}) {
        if (!model) throw new Error('MODEL_FILE_MISSING');
        if (this.loading) throw new Error('MODEL_LOADING');
        this.loading = true;
        try {
            const variant = variantFor(this.probe);
            this.variant = variant;
            const code = await workerCode(variant.worker);
            // `needCompat` is true in our bridge; setCompat supplies the
            // matching wasm32 worker and glue. The mode is forced so neither
            // Chromium nor Firefox swaps in a CDN artifact.
            const instance = new Wllama(
                { default: variant.wasm },
                { suppressNativeLog: true, allowOffline: true },
            );
            instance.setCompat({ wasm: variant.wasm, worker: { code } }, 'firefox_safari');
            const params = {
                n_ctx: config.context,
                n_batch: config.batch,
                n_ubatch: config.ubatch,
                n_threads: config.threads,
                n_threads_batch: config.threadsBatch,
                n_gpu_layers: 0,
                n_parallel: 1,
                kv_unified: true,
                cache_type_k: config.kvType,
                cache_type_v: config.kvType,
                flash_attn: config.flashAttention,
                jinja: true,
                reasoning: false,
                warmup: true,
                seed: 42,
                image_min_tokens: config.imageMinTokens,
                image_max_tokens: config.imageMaxTokens,
                mmproj_offload: false,
                no_kv_offload: true,
                log_level: 3,
            };
            const files = projector ? [model, projector] : [model];
            await instance.loadModel(files, {
                ...params,
                progressCallback: (progress) => onProgress?.(progress),
            });
            this.wllama = instance;
            this.loaded = true;
            this.modelId = MODEL_MANIFEST.id;
            this.lastConfig = { ...config };
            this.build = Wllama.getLibllamaVersion?.() ?? null;
            return this.info();
        } finally {
            this.loading = false;
        }
    }

    info() {
        const ctx = this.wllama?.getLoadedContextInfo?.() ?? null;
        return {
            loaded: this.loaded,
            build: this.build,
            model: MODEL_MANIFEST.title,
            mode: this.variant?.mode ?? this.probe.mode,
            threads: this.wllama?.getNumThreads?.() ?? this.lastConfig?.threads ?? 0,
            multithread: Boolean(this.wllama?.isMultithread?.()),
            vision: Boolean(this.wllama?.supportInputModality?.('image')),
            context: ctx?.n_ctx ?? this.lastConfig?.context ?? null,
            contextTrain: ctx?.n_ctx_train ?? null,
            metadata: this.wllama?.getModelMetadata?.() ?? null,
        };
    }

    async chat(messages, params = {}) {
        if (!this.loaded || !this.wllama) throw new Error('MODEL_NOT_LOADED');
        const config = this.lastConfig ?? defaultConfig();
        const response = await this.wllama.createChatCompletion({
            messages,
            stream: false,
            max_tokens: params.maxTokens ?? config.maxOutputTokens,
            temp: params.temperature ?? config.temperature,
            top_k: params.topK ?? config.topK,
            top_p: params.topP ?? config.topP,
            min_p: params.minP ?? config.minP,
            penalty_repeat: params.repeatPenalty ?? config.repeatPenalty,
            seed: 42,
            abortSignal: params.signal,
            // LFM3 is a reasoning model: its template opens a thinking block by
            // default, and on this 2B CPU model that block eats the whole
            // output budget before a single row is written. Extraction wants
            // the answer, not the deliberation.
            chat_template_kwargs: { enable_thinking: false },
            ...(params.grammar ? { grammar: params.grammar } : {}),
            ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
        });
        const choice = response?.choices?.[0];
        return {
            text: choice?.message?.content ?? '',
            finishReason: choice?.finish_reason ?? null,
            usage: {
                in: response?.usage?.prompt_tokens ?? 0,
                out: response?.usage?.completion_tokens ?? 0,
            },
            timings: response?.timings ?? null,
        };
    }

    async unload() {
        const instance = this.wllama;
        this.wllama = null;
        this.loaded = false;
        this.build = null;
        if (instance) {
            try {
                await instance.exit();
            } catch {
                // worker may already be gone
            }
        }
    }
}

export const localEngine = new LocalEngine();