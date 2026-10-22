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
//   GGUF_TEMPLATE_MISSING  the file carries no chat template
//   ONNX_IO_UNMATCHED      the graph's inputs/outputs match no known adapter
//   ONNX_OP_UNAVAILABLE    the graph needs an op the browser runtime lacks
//   FILE_TYPE_UNKNOWN      the file is neither GGUF nor ONNX
//   FILE_MISMATCH          the extension and the bytes disagree

import { parseGgufHeader, hasVisionTensors, isSupportedArchitecture, GgufError } from './gguf-metadata.js';
import { parseOnnxGraph, matchesFalconOcrShape, OnnxError } from './onnx-metadata.js';

export const PROBE_CODES = Object.freeze({
    GGUF_ARCH_UNSUPPORTED: 'GGUF_ARCH_UNSUPPORTED',
    GGUF_TEMPLATE_MISSING: 'GGUF_TEMPLATE_MISSING',
    ONNX_IO_UNMATCHED: 'ONNX_IO_UNMATCHED',
    ONNX_OP_UNAVAILABLE: 'ONNX_OP_UNAVAILABLE',
    FILE_TYPE_UNKNOWN: 'FILE_TYPE_UNKNOWN',
    FILE_MISMATCH: 'FILE_MISMATCH',
    FILE_UNREADABLE: 'FILE_UNREADABLE',
});

