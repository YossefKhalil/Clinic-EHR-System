// GGUF text adapter.
//
// This is the public face of the wllama runtime. The runtime itself lives in
// wllama-provider.js: it owns the worker, the WASM/WebGPU build and the
// streaming API. The adapter adds the pieces the rest of the local engine
// depends on:
//
//  - one object that can be handed to `getAdapter()` and to the pump;
//  - `complete(messages, config)` with the same `{ text, usage }` shape as
//    the cloud providers, so `runChunk()` does not know which engine it is
//    talking to;
//  - the split-mode guard: a split profile uses a text-only GGUF, and an
//    image arriving at it is a configuration mistake, not a prompt.
//
// The model is loaded once and reused for every chunk. `release()` is the
// only operation that frees the GPU/WASM memory, because unloading and
// reloading a multi-hundred-megabyte model per chunk would dominate the
// import.

import { resolveLocalConfig } from './local-config.js';
import {
    initWllama,
    createLocalProvider,
    unloadWllama,
    isLoaded,
    isMultimodal,
    chatTemplate,
} from './wllama-provider.js';

export const GGUF_ADAPTER_ID = 'wllama';

/** A coded error, so the pump can tell a configuration bug from a retry. */
function codedError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
}

/**
 * A config from the settings card can be either the resolved object
 * (`{ text, ocr, runtime }`) or a flat text config. The provider expects the
 * resolved shape; this keeps both accepted.
 */
export function normalizeTextConfig(config = {}) {
    if (config?.text) return config;
    return { text: { ...config } };
}

/** Merge a per-call override into the resolved config without mutating it. */
export function mergeConfig(base, override) {
    if (!override) return base;
    const resolved = normalizeTextConfig(base);
    const patch = override.text ? override.text : override;
    return { ...resolved, text: { ...resolved.text, ...patch } };
}

function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((part) => part && (part.type === 'text' || typeof part === 'string'))
        .map((part) => (typeof part === 'string' ? part : String(part.text ?? '')))
        .join('\n');
}

function normalizePart(part) {
    if (typeof part === 'string') return { type: 'text', text: part };
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'text') return { type: 'text', text: String(part.text ?? '') };
    if (part.type === 'image_url') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        return url ? { type: 'image', dataUrl: url } : null;
    }
    if (part.type === 'image') {
        // The wllama runtime accepts `{ type: 'image', data: ArrayBuffer }`.
        // Keep a data URL as-is; the provider converts it at call time.
        if (part.dataUrl) return { type: 'image', dataUrl: part.dataUrl };
        if (part.url) return { type: 'image', dataUrl: part.url };
        if (part.data) return part;
    }
    return null;
}

/** Is this an array of chat messages, or an array of content parts? */
function isContentParts(value) {
    return Array.isArray(value) && value.length > 0
        && value.every((part) => part && typeof part === 'object' && !('role' in part));
}

/**
 * Accept the two call styles the codebase uses:
 *
 *  - `complete([{ role, content }])` — the OpenAI-shaped form from Task 3;
 *  - `complete({ user, system, maxTokens, signal })` — the provider form
 *    `runChunk()` already uses.
 *
 * Both become the provider request. Keeping the second form is what lets the
 * existing extractor run unchanged.
 */
export function normalizeRequest(messagesOrRequest, config = {}) {
    if (Array.isArray(messagesOrRequest)) {
        let system = '';
        const parts = [];
        const rows = isContentParts(messagesOrRequest)
            ? [{ role: 'user', content: messagesOrRequest }]
            : messagesOrRequest;
        for (const message of rows) {
            if (!message || typeof message !== 'object') continue;
            if (message.role === 'system') {
                system = `${system}${system ? '\n' : ''}${contentText(message.content)}`;
                continue;
            }
            if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    const normalized = normalizePart(part);
                    if (normalized) parts.push(normalized);
                }
            } else {
                const text = contentText(message.content);
                if (text) parts.push({ type: 'text', text });
            }
        }
        return {
            system,
            user: parts,
            maxTokens: config?.maxOutputTokens,
        };
    }

    if (messagesOrRequest && typeof messagesOrRequest === 'object') {
        if (Array.isArray(messagesOrRequest.messages)) {
            const normalized = normalizeRequest(messagesOrRequest.messages, config);
            return {
                ...messagesOrRequest,
                ...normalized,
                maxTokens: messagesOrRequest.maxTokens ?? normalized.maxTokens,
            };
        }
        return { ...messagesOrRequest };
    }

    return { system: '', user: [], maxTokens: config?.maxOutputTokens };
}

function hasImage(request) {
    return Array.isArray(request?.user)
        && request.user.some((part) => part?.type === 'image');
}

