// Adapter registry and capability probe.
//
// The setup panel must be able to say *why* a model file cannot be used
// before it is loaded, in words the clinic can act on. A model is therefore
// probed first: its format is sniffed from the bytes, its metadata is read
// without loading the weights, and the result is mapped onto an adapter.
//
// Every refusal has a specific code. "Unsupported" without a reason is the
// one answer the clinic cannot do anything with.
//
//   GGUF_ARCH_UNSUPPORTED  the architecture is not in the runtime's build
//   GGUF_TEMPLATE_MISSING  the file carries no chat template and none was set
//   GGUF_MAGIC_INVALID     the file is not a GGUF
//   VISION_GGUF_UNSUPPORTED a split-profile text slot got a vision GGUF
//   ONNX_IO_UNMATCHED      the graph's inputs/outputs match no known adapter
//   ONNX_OP_UNAVAILABLE    the graph needs an op the browser runtime lacks
//   ONNX_EXTERNAL_DATA_UNSUPPORTED the weights are outside the picked file
//   FILE_TYPE_UNKNOWN      the file is neither GGUF nor ONNX
//   FILE_MISMATCH          the extension and the bytes disagree
//
// The probe result is also the registry key: `getAdapter()` turns it into
// the object the pump calls (`complete()` for text, `run()`/`ocr()` for the
// vision model).

import {
    parseGgufHeader,
    hasVisionTensors,
    isProjectorGguf,
    isSupportedArchitecture,
    MODEL_RUNTIME,
    runtimeIdentityLabel,
    GgufError,
} from './gguf-metadata.js';
import {
    parseOnnxGraph,
    parseOnnxGraphFromBlob,
    validateFalconOcrShape,
    OnnxError,
} from './onnx-metadata.js';
import { createGgufAdapter, GGUF_ADAPTER_ID } from './gguf-adapter.js';
import { createOnnxAdapter, ONNX_ADAPTER_ID } from './onnx-adapter.js';

export const PROBE_CODES = Object.freeze({
    GGUF_ARCH_UNSUPPORTED: 'GGUF_ARCH_UNSUPPORTED',
    GGUF_TEMPLATE_MISSING: 'GGUF_TEMPLATE_MISSING',
    GGUF_MAGIC_INVALID: 'GGUF_MAGIC_INVALID',
    GGUF_TRUNCATED: 'GGUF_TRUNCATED',
    VISION_GGUF_UNSUPPORTED: 'VISION_GGUF_UNSUPPORTED',
    MMPROJ_INVALID: 'MMPROJ_INVALID',
    ONNX_IO_UNMATCHED: 'ONNX_IO_UNMATCHED',
    ONNX_OP_UNAVAILABLE: 'ONNX_OP_UNAVAILABLE',
    ONNX_EXTERNAL_DATA_UNSUPPORTED: 'ONNX_EXTERNAL_DATA_UNSUPPORTED',
    ONNX_MAGIC_INVALID: 'ONNX_MAGIC_INVALID',
    ONNX_TRUNCATED: 'ONNX_TRUNCATED',
    FILE_TYPE_UNKNOWN: 'FILE_TYPE_UNKNOWN',
    FILE_MISMATCH: 'FILE_MISMATCH',
    FILE_UNREADABLE: 'FILE_UNREADABLE',
    ADAPTER_UNKNOWN: 'ADAPTER_UNKNOWN',
    PROBE_FAILED: 'PROBE_FAILED',
});

/** The file kinds this build knows. */
export const ADAPTERS = Object.freeze({
    GGUF_TEXT: 'gguf-text',
    GGUF_MULTIMODAL: 'gguf-multimodal',
    ONNX_FALCON_OCR: ONNX_ADAPTER_ID,
});

/** The runtime ids a probe result may carry. */
export const ADAPTER_IDS = Object.freeze({
    WLLAMA: GGUF_ADAPTER_ID,
    ONNX_FALCON_OCR: ONNX_ADAPTER_ID,
});

