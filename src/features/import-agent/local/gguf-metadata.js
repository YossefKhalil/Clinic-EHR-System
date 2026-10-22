// GGUF metadata reader.
//
// A capability probe has to answer three questions about a model file before
// anything loads it: what architecture is it, does it carry a chat template,
// and does it carry a vision tower. All three live in the GGUF header, so the
// probe never has to read the multi-hundred-megabyte tensor payload.
//
// The format is the one llama.cpp reads (gguf.h):
//
//   magic "GGUF" | version u32 | tensor_count u64 | kv_count u64
//   kv_count   x { key: string, type: u32, value }
//   tensor_count x { name: string, n_dims: u32, dims: u64[], type: u32, offset: u64 }
//
// A "string" is a u64 byte length followed by UTF-8 bytes; it is not
// null-terminated.

const MAGIC = 0x46554747; // "GGUF" read as a little-endian u32

export const GGUF_VALUE_TYPES = Object.freeze({
    UINT8: 0,
    INT8: 1,
    UINT16: 2,
    INT16: 3,
    UINT32: 4,
    INT32: 5,
    FLOAT32: 6,
    BOOL: 7,
    STRING: 8,
    ARRAY: 9,
    UINT64: 10,
    INT64: 11,
    FLOAT64: 12,
});

/** Raised for a file that is not a GGUF at all (wrong magic, truncated). */
export class GgufError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'GgufError';
        this.code = code;
    }
}

class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.offset = 0;
    }

    get remaining() {
        return this.bytes.byteLength - this.offset;
    }

    u8() {
        if (this.remaining < 1) throw new GgufError('GGUF_TRUNCATED', 'unexpected end of file');
        const value = this.view.getUint8(this.offset);
        this.offset += 1;
        return value;
    }

    u32() {
        if (this.remaining < 4) throw new GgufError('GGUF_TRUNCATED', 'unexpected end of file');
        const value = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }

    u64() {
        if (this.remaining < 8) throw new GgufError('GGUF_TRUNCATED', 'unexpected end of file');
        const value = this.view.getBigUint64(this.offset, true);
        this.offset += 8;
        return Number(value);
    }

    i8() {
        if (this.remaining < 1) throw new GgufError('GGUF_TRUNCATED', 'unexpected end of file');
        const value = this.view.getInt8(this.offset);
        this.offset += 1;
        return value;
    }

    i16() {
        if (this.remaining < 2) throw new GgufError('GGUF_TRUNCATED', 'unexpected end of file');
        const value = this.view.getInt16(this.offset, true);
        this.offset += 2;
        return value;
    }

    i32() {
        if (this.remaining < 4) throw new GgufError('GGUF_TRUNCATED', 'unexpected end of file');
        const value = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return value;
    }

    i64() {
        if (this.remaining < 8) throw new GgufError('GGUF_TRUNCATED', 'unexpected end of file');
        const value = this.view.getBigInt64(this.offset, true);
        this.offset += 8;
        return Number(value);
    }

    f32() {
        if (this.remaining < 4) throw new GgufError('GGUF_TRUNCATED', 'unexpected end of file');
        const value = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return value;
    }

    f64() {
        if (this.remaining < 8) throw new GgufError('GGUF_TRUNCATED', 'unexpected end of file');
        const value = this.view.getFloat64(this.offset, true);
        this.offset += 8;
        return value;
    }

    string() {
        const length = this.u64();
        if (this.remaining < length) throw new GgufError('GGUF_TRUNCATED', 'string runs past the end of the file');
        // subarray, not new Uint8Array(view, ...): the latter copies the
        // whole buffer and ignores the offset.
        const slice = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return new TextDecoder('utf-8').decode(slice);
    }
}

