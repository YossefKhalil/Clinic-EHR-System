// Local LLM provider wrapping wllama v3.
//
// It implements the same `complete()` interface the cloud providers
// implement, so `runChunk()` runs unchanged against a model on the clinic's
// own PC.
//
// Local mode has no cloud quota. The only bounds are the model's context
// window and the device's memory; both are config-driven (local-config.js).

import { resolveLocalConfig } from './local-config.js';

let wllama = null;
let loaded = false;
let activeConfig = null;
let modelLabel = 'local/gguf';
let modelTemplate = null;
let modelMultimodal = false;

/**
 * The number of worker threads to ask for.
 *
 * wllama's multi-thread build needs SharedArrayBuffer, which needs
 * cross-origin isolation. The app does not set COOP/COEP (it would break
 * the Supabase calls the app depends on), so the honest default is one
 * thread. A clinic that serves the app from its own LAN server can raise
 * this once the headers are in place.
 */
export function resolveThreads(requested) {
    const wanted = Math.max(1, Number(requested) || 1);
    if (wanted === 1) return 1;
    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) return wanted;
    return 1;
}

/** True when the page may use more than one thread. */
export function threadsAvailable() {
    return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
}

/** The load parameters, in the names the runtime uses. */
export function buildLoadParams(config, extra = {}) {
    const text = config.text;
    const params = {
        n_ctx: text.contextTokens,
        n_batch: text.batchSize,
        n_ubatch: text.ubatchSize,
        n_gpu_layers: text.gpuLayers,
        n_threads: resolveThreads(text.threads),
        cache_type_k: text.kvCacheType,
        cache_type_v: text.kvCacheType,
        flash_attn: text.flashAttention,
        // MiniCPM and friends emit a reasoning block; the extractor must not
        // see it, so the thinking pass is off unless the user asks for it.
        reasoning: text.enableThinking === true,
    };
    if (text.chatTemplate) params.chat_template = text.chatTemplate;
    return { ...params, ...extra };
}

/** The sampling parameters, in the names the runtime uses. */
export function buildSamplingParams(config, maxTokens) {
    const text = config.text;
    return {
        max_tokens: Math.min(maxTokens || text.maxOutputTokens, text.maxOutputTokens),
        temp: text.temperature,
        top_p: text.topP,
        top_k: text.topK,
        penalty_repeat: text.repeatPenalty,
    };
}

/**
 * Load a GGUF into the browser.
 *
 * @param {{ file?: Blob, blobs?: Blob[], url?: string, label?: string }} modelSource
 * @param {{ config?: object, tier?: string, onProgress?: Function }} [options]
 */
export async function initWllama(modelSource, options = {}) {
    const tier = options.tier || 'mid';
    const { config, warnings } = resolveLocalConfig(tier, options.config || {});
    activeConfig = config;
    for (const warning of warnings) {
        if (warning.includes('thread')) options.onWarning?.(warning);
    }

    // The package's "main" points at a file the published tarball does not
    // ship, so the ESM build is imported by its path.
    const { Wllama } = await import('@wllama/wllama/esm/index.js');
    const wasmUrl = (await import('@wllama/wllama/esm/wasm/wllama.wasm?url')).default;

    wllama = new Wllama({ default: wasmUrl }, { suppressNativeLog: true, allowOffline: true });
    // The runtime has no progress callback for a file that is already in
    // hand, so the panel shows the phase instead of a byte counter.
    const loadParams = buildLoadParams(config);

    if (modelSource.url) {
        await wllama.loadModelFromUrl(modelSource.url, loadParams);
    } else if (modelSource.blobs?.length) {
        await wllama.loadModel(modelSource.blobs, loadParams);
    } else if (modelSource.file) {
        await wllama.loadModel([modelSource.file], loadParams);
    } else {
        throw new Error('no model source');
    }

    modelLabel = modelSource.label || 'local/gguf';
    modelTemplate = wllama.getChatTemplate?.() ?? null;
    modelMultimodal = options.capabilities?.multimodal === true;
    loaded = true;

    // Warm up so the first real chunk is not the slow one.
    try {
        await wllama.createCompletion({ prompt: 'hi', max_tokens: 1, temperature: 0 });
    } catch { /* the warm-up is best effort */ }

    return { ok: true, config, chatTemplate: modelTemplate };
}

export function isLoaded() {
    return loaded;
}

/** True when the loaded model can read a photo. */
export function isMultimodal() {
    return modelMultimodal;
}

/** The chat template the loaded GGUF carries, if any. */
export function chatTemplate() {
    return modelTemplate;
}