/**
 * How many bytes the probe reads from the head of a file.
 *
 * A GGUF puts its metadata before its weights, but the metadata of a large
 * vocabulary is big: the window has to hold the keys and the tensor list,
 * or the file looks truncated.
 */
const PROBE_WINDOW = 16 * 1024 * 1024;

/** The kind a filename claims. */
export function fileKind(name) {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.gguf')) return 'gguf';
    if (lower.endsWith('.onnx')) return 'onnx';
    return 'unknown';
}

/** The kind the bytes actually are, from the magic number. */
export function sniffKind(bytes) {
    if (bytes.byteLength >= 4) {
        if (bytes[0] === 0x47 && bytes[1] === 0x47 && bytes[2] === 0x55 && bytes[3] === 0x46) return 'gguf';
        if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip'; // ONNX in a zip container
    }
    // Fast-path: reject obvious JSON files (support files like tokenizer.json)
    // before the protobuf sniffing logic misidentifies them.
    if (bytes.byteLength >= 1) {
        const first = bytes[0];
        // JSON files start with '{' (0x7B) or '[' (0x5B) or whitespace/BOM.
        if (first === 0x7b || first === 0x5b || first === 0x20 || first === 0x09 || first === 0x0a || first === 0x0d || first === 0xef) {
            return 'unknown';
        }
    }
    // An ONNX file is a protobuf. Its first field is a key, and a key is a
    // varint: a small field number with a wire type. The exporters usually
    // start with `ir_version` (1), `producer_name` (2) or `graph` (7), but
    // `producer_version` (3), `domain` (4), `model_version` (5) and
    // `doc_string` (6) are just as valid. Accept any plausible first key and
    // let the graph parser decide: guessing from one byte must not turn a
    // healthy model into FILE_TYPE_UNKNOWN.
    if (bytes.byteLength >= 1) {
        const key = bytes[0];
        const field = key >>> 3;
        const wire = key & 0x7;
        // Wire types 0 (varint), 1 (fixed64), 2 (length-delimited) and 5
        // (fixed32) are the ones a protobuf message uses for a real field.
        const plausibleWire = wire === 0 || wire === 1 || wire === 2 || wire === 5;
        if (field >= 1 && field <= 15 && plausibleWire) return 'onnx';
    }
    return 'unknown';
}

/** A FileSystemFileHandle, a File, a Blob or a byte array. */
async function resolveFile(source) {
    if (source && typeof source.getFile === 'function') return source.getFile();
    return source;
}

async function readHead(file, length) {
    if (!file) throw new Error('no file');
    if (file instanceof Uint8Array) return file;
    if (file instanceof ArrayBuffer) return new Uint8Array(file);
    if (ArrayBuffer.isView(file)) {
        return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    }
    if (typeof file.slice !== 'function') throw new Error('the file is not readable');
    const slice = file.slice(0, Math.min(length, file.size ?? length));
    return new Uint8Array(await slice.arrayBuffer());
}

function refusal(code, detail, capabilities, warnings, extra = {}) {
    return {
        ok: false,
        // `error` is the Task 3 contract; `code` keeps the existing setup
        // panel and pump working without a translation layer.
        error: code,
        code,
        adapter: null,
        capabilities,
        warnings,
        detail,
        ...extra,
    };
}

function defaultCapabilities(kind) {
    return {
        kind,
        text: kind === 'gguf',
        vision: false,
        ocr: kind === 'onnx',
        multimodal: false,
        architecture: null,
        chatTemplate: null,
        contextWindow: null,
        contextLength: null,
    };
}

/**
 * Probe a GGUF file.
 *
 * @param {{ name?: string, slice?: Function, getFile?: Function }|Uint8Array} source
 * @param {{ mode?: 'single'|'split', chatTemplate?: string|null,
 *           allowMissingTemplate?: boolean, supportedArchitectures?: string[],
 *           allowUnsupportedArchitecture?: boolean, role?: 'model'|'projector',
 *           defaultContextWindow?: number }} [options]
 * @returns {Promise<object>}
 */
