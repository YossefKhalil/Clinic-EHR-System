// ONNX Runtime Web adapter.
//
// The adapter owns one ONNX session. It is deliberately small: the graph is
// validated before it is loaded (adapters.js / onnx-metadata.js), and the
// Falcon pipeline (falcon-ocr.js) owns the tensors and the generation loop.
// What lives here is the part every ONNX caller needs:
//
//  - the WebGPU -> WASM fallback;
//  - the session options the OCR path needs (no external data, sequential
//    execution, graph optimisation);
//  - a final I/O check against the live session, because a file can pass the
//    protobuf probe and still disagree with what the runtime exposes;
//  - `release()`, which frees the session and its WebGPU buffers.
//
// `onnxruntime-web` is imported lazily so the settings panel can probe a
// model in a browser where the runtime is not installed (or is too large to
// ship) without the import failing at page load.

import {
    FALCON_OCR_RULES,
    validateFalconOcrShape,
    parseOnnxGraph,
} from './onnx-metadata.js';

export const ONNX_ADAPTER_ID = 'onnx-falcon-ocr';

/** The OCR defaults, matching local-config.js without importing the tier logic. */
export const DEFAULT_OCR_CONFIG = Object.freeze({
    executionProvider: 'webgpu',
    stripWidth: 896,
    stripHeight: 256,
    overlap: 64,
    imageLongSide: 1280,
    maxNewTokens: 512,
    graphOptimizationLevel: 'all',
    powerPreference: 'high-performance',
});

function codedError(code, message, cause = null) {
    const error = new Error(message || code);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
}

/** Accept a resolved config (`{ ocr }`) or a flat OCR config. */
export function normalizeOcrConfig(config = {}) {
    if (config?.ocr) return { ...DEFAULT_OCR_CONFIG, ...config.ocr };
    return { ...DEFAULT_OCR_CONFIG, ...config };
}

/** Load the runtime only when an ONNX model is actually used. */
export function loadOnnxRuntime() {
    return import('onnxruntime-web');
}

function configureRuntime(ort, config) {
    if (!ort?.env) return;
    if (ort.env.wasm) {
        // The app does not set COOP/COEP because Supabase needs the page to
        // stay same-origin-friendly; without cross-origin isolation the WASM
        // backend must run on one thread.
        ort.env.wasm.numThreads = (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) ? 2 : 1;
        ort.env.wasm.simd = true;
    }
    if (ort.env.webgpu) {
        ort.env.webgpu.powerPreference = config.powerPreference || 'high-performance';
    }
}

async function modelBytes(model) {
    if (typeof Blob !== 'undefined' && model instanceof Blob) return new Uint8Array(await model.arrayBuffer());
    if (model instanceof ArrayBuffer) return new Uint8Array(model);
    if (ArrayBuffer.isView(model)) {
        return new Uint8Array(model.buffer, model.byteOffset, model.byteLength);
    }
    if (model && typeof model.arrayBuffer === 'function') {
        return new Uint8Array(await model.arrayBuffer());
    }
    throw codedError('ONNX_MODEL_UNREADABLE', 'the ONNX model could not be read as bytes');
}

/** Read a dtype from the live session metadata in the forms ORT uses. */
function metadataDtype(meta) {
    const raw = String(meta?.type ?? '');
    const match = /tensor\(([^)]+)\)/.exec(raw);
    return match ? match[1] : raw;
}

/**
 * Compare the live session with the Falcon contract.
 *
 * `session.inputNames` is always available; the shapes are only checked when
 * the runtime exposes metadata (the protobuf probe already checked them).
 */