function readValue(reader, type) {
    switch (type) {
        case GGUF_VALUE_TYPES.UINT8: return reader.u8();
        case GGUF_VALUE_TYPES.INT8: return reader.i8();
        case GGUF_VALUE_TYPES.UINT16: return reader.u32() & 0xffff;
        case GGUF_VALUE_TYPES.INT16: return reader.i16();
        case GGUF_VALUE_TYPES.UINT32: return reader.u32();
        case GGUF_VALUE_TYPES.INT32: return reader.i32();
        case GGUF_VALUE_TYPES.FLOAT32: return reader.f32();
        case GGUF_VALUE_TYPES.BOOL: return reader.u8() !== 0;
        case GGUF_VALUE_TYPES.STRING: return reader.string();
        case GGUF_VALUE_TYPES.UINT64: return reader.u64();
        case GGUF_VALUE_TYPES.INT64: return reader.i64();
        case GGUF_VALUE_TYPES.FLOAT64: return reader.f64();
        case GGUF_VALUE_TYPES.ARRAY: {
            const elementType = reader.u32();
            const count = reader.u64();
            // A long array of unknown values is not worth decoding; the
            // architecture and the template are the only ones we need.
            const out = [];
            for (let i = 0; i < count; i += 1) out.push(readValue(reader, elementType));
            return out;
        }
        default:
            throw new GgufError('GGUF_VALUE_TYPE_UNKNOWN', `unknown GGUF value type ${type}`);
    }
}

/**
 * Parse the header of a GGUF file.
 *
 * @param {ArrayBuffer|Uint8Array} input the file, or its first bytes
 * @returns {{ version: number, architecture: string|null, chatTemplate: string|null,
 *            contextLength: number|null, tensors: {name: string, dims: number[]}[],
 *            metadata: Record<string, unknown> }}
 */
export function parseGgufHeader(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.byteLength < 4) {
        throw new GgufError('GGUF_MAGIC_INVALID', 'file does not start with the GGUF magic');
    }
    const reader = new Reader(bytes);
    const magic = reader.u32();
    if (magic !== MAGIC) {
        throw new GgufError('GGUF_MAGIC_INVALID', 'file does not start with the GGUF magic');
    }
    if (bytes.byteLength < 24) {
        throw new GgufError('GGUF_TRUNCATED', 'file is too small to be a GGUF');
    }
    const version = reader.u32();
    const tensorCount = reader.u64();
    const kvCount = reader.u64();

    const metadata = {};
    for (let i = 0; i < kvCount; i += 1) {
        const key = reader.string();
        const type = reader.u32();
        metadata[key] = readValue(reader, type);
    }

    const tensors = [];
    for (let i = 0; i < tensorCount; i += 1) {
        const name = reader.string();
        const nDims = reader.u32();
        const dims = [];
        for (let d = 0; d < nDims; d += 1) dims.push(reader.u64());
        reader.u32(); // ggml type
        reader.u64(); // data offset
        tensors.push({ name, dims });
    }

    const architecture = typeof metadata['general.architecture'] === 'string'
        ? metadata['general.architecture']
        : null;
    const chatTemplate = typeof metadata['tokenizer.chat_template'] === 'string'
        ? metadata['tokenizer.chat_template']
        : null;
    const contextLength = architecture
        ? Number(metadata[`${architecture}.context_length`] ?? 0) || null
        : null;

    return { version, architecture, chatTemplate, contextLength, tensors, metadata };
}

/**
 * The tensor-name prefixes llama.cpp uses for a vision tower. A GGUF that
 * carries one of them can be driven through the multimodal path; a text-only
 * GGUF cannot, and the setup panel has to say so before the model is loaded.
 */
const VISION_TENSOR_PREFIXES = ['clip.', 'vision.', 'mmproj.', 'image_'];

/**
 * True when the file carries a vision tower.
 *
 * llama.cpp keeps the vision tower in a separate `.mmproj` file, and a GGUF
 * that holds one is named that way. A GGUF with the vision tower inside it
 * is found by the tensor names.
 */
export function hasVisionTensors(tensors, fileName = '') {
    if (/\.mmproj$/i.test(String(fileName ?? ''))) return true;
    return tensors.some((tensor) => VISION_TENSOR_PREFIXES.some(
        (prefix) => tensor.name.startsWith(prefix),
    ));
}

/**
 * The architectures the bundled runtime is known to execute. A GGUF for
 * anything else is refused with a specific code instead of failing inside
 * the wasm module with a stack trace the clinic cannot read.
 */
export const SUPPORTED_ARCHITECTURES = Object.freeze([
    'llama',
    'qwen2',
    'qwen3',
    'minicpm',
    'phi2',
    'phi3',
    'gemma',
    'gemma2',
    'gemma3',
    'mistral',
    'smollm',
    'starcoder2',
    'olmo2',
    'internlm2',
    'deepseek2',
]);

/** True when the architecture is on the supported list (or the list is empty). */
export function isSupportedArchitecture(architecture, supported = SUPPORTED_ARCHITECTURES) {
    if (!architecture) return false;
    if (supported.length === 0) return true;
    return supported.includes(architecture);
}