export async function probeGGUF(source, options = {}) {
    const capabilities = defaultCapabilities('gguf');
    const warnings = [];
    let file;
    try {
        file = await resolveFile(source);
    } catch (error) {
        return refusal(
            PROBE_CODES.FILE_UNREADABLE,
            String(error?.message ?? 'the file could not be read'),
            capabilities,
            warnings,
        );
    }
    try {
        const header = await readGgufHeader(file);
        return probeGgufHeader(header, file?.name ?? '', options, capabilities, warnings);
    } catch (error) {
        if (error instanceof GgufError) {
            const code = error.code === 'GGUF_TRUNCATED'
                ? PROBE_CODES.GGUF_TRUNCATED
                : PROBE_CODES.GGUF_MAGIC_INVALID;
            return refusal(code, String(error.message ?? 'the file is not a readable GGUF'), capabilities, warnings);
        }
        return refusal(
            PROBE_CODES.FILE_UNREADABLE,
            String(error?.message ?? 'the file could not be read'),
            capabilities,
            warnings,
        );
    }
}

/**
 * Read enough of the file to hold the metadata. A large tokenizer can push
 * the header past the initial window; grow it rather than reporting a
 * healthy model as truncated.
 */
async function readGgufHeader(file) {
    let window = PROBE_WINDOW;
    let head = await readHead(file, window);
    for (;;) {
        try {
            return parseGgufHeader(head);
        } catch (error) {
            const size = Number(file?.size ?? 0);
            if (!(error instanceof GgufError) || error.code !== 'GGUF_TRUNCATED' || size <= head.byteLength) {
                throw error;
            }
            window = Math.min(size, Math.max(window * 4, head.byteLength + 1));
            head = await readHead(file, window);
        }
    }
}

function probeGgufHeader(header, fileName, options, capabilities, warnings) {
    const projector = isProjectorGguf(header, fileName);
    const vision = projector || hasVisionTensors(header.tensors, fileName);
    const override = typeof options.chatTemplate === 'string' && options.chatTemplate.length > 0
        ? options.chatTemplate
        : null;
    const contextWindow = Number(header.contextLength)
        || Number(options.defaultContextWindow)
        || 0;

    capabilities.architecture = header.architecture;
    capabilities.chatTemplate = override || header.chatTemplate;
    capabilities.contextWindow = contextWindow || null;
    capabilities.contextLength = contextWindow || null;
    capabilities.vision = vision;
    capabilities.multimodal = vision;
    capabilities.templateSource = override ? 'config' : (header.chatTemplate ? 'gguf' : 'builtin');

    // A projector is not a model: it has no template, no context window and
    // no chat template. It only needs to be recognised as the vision tower
    // the text model will load beside itself.
    if (options.role === 'projector') {
        capabilities.projector = true;
        if (!projector) {
            return refusal(
                PROBE_CODES.MMPROJ_INVALID,
                'this file is not a vision projector (expected the clip architecture or mmproj tensors)',
                capabilities,
                warnings,
                { params: { name: fileName || header.architecture || '?' } },
            );
        }
        return {
            ok: true,
            error: null,
            code: null,
            adapter: GGUF_ADAPTER_ID,
            capabilities,
            architecture: header.architecture,
            chatTemplate: null,
            contextWindow: null,
            projector: true,
            runtime: MODEL_RUNTIME,
            runtimeLabel: runtimeIdentityLabel(),
            warnings,
            detail: 'vision projector: it lets the text model read photos',
        };
    }

    if (!contextWindow) {
        warnings.push('the model does not declare a context window; the configured value is used');
    }

    const architectureSupported = isSupportedArchitecture(header.architecture, options.supportedArchitectures);
    capabilities.architectureSupported = architectureSupported;
    if (!architectureSupported && options.allowUnsupportedArchitecture !== true) {
        return refusal(
            PROBE_CODES.GGUF_ARCH_UNSUPPORTED,
            `the model architecture "${header.architecture ?? 'unknown'}" is not in this runtime's build`,
            capabilities,
            warnings,
            { params: { architecture: header.architecture ?? 'unknown' } },
        );
    }
    if (!architectureSupported) {
        warnings.push(
            `the architecture "${header.architecture ?? 'unknown'}" is not on the checked-in support list; loading it anyway may fail`,
        );
    }

    if (options.mode === 'split' && vision) {
        return refusal(
            PROBE_CODES.VISION_GGUF_UNSUPPORTED,
            'the split layout uses a text-only GGUF; this file carries a vision tower',
            capabilities,
            warnings,
        );
    }

    if (!header.chatTemplate && !override) {
        if (options.allowMissingTemplate !== true) {
            return refusal(
                PROBE_CODES.GGUF_TEMPLATE_MISSING,
                'the model carries no chat template; set one in the model config or choose a ChatML model',
                capabilities,
                warnings,
            );
        }
        warnings.push('the model carries no chat template; a built-in one will be used');
    } else if (!header.chatTemplate && override) {
        warnings.push('the model carries no chat template; the configured template will be used');
    }

    return {
        ok: true,
        error: null,
        code: null,
        // The Task 3 adapter id is the runtime, not the file layout. The
        // legacy `adapter` values are produced by probeModelFile().
        adapter: GGUF_ADAPTER_ID,
        capabilities,
        architecture: header.architecture,
        chatTemplate: capabilities.chatTemplate,
        contextWindow: contextWindow || null,
        runtime: MODEL_RUNTIME,
        runtimeLabel: runtimeIdentityLabel(),
        warnings,
        detail: vision
            ? 'multimodal model: it can read photos directly'
            : 'text model: photos need the separate OCR model',
    };
}