/** The file kinds this build knows. */
export const ADAPTERS = Object.freeze({
    GGUF_TEXT: 'gguf-text',
    GGUF_MULTIMODAL: 'gguf-multimodal',
    ONNX_FALCON_OCR: 'onnx-falcon-ocr',
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
    // An ONNX file is a protobuf. Its first field is a key, and a key is a
    // varint: a small field number with a wire type. `ir_version` (field 1)
    // and `graph` (field 7) are the two the exporters put first.
    if (bytes.byteLength >= 1) {
        const key = bytes[0];
        const field = key >>> 3;
        const wire = key & 0x7;
        if ((field === 1 && wire === 0) || (field === 7 && wire === 2) || (field === 2 && wire === 2)) {
            return 'onnx';
        }
    }
    return 'unknown';
}

async function readHead(file, length) {
    const slice = file.slice(0, Math.min(length, file.size ?? length));
    return new Uint8Array(await slice.arrayBuffer());
}

/**
 * Probe a model file and map it onto an adapter.
 *
 * @param {{ name: string, size?: number, slice?: Function }} file a File or a
 *        file-like object exposing `slice(start, end)`
 * @param {{ supportedArchitectures?: string[] }} [options]
 * @returns {Promise<{ ok: boolean, code: string|null, adapter: string|null,
 *                     capabilities: object, warnings: string[], detail: string }>}
 */
export async function probeModelFile(file, options = {}) {
    const warnings = [];
    const name = String(file?.name ?? '');
    const claimed = fileKind(name);
    const capabilities = { kind: claimed, multimodal: false, chatTemplate: null, architecture: null, contextLength: null };

    let head;
    try {
        head = await readHead(file, PROBE_WINDOW);
    } catch (error) {
        return {
            ok: false,
            code: PROBE_CODES.FILE_UNREADABLE,
            adapter: null,
            capabilities,
            warnings,
            detail: String(error?.message ?? 'the file could not be read'),
        };
    }

    const actual = sniffKind(head);
    if (actual === 'unknown') {
        return {
            ok: false,
            code: PROBE_CODES.FILE_TYPE_UNKNOWN,
            adapter: null,
            capabilities,
            warnings,
            detail: 'the file is neither a GGUF model nor an ONNX graph',
        };
    }
    if (claimed !== 'unknown' && claimed !== actual) {
        return {
            ok: false,
            code: PROBE_CODES.FILE_MISMATCH,
            adapter: null,
            capabilities,
            warnings,
            detail: `the file is named .${claimed} but its bytes say .${actual}`,
        };
    }

    if (actual === 'gguf') return probeGguf(head, capabilities, warnings, options, file.name);
    return probeOnnx(head, capabilities, warnings, options);
}

function probeGguf(head, capabilities, warnings, options, fileName = '') {
    let header;
    try {
        header = parseGgufHeader(head);
    } catch (error) {
        const truncated = error instanceof GgufError && error.code === 'GGUF_TRUNCATED';
        return {
            ok: false,
            code: truncated ? PROBE_CODES.FILE_UNREADABLE : PROBE_CODES.FILE_TYPE_UNKNOWN,
            adapter: null,
            capabilities,
            warnings,
            detail: truncated
                ? 'the model header runs past the bytes that were read'
                : String(error?.message ?? 'the file is not a readable GGUF'),
        };
    }

    capabilities.architecture = header.architecture;
    capabilities.chatTemplate = header.chatTemplate;
    capabilities.contextLength = header.contextLength;
    capabilities.multimodal = hasVisionTensors(header.tensors, fileName);

    if (!isSupportedArchitecture(header.architecture, options.supportedArchitectures)) {
        return {
            ok: false,
            code: PROBE_CODES.GGUF_ARCH_UNSUPPORTED,
            adapter: null,
            capabilities,
            warnings,
            detail: `the model architecture "${header.architecture ?? 'unknown'}" is not in this runtime's build`,
        };
    }
    if (!header.chatTemplate) {
        warnings.push('the model carries no chat template; a built-in one will be used');
    }

    return {
        ok: true,
        code: null,
        adapter: capabilities.multimodal ? ADAPTERS.GGUF_MULTIMODAL : ADAPTERS.GGUF_TEXT,
        capabilities,
        warnings,
        detail: capabilities.multimodal
            ? 'multimodal model: it can read photos directly'
            : 'text model: photos need the separate OCR model',
    };
}

function probeOnnx(head, capabilities, warnings, options) {
    let graph;
    try {
        graph = parseOnnxGraph(head);
    } catch (error) {
        const truncated = error instanceof OnnxError && error.code === 'ONNX_TRUNCATED';
        return {
            ok: false,
            code: truncated ? PROBE_CODES.FILE_UNREADABLE : PROBE_CODES.FILE_TYPE_UNKNOWN,
            adapter: null,
            capabilities,
            warnings,
            detail: truncated
                ? 'the graph header runs past the bytes that were read'
                : String(error?.message ?? 'the file is not a readable ONNX graph'),
        };
    }

    const opsets = graph.opsets.map((entry) => entry.domain || 'ai.onnx').join(', ');
    const maxOpset = graph.opsets.reduce((max, entry) => Math.max(max, entry.version || 0), 0);
    if (maxOpset > (options.maxOpset ?? 20)) {
        return {
            ok: false,
            code: PROBE_CODES.ONNX_OP_UNAVAILABLE,
            adapter: null,
            capabilities,
            warnings,
            detail: `the graph needs opset ${maxOpset}; the browser runtime supports up to ${options.maxOpset ?? 20}`,
        };
    }
    if (opsets.includes('com.microsoft') && graph.opTypes.some((op) => op.startsWith('MatMulNBits'))) {
        // MatMulNBits is the 4-bit path onnxruntime-web ships, but only from
        // 1.17 on. Say so rather than failing at session creation.
        warnings.push('the graph uses 4-bit MatMul; the runtime needs onnxruntime-web 1.20 or newer');
    }

    if (!matchesFalconOcrShape(graph)) {
        return {
            ok: false,
            code: PROBE_CODES.ONNX_IO_UNMATCHED,
            adapter: null,
            capabilities,
            warnings,
            detail: `the graph's inputs (${graph.inputs.map((i) => i.name).join(', ')}) match no known vision adapter`,
        };
    }

    capabilities.graph = {
        inputs: graph.inputs.map((input) => ({ name: input.name, dtype: input.dtype, dims: input.dims })),
        outputs: graph.outputs.map((output) => ({ name: output.name, dtype: output.dtype, dims: output.dims })),
        opTypes: graph.opTypes,
    };

    return {
        ok: true,
        code: null,
        adapter: ADAPTERS.ONNX_FALCON_OCR,
        capabilities,
        warnings,
        detail: 'OCR model: it turns photos into text',
    };
}