export function sessionIoMismatches(session, rules = FALCON_OCR_RULES) {
    const mismatches = [];
    const inputs = new Set(session?.inputNames ?? []);
    const outputs = new Set(session?.outputNames ?? []);
    for (const name of Object.keys(rules.inputs)) {
        if (!inputs.has(name)) mismatches.push(`session input "${name}" is missing`);
    }
    for (const name of Object.keys(rules.outputs)) {
        if (!outputs.has(name)) mismatches.push(`session output "${name}" is missing`);
    }
    // A session may expose more than the probe expected. Extra names are not
    // harmless: the generation loop cannot fill them.
    for (const name of inputs) {
        if (!(name in rules.inputs)) mismatches.push(`session input "${name}" is not part of the Falcon contract`);
    }
    for (const name of outputs) {
        if (!(name in rules.outputs)) mismatches.push(`session output "${name}" is not part of the Falcon contract`);
    }
    for (const [name, rule] of Object.entries(rules.inputs)) {
        checkSessionTensor(`input "${name}"`, session?.inputMetadata?.[name], rule, mismatches);
    }
    for (const [name, rule] of Object.entries(rules.outputs)) {
        checkSessionTensor(`output "${name}"`, session?.outputMetadata?.[name], rule, mismatches);
    }
    return mismatches;
}

function checkSessionTensor(label, meta, rule, mismatches) {
    if (!meta) return;
    const dtype = metadataDtype(meta);
    if (rule.dtype && dtype && dtype !== rule.dtype) {
        mismatches.push(`session ${label} is ${dtype}, expected ${rule.dtype}`);
    }
    if (rule.rank && Array.isArray(meta.shape) && meta.shape.length !== rule.rank) {
        mismatches.push(`session ${label} has rank ${meta.shape.length}, expected ${rule.rank}`);
    }
}

/**
 * Create an ONNX session.
 *
 * @param {Blob|ArrayBuffer|Uint8Array|File} model
 * @param {object} [config] resolved config (`{ ocr }`) or a flat OCR config
 * @param {{ runtime?: object, probe?: object, sessionFactory?: Function,
 *           allowExternalData?: boolean }} [options]
 * @returns {Promise<{ session: object, ort: object, executionProvider: string,
 *                     config: object, warnings: string[] }>}
 */
export async function createOnnxSession(model, config = {}, options = {}) {
    const resolved = normalizeOcrConfig(config);
    const warnings = [];

    if (options.probe?.usesExternalData === true && options.allowExternalData !== true) {
        // A model with weights in separate files can point at any path the
        // page can read. The clinic picked one file; loading another one on
        // the model's instruction is not a permission the user gave.
        throw codedError(
            'ONNX_EXTERNAL_DATA_UNSUPPORTED',
            'this ONNX model stores its weights in external files; a single-file model is required',
        );
    }

    const runtime = options.runtime || await loadOnnxRuntime();
    const ort = runtime.default ?? runtime;
    configureRuntime(ort, resolved);

    const bytes = await modelBytes(model);

    // `initFalcon()` and a direct adapter load do not always come through
    // `probeONNX()`. Read the graph once here as well so an external-data
    // model cannot reach the runtime through that path, and so a wrong I/O
    // contract is refused before the session allocates memory.
    if (!options.probe) {
        let graph;
        try {
            graph = parseOnnxGraph(bytes);
        } catch (error) {
            throw codedError(
                'ONNX_MODEL_UNREADABLE',
                `the ONNX graph could not be read: ${error?.message ?? error}`,
                error,
            );
        }
        if (graph.usesExternalData && options.allowExternalData !== true) {
            throw codedError(
                'ONNX_EXTERNAL_DATA_UNSUPPORTED',
                'this ONNX model stores its weights in external files; a single-file model is required',
            );
        }
        const validation = validateFalconOcrShape(graph);
        if (!validation.ok) {
            throw codedError('ONNX_IO_UNMATCHED', validation.mismatches.join('; '));
        }
    }

    const create = options.sessionFactory
        || ((data, sessionOptions) => ort.InferenceSession.create(data, sessionOptions));

    const baseOptions = {
        graphOptimizationLevel: resolved.graphOptimizationLevel,
        enableMemPattern: true,
        enableCpuMemArena: true,
        executionMode: 'sequential',
        // No `externalData` entry: the runtime cannot resolve a relative
        // path, so the model has to be self-contained.
    };

    const preferred = resolved.executionProvider === 'wasm'
        ? ['wasm']
        : [resolved.executionProvider || 'webgpu', 'wasm'];

    let session;
    let executionProvider = preferred[0];
    try {
        session = await create(bytes, { ...baseOptions, executionProviders: preferred });
    } catch (error) {
        if (preferred[0] === 'wasm') {
            throw codedError('ONNX_SESSION_FAILED', `the ONNX session could not be created: ${error?.message ?? error}`, error);
        }
        warnings.push(`${preferred[0]} could not start the OCR model; using the WASM backend`);
        executionProvider = 'wasm';
        try {
            session = await create(bytes, { ...baseOptions, executionProviders: ['wasm'] });
        } catch (fallbackError) {
            throw codedError(
                'ONNX_SESSION_FAILED',
                `the ONNX session could not be created: ${fallbackError?.message ?? fallbackError}`,
                fallbackError,
            );
        }
    }

    const mismatches = sessionIoMismatches(session);
    if (mismatches.length > 0) {
        try { session.release?.(); } catch { /* the session is going away anyway */ }
        throw codedError('ONNX_IO_UNMATCHED', mismatches.join('; '));
    }

    return { session, ort, executionProvider, config: resolved, warnings };
}