/**
 * Probe an ONNX graph.
 *
 * @param {{ name?: string, slice?: Function, getFile?: Function }|Uint8Array} source
 * @param {{ maxOpset?: number, allowExternalData?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function probeONNX(source, options = {}) {
    const capabilities = defaultCapabilities('onnx');
    const warnings = [];
    let file;
    try {
        file = await resolveFile(source);
    } catch (error) {
        return refusal(
            PROBE_CODES.FILE_UNREADABLE,
            String(error?.message ?? 'the file could not be read'),
            capabilities,
            warnings,
        );
    }

    // A real model keeps its weights inside the graph message, before the
    // inputs and outputs. Walking the file lets the probe skip those bytes
    // instead of reading a 450 MB model into memory to reach the shape
    // contract.
    if (isBlobLike(file)) return probeOnnxFile(file, options, capabilities, warnings);

    let head;
    try {
        head = await readHead(file, PROBE_WINDOW);
    } catch (error) {
        return refusal(
            PROBE_CODES.FILE_UNREADABLE,
            String(error?.message ?? 'the file could not be read'),
            capabilities,
            warnings,
        );
    }
    return probeOnnxBytes(head, options, capabilities, warnings);
}

function isBlobLike(value) {
    return value
        && typeof value.slice === 'function'
        && typeof value.size === 'number'
        && !(value instanceof Uint8Array)
        && !(value instanceof ArrayBuffer)
        && !ArrayBuffer.isView(value);
}

function onnxParseRefusal(error, capabilities, warnings) {
    const code = error instanceof OnnxError && error.code === 'ONNX_TRUNCATED'
        ? PROBE_CODES.ONNX_TRUNCATED
        : PROBE_CODES.ONNX_MAGIC_INVALID;
    return refusal(
        code,
        String(error?.message ?? 'the file is not a readable ONNX graph'),
        capabilities,
        warnings,
        {
            bytesConsumed: Number(error?.bytesConsumed) || 0,
            fileSize: Number(error?.fileSize) || 0,
        },
    );
}

async function probeOnnxFile(file, options, capabilities, warnings) {
    let graph;
    try {
        graph = await parseOnnxGraphFromBlob(file);
    } catch (error) {
        return onnxParseRefusal(error, capabilities, warnings);
    }
    return probeParsedOnnxGraph(graph, options, capabilities, warnings);
}

function probeOnnxBytes(head, options, capabilities, warnings) {
    let graph;
    try {
        graph = parseOnnxGraph(head);
    } catch (error) {
        return onnxParseRefusal(error, capabilities, warnings);
    }
    return probeParsedOnnxGraph(graph, options, capabilities, warnings);
}

function probeParsedOnnxGraph(graph, options, capabilities, warnings) {
    const maxOpset = graph.opsets.reduce((max, entry) => Math.max(max, entry.version || 0), 0);
    if (maxOpset > (options.maxOpset ?? 20)) {
        return refusal(
            PROBE_CODES.ONNX_OP_UNAVAILABLE,
            `the graph needs opset ${maxOpset}; the browser runtime supports up to ${options.maxOpset ?? 20}`,
            capabilities,
            warnings,
        );
    }
    if (graph.opsets.some((entry) => entry.domain === 'com.microsoft') && graph.opTypes.some((op) => op.startsWith('MatMulNBits'))) {
        // MatMulNBits is the 4-bit path onnxruntime-web ships, but only from
        // 1.17 on. Say so rather than failing at session creation.
        warnings.push('the graph uses 4-bit MatMul; the runtime needs onnxruntime-web 1.20 or newer');
    }
    if (graph.usesExternalData && options.allowExternalData !== true) {
        return refusal(
            PROBE_CODES.ONNX_EXTERNAL_DATA_UNSUPPORTED,
            'the model stores its weights in external files; a single-file model is required',
            capabilities,
            warnings,
            { usesExternalData: true },
        );
    }

    const validation = validateFalconOcrShape(graph);
    warnings.push(...validation.warnings);
    if (!validation.ok) {
        return refusal(
            PROBE_CODES.ONNX_IO_UNMATCHED,
            validation.mismatches.join('; '),
            capabilities,
            warnings,
            {
                mismatches: validation.mismatches,
                inputShapes: Object.fromEntries(graph.inputs.map((input) => [input.name, input.dims])),
                outputShapes: Object.fromEntries(graph.outputs.map((output) => [output.name, output.dims])),
            },
        );
    }

    const inputShapes = Object.fromEntries(graph.inputs.map((input) => [input.name, input.dims]));
    const outputShapes = Object.fromEntries(graph.outputs.map((output) => [output.name, output.dims]));
    capabilities.ocr = true;
    capabilities.graph = {
        inputs: graph.inputs.map((input) => ({ name: input.name, dtype: input.dtype, dims: input.dims })),
        outputs: graph.outputs.map((output) => ({ name: output.name, dtype: output.dtype, dims: output.dims })),
        opTypes: graph.opTypes,
    };
    capabilities.inputShapes = inputShapes;
    capabilities.outputShapes = outputShapes;

    return {
        ok: true,
        error: null,
        code: null,
        adapter: ONNX_ADAPTER_ID,
        capabilities,
        inputShapes,
        outputShapes,
        warnings,
        usesExternalData: false,
        detail: 'OCR model: it turns photos into text',
    };
}

/**
 * Probe a model file and map it onto the adapter registry.
 *
 * This is the compatibility entry point the settings panel already calls.
 * It keeps the legacy `gguf-text` / `gguf-multimodal` adapter ids; the Task 3
 * `probeGGUF` / `probeONNX` functions return the runtime ids.
 *
 * @param {{ name: string, size?: number, slice?: Function }} file a File or a
 *        file-like object exposing `slice(start, end)`
 * @param {{ supportedArchitectures?: string[] }} [options]
 */