/** Turn a data URL into the bytes the runtime wants for an image part. */
export async function dataUrlToBuffer(dataUrl) {
    const comma = String(dataUrl).indexOf(',');
    if (comma < 0) throw new Error('MODEL_IMAGE_MALFORMED');
    const base64 = String(dataUrl).slice(comma + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function usageFrom(response, fallbackText) {
    const usage = response?.usage;
    if (usage && typeof usage.prompt_tokens === 'number') {
        return { in: usage.prompt_tokens, out: usage.completion_tokens ?? 0 };
    }
    return { in: 0, out: Math.ceil(String(fallbackText ?? '').length / 4) };
}

/**
 * The provider object the extractor talks to.
 *
 * The text path goes through `createChatCompletion`, so the prompt follows
 * the chat template the GGUF carries. A model without a template would
 * silently produce garbage, so the setup panel refuses it first
 * (GGUF_TEMPLATE_MISSING).
 */
export function createLocalProvider() {
    if (!loaded) throw new Error('wllama not loaded');
    const config = activeConfig;

    return {
        get model() {
            return modelLabel;
        },
        async complete(request) {
            const messages = request.user || [];
            const hasImage = messages.some((part) => part.type === 'image');
            const maxTokens = Math.min(request.maxTokens || config.text.maxOutputTokens, config.text.maxOutputTokens);
            const sampling = buildSamplingParams(config, maxTokens);
            const abortSignal = request.signal ?? undefined;

            if (hasImage) {
                // A photo needs a model with a vision tower. A text-only
                // model says so instead of failing inside the runtime.
                if (!modelMultimodal) {
                    const error = new Error('MODEL_NOT_MULTIMODAL');
                    error.code = 'MODEL_NOT_MULTIMODAL';
                    throw error;
                }
                const content = [];
                for (const part of messages) {
                    if (part.type === 'text') {
                        content.push({ type: 'text', text: part.text });
                    } else if (part.type === 'image') {
                        content.push({ type: 'image', data: await dataUrlToBuffer(part.dataUrl) });
                    }
                }
                const response = await wllama.createChatCompletion({
                    messages: [
                        { role: 'system', content: request.system || '' },
                        { role: 'user', content },
                    ],
                    ...sampling,
                    abortSignal,
                });
                const text = response?.choices?.[0]?.message?.content ?? '';
                return {
                    text: String(text),
                    finishReason: response?.choices?.[0]?.finish_reason === 'length' ? 'length' : 'stop',
                    usage: usageFrom(response, text),
                    model: modelLabel,
                    cost: 0,
                };
            }

            const userText = messages
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n');

            // A template override means the user drives the prompt, so the
            // raw completion is used and the stop sequences apply.
            if (config.text.chatTemplate) {
                const prompt = renderTemplate(config.text.chatTemplate, {
                    system: request.system || '',
                    user: userText,
                });
                const response = await wllama.createCompletion({
                    prompt,
                    ...sampling,
                    stop: config.text.stopSequences?.length ? config.text.stopSequences : undefined,
                    abortSignal,
                });
                const text = response?.choices?.[0]?.text ?? '';
                return {
                    text: String(text),
                    finishReason: response?.choices?.[0]?.finish_reason === 'length' ? 'length' : 'stop',
                    usage: usageFrom(response, text),
                    model: modelLabel,
                    cost: 0,
                };
            }

            const response = await wllama.createChatCompletion({
                messages: [
                    { role: 'system', content: request.system || '' },
                    { role: 'user', content: userText },
                ],
                ...sampling,
                abortSignal,
            });
            const text = response?.choices?.[0]?.message?.content ?? '';
            return {
                text: String(text),
                finishReason: response?.choices?.[0]?.finish_reason === 'length' ? 'length' : 'stop',
                usage: usageFrom(response, text),
                model: modelLabel,
                cost: 0,
            };
        },
    };
}

/**
 * Fill a chat template.
 *
 * Only the placeholders a clinic would write are supported: {system} and
 * {user}. A template with neither is used as a prefix.
 */
export function renderTemplate(template, { system, user }) {
    const source = String(template ?? '');
    if (!source.includes('{system}') && !source.includes('{user}')) {
        return `${source}${system ? `${system}\n` : ''}${user}`;
    }
    return source
        .replaceAll('{system}', system ?? '')
        .replaceAll('{user}', user ?? '');
}

export async function unloadWllama() {
    if (wllama) {
        try {
            await wllama.exit();
        } catch { /* the runtime is going away anyway */ }
    }
    wllama = null;
    loaded = false;
    activeConfig = null;
    modelTemplate = null;
    modelMultimodal = false;
}