/**
 * The object the registry returns for an `onnx-falcon-ocr` probe.
 *
 * `run()` is the low-level call; `ocr()` is the high-level one and loads the
 * Falcon pipeline lazily so importing the registry does not pull in the
 * tokenizer library.
 */
export class OnnxAdapter {
    constructor(options = {}) {
        this.id = ONNX_ADAPTER_ID;
        this.kind = 'onnx';
        this.probe = options.probe || null;
        this.config = normalizeOcrConfig(options.config || {});
        this.runtime = options.runtime || null;
        this.sessionFactory = options.sessionFactory || null;
        this.session = options.session || null;
        this.ort = options.ort || null;
        this.executionProvider = options.executionProvider || null;
        this.warnings = options.warnings || [];
        this.capabilities = options.probe?.capabilities || { ocr: true };
        // Kept so `ocr()` can hand the model to the Falcon pipeline, which
        // owns the tokenizer and the strip loop.
        this.model = options.model || null;
        this.support = options.support || null;
        this.tier = options.tier || 'mid';
    }

    get loaded() {
        return Boolean(this.session);
    }

    async load(model, options = {}) {
        // A FileSystemFileHandle from the profile store is as valid a source
        // as a File; the Falcon pipeline keeps the resolved File so `ocr()`
        // can reuse it later.
        const resolvedModel = model && typeof model.getFile === 'function'
            ? await model.getFile()
            : model;
        const created = await createOnnxSession(resolvedModel, options.config || this.config, {
            runtime: options.runtime || this.runtime || undefined,
            probe: options.probe || this.probe || undefined,
            sessionFactory: options.sessionFactory || this.sessionFactory || undefined,
            allowExternalData: options.allowExternalData === true,
        });
        this.session = created.session;
        this.ort = created.ort;
        this.config = created.config;
        this.executionProvider = created.executionProvider;
        this.warnings = [...this.warnings, ...created.warnings];
        this.model = resolvedModel;
        this.support = options.support || this.support;
        this.tier = options.tier || this.tier;
        return this;
    }

    async run(feeds, options = {}) {
        if (!this.session) throw codedError('ONNX_SESSION_NOT_LOADED', 'the OCR model is not loaded');
        return this.session.run(feeds, options);
    }

    /**
     * OCR one image through the Falcon strip pipeline.
     *
     * The Falcon module owns the tokenizer and the generation loop, so it
     * owns the session too. If this adapter already opened a session it is
     * released first, keeping the one-model-at-a-time memory rule.
     */
    async ocr(image, ocrConfig = null, options = {}) {
        const falcon = await import('./falcon-ocr.js');
        if (!falcon.isReady()) {
            if (!this.model) {
                throw codedError('ONNX_MODEL_NOT_LOADED', 'load an ONNX model before asking for OCR');
            }
            this.release();
            await falcon.initFalcon(this.model, this.support, { ocr: this.config }, this.tier, options.onProgress);
        }
        return falcon.ocrImageBitmap(image, ocrConfig || this.config);
    }

    /** Free the session and its WebGPU buffers. Safe to call twice. */
    release() {
        if (this.session) {
            try { this.session.release?.(); } catch { /* the session is going away anyway */ }
        }
        this.session = null;
        this.ort = null;
    }
}

export function createOnnxAdapter(options = {}) {
    return new OnnxAdapter(options);
}

// Re-exported so callers can validate a parsed graph without another import.
export { validateFalconOcrShape };