export async function probeModelFile(file, options = {}) {
    const warnings = [];
    const name = String(file?.name ?? '');
    const claimed = fileKind(name);
    const capabilities = defaultCapabilities(claimed === 'onnx' || claimed === 'gguf' ? claimed : 'unknown');

    let head;
    try {
        head = await readHead(file, PROBE_WINDOW);
    } catch (error) {
        return refusal(
            PROBE_CODES.FILE_UNREADABLE,
            String(error?.message ?? 'the file could not be read'),
            capabilities,
            warnings,
        );
    }

    const actual = sniffKind(head);
    if (actual === 'unknown') {
        return refusal(
            PROBE_CODES.FILE_TYPE_UNKNOWN,
            'the file is neither a GGUF model nor an ONNX graph',
            capabilities,
            warnings,
        );
    }
    if (claimed !== 'unknown' && claimed !== actual) {
        return refusal(
            PROBE_CODES.FILE_MISMATCH,
            `the file is named .${claimed} but its bytes say .${actual}`,
            capabilities,
            warnings,
        );
    }

    if (actual === 'gguf') {
        const result = await probeGGUF(file, {
            ...options,
            // The settings panel has always let a template-less GGUF load
            // with the built-in ChatML template; the stricter Task 3 probe
            // is the one that refuses it.
            allowMissingTemplate: options.allowMissingTemplate ?? true,
        });
        if (!result.ok) return result;
        return {
            ...result,
            adapter: result.capabilities.vision ? ADAPTERS.GGUF_MULTIMODAL : ADAPTERS.GGUF_TEXT,
        };
    }

    const result = isBlobLike(file)
        ? await probeONNX(file, options)
        : probeOnnxBytes(head, options, capabilities, warnings);
    if (result.ok) return result;
    // A protobuf that is not a graph is still FILE_TYPE_UNKNOWN in the legacy
    // panel. A truncated graph keeps the precise ONNX_TRUNCATED code: the
    // clinic can tell a partial download from a wrong file, and the card has
    // a translated message for it.
    if (result.error === PROBE_CODES.ONNX_MAGIC_INVALID) {
        return { ...result, error: PROBE_CODES.FILE_TYPE_UNKNOWN, code: PROBE_CODES.FILE_TYPE_UNKNOWN };
    }
    return result;
}