function normalizeResult(result) {
    const text = String(result?.text ?? '');
    const usage = result?.usage;
    const input = Number(usage?.in ?? usage?.prompt_tokens ?? 0);
    const output = Number(usage?.out ?? usage?.completion_tokens ?? Math.ceil(text.length / 4));
    return {
        ...result,
        text,
        usage: { ...usage, in: input, out: output },
        finishReason: result?.finishReason ?? 'stop',
        model: result?.model ?? 'local/gguf',
        cost: 0,
    };
}

/**
 * The adapter the registry returns for a `wllama` probe.
 *
 * `provider` / `providerFactory` are injection points for tests; production
 * code lets the factory use the singleton runtime.
 */
export class GgufAdapter {
    constructor(options = {}) {
        this.id = GGUF_ADAPTER_ID;
        this.kind = 'gguf';
        this.mode = options.mode === 'split' ? 'split' : 'single';
        this.tier = options.tier || 'mid';
        this.probe = options.probe || null;
        this.config = options.config ? normalizeTextConfig({
            ...resolveLocalConfig(this.tier, options.config).config,
        }) : null;
        this.capabilities = options.capabilities || options.probe?.capabilities || null;
        this.provider = options.provider || null;
        this.providerFactory = options.providerFactory || null;
        this.label = options.label || 'local/gguf';
    }

    get loaded() {
        return isLoaded();
    }

    get multimodal() {
        return this.capabilities?.vision === true || isMultimodal();
    }

    get chatTemplate() {
        return chatTemplate();
    }

    /**
     * Load the model.
     *
     * @param {{ file?: Blob, blobs?: Blob[], url?: string, label?: string }} source
     * @param {{ config?: object, tier?: string, capabilities?: object,
     *           onProgress?: Function, onWarning?: Function }} [options]
     */
    async load(source, options = {}) {
        const capabilities = options.capabilities || this.capabilities || this.probe?.capabilities || null;
        // A split profile keeps the vision tower out of the text model: the
        // ONNX OCR model reads photos and the GGUF only sees text. Loading a
        // multimodal GGUF here would double the memory and bypass the OCR
        // path the profile asked for.
        if (this.mode === 'split' && capabilities?.vision === true) {
            throw codedError(
                'VISION_GGUF_UNSUPPORTED',
                'the split layout uses a text-only GGUF; this file carries a vision tower',
            );
        }

        // Task 2 keeps a FileSystemFileHandle, while wllama wants the File.
        // A bare File/Blob is accepted too, so a test or a drag-and-drop can
        // pass the file directly.
        let modelSource = source;
        if (typeof modelSource === 'string') {
            modelSource = { url: modelSource };
        } else if (modelSource && typeof modelSource.getFile === 'function') {
            modelSource = { ...modelSource, file: await modelSource.getFile() };
        } else if (modelSource && typeof modelSource.arrayBuffer === 'function'
            && !modelSource.file && !modelSource.blobs && !modelSource.url) {
            modelSource = { file: modelSource };
        }

        const resolved = resolveLocalConfig(options.tier || this.tier, options.config || this.config || {});
        this.config = resolved.config;
        this.capabilities = { text: true, vision: capabilities?.vision === true, ...capabilities };
        this.tier = options.tier || this.tier;
        this.label = modelSource?.label || modelSource?.file?.name || modelSource?.name || this.label;

        const loadOptions = {
            config: resolved.config,
            tier: this.tier,
            capabilities: this.capabilities,
            onProgress: options.onProgress,
            onWarning: options.onWarning,
        };
        await initWllama(modelSource, loadOptions);
        this.provider = null;
        return this;
    }

    /**
     * One completion.
     *
     * @param {Array|object} messagesOrRequest chat messages or the provider
     *        request shape (`{ user, system, maxTokens, signal }`)
     * @param {object} [configOverride] a flat text config or `{ text: ... }`
     */
    async complete(messagesOrRequest, configOverride = null) {
        const config = mergeConfig(this.config || resolveLocalConfig(this.tier, {}).config, configOverride);
        const request = normalizeRequest(messagesOrRequest, config.text);
        request.maxTokens = Math.min(
            Number(request.maxTokens) || config.text.maxOutputTokens,
            config.text.maxOutputTokens,
        );

        if (this.mode === 'split' && hasImage(request)) {
            throw codedError(
                'VISION_GGUF_UNSUPPORTED',
                'the split layout sends photos to the OCR adapter, not to the text model',
            );
        }

        const provider = this.provider
            || (this.providerFactory ? this.providerFactory(config) : createLocalProvider(config));
        const result = await provider.complete(request);
        return normalizeResult(result);
    }

    /** Free the model and its KV cache. Safe to call more than once. */
    async release() {
        this.provider = null;
        await unloadWllama();
    }
}

/** Create an adapter without loading a model yet. */
export function createGgufAdapter(options = {}) {
    return new GgufAdapter(options);
}