/** The adapter ids the registry can build. */
export const ADAPTER_REGISTRY = Object.freeze({
    [GGUF_ADAPTER_ID]: {
        kind: 'gguf',
        create: (options) => createGgufAdapter(options),
    },
    [ADAPTERS.GGUF_TEXT]: {
        kind: 'gguf',
        create: (options) => createGgufAdapter({ ...options, mode: options.mode || 'split' }),
    },
    [ADAPTERS.GGUF_MULTIMODAL]: {
        kind: 'gguf',
        create: (options) => createGgufAdapter({ ...options, mode: options.mode || 'single' }),
    },
    [ONNX_ADAPTER_ID]: {
        kind: 'onnx',
        create: (options) => createOnnxAdapter(options),
    },
});

/** The adapters this build ships, for the settings panel. */
export function listAdapters() {
    return Object.entries(ADAPTER_REGISTRY).map(([id, entry]) => ({ id, kind: entry.kind }));
}

/**
 * Map a probe result (or an adapter id) onto an adapter instance.
 *
 * The instance is not loaded yet. Call `load(source)` and then `complete()`
 * (GGUF) or `run()`/`ocr()` (ONNX).
 *
 * @param {object|string} probeResult
 * @param {{ mode?: 'single'|'split', config?: object, tier?: string,
 *           runtime?: object, provider?: object, providerFactory?: Function }} [options]
 */
export function getAdapter(probeResult, options = {}) {
    const failed = probeResult && typeof probeResult === 'object'
        && (probeResult.ok === false || (Boolean(probeResult.error) && !probeResult.adapter));
    if (failed) {
        const error = new Error(probeResult.detail || 'the model probe failed');
        error.code = probeResult.error || probeResult.code || PROBE_CODES.PROBE_FAILED;
        throw error;
    }

    const id = typeof probeResult === 'string' ? probeResult : probeResult?.adapter;
    const entry = ADAPTER_REGISTRY[id];
    if (!entry) {
        const error = new Error(`no adapter is registered for ${id ?? 'an unknown file'}`);
        error.code = PROBE_CODES.ADAPTER_UNKNOWN;
        throw error;
    }

    const capabilities = typeof probeResult === 'object' ? probeResult.capabilities : null;
    const defaultsToSingle = capabilities?.vision === true || id === ADAPTERS.GGUF_MULTIMODAL;
    const mode = options.mode || (defaultsToSingle ? 'single' : 'split');
    return entry.create({
        ...options,
        mode,
        probe: typeof probeResult === 'object' ? probeResult : null,
        capabilities,
    });
}
