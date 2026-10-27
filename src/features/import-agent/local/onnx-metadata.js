// ONNX graph metadata reader.
//
// The capability probe has to know a vision model's inputs and outputs before
// it loads 450 MB of weights. ONNX Runtime can only tell us that after the
// session is created — by then the file is already in memory — so the probe
// reads the protobuf header itself.
//
// Only the parts the probe needs are decoded:
//
//   ModelProto      field 7  -> graph
//   GraphProto      field 1  -> node (op types), 11 -> input, 12 -> output
//   ValueInfoProto  field 1  -> name, 2 -> type
//   TypeProto       field 1  -> tensor_type
//   Tensor          field 1  -> elem_type, 2 -> shape
//   TensorShape     field 1  -> dim
//   Dimension       field 1  -> dim_value, 2 -> dim_param
//
// The weights themselves live outside the protobuf, so the graph message
// stays small; the reader reports how many bytes it consumed so the caller
// can re-read with a bigger window if the graph does not fit.

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

/** ONNX TensorProto.DataType values the probe cares about. */
export const ONNX_DTYPES = Object.freeze({
    1: 'float32', 2: 'uint8', 3: 'int8', 4: 'uint16', 5: 'int16', 6: 'int32',
    7: 'int64', 8: 'string', 9: 'bool', 10: 'float16', 11: 'float64',
    12: 'uint32', 13: 'uint64', 14: 'complex64', 15: 'complex128', 16: 'bfloat16',
});

/** Raised when the file is not an ONNX model, or the graph cannot be read. */
export class OnnxError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.name = 'OnnxError';
        this.code = code;
        Object.assign(this, extra);
    }
}

class ProtoReader {
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.offset = 0;
    }

    get remaining() {
        return this.bytes.byteLength - this.offset;
    }

    /** A truncation error that says where the file ended. */
    truncated(message, expectedEnd = null) {
        const extra = {
            bytesConsumed: this.offset,
            fileSize: this.bytes.byteLength,
        };
        if (expectedEnd !== null) extra.expectedEnd = expectedEnd;
        return new OnnxError('ONNX_TRUNCATED', message, extra);
    }

    varint() {
        let result = 0;
        let shift = 0;
        for (;;) {
            if (this.remaining < 1) throw this.truncated('unexpected end of protobuf');
            const byte = this.view.getUint8(this.offset);
            this.offset += 1;
            result += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0) return result;
            shift += 7;
            if (shift > 63) throw this.truncated('varint is too long');
        }
    }

    skip(wireType) {
        switch (wireType) {
            case WIRE_VARINT: this.varint(); return;
            case WIRE_FIXED64: this.offset += 8; return;
            case WIRE_LENGTH: this.offset += this.varint(); return;
            case WIRE_FIXED32: this.offset += 4; return;
            // Wire types 3 (start group) and 4 (end group) are deprecated in protobuf
            // but ONNX files may still contain them. Skip them.
            // Wire types 6 and 7 are reserved; some tools may emit them. Skip gracefully.
            case 3: this.skipGroup(); return;
            case 4: return; // end group - just return
            case 6:
            case 7:
                // Reserved wire types - skip as length-delimited with zero length
                // to avoid throwing on malformed or non-ONNX protobuf data.
                return;
            default:
                throw new OnnxError('ONNX_WIRE_TYPE_UNKNOWN', `unknown protobuf wire type ${wireType}`);
        }
    }

    // Skip a deprecated protobuf group (wire type 3)
    skipGroup() {
        let depth = 1;
        while (depth > 0 && this.remaining > 0) {
            const key = this.varint();
            const _field = key >>> 3;
            const wire = key & 0x7;
            if (wire === 3) depth++;
            else if (wire === 4) depth--;
            else this.skip(wire);
        }
    }

    bytesField() {
        const length = this.varint();
        if (this.remaining < length) {
            throw this.truncated('field runs past the end of the buffer', this.offset + length);
        }
        // subarray, not new Uint8Array(view, ...): the latter copies the
        // whole buffer and ignores the offset.
        const slice = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return slice;
    }

    stringField() {
        return new TextDecoder('utf-8').decode(this.bytesField());
    }
}

/**
 * Walk a protobuf message and call `onField(fieldNumber, wireType, reader)`
 * for every field. The callback must consume the field it wants; anything
 * else is skipped.
 */
function walk(reader, onField) {
    while (reader.remaining > 0) {
        const key = reader.varint();
        const fieldNumber = key >>> 3;
        const wireType = key & 0x7;
        const handled = onField(fieldNumber, wireType, reader);
        if (!handled) reader.skip(wireType);
    }
}

function readTensorType(reader) {
    const out = { elemType: null, dtype: null, shape: [], dims: [] };
    walk(reader, (field, wire, r) => {
        if (field === 1 && wire === WIRE_VARINT) {
            out.elemType = r.varint();
            out.dtype = ONNX_DTYPES[out.elemType] ?? `type_${out.elemType}`;
            return true;
        }
        if (field === 2 && wire === WIRE_LENGTH) {
            const shapeBytes = r.bytesField();
            const shapeReader = new ProtoReader(shapeBytes);
            walk(shapeReader, (shapeField, shapeWire, sr) => {
                if (shapeField === 1 && shapeWire === WIRE_LENGTH) {
                    const dimBytes = sr.bytesField();
                    const dimReader = new ProtoReader(dimBytes);
                    walk(dimReader, (dimField, dimWire, dr) => {
                        if (dimField === 1 && dimWire === WIRE_VARINT) {
                            out.dims.push(dr.varint());
                            return true;
                        }
                        if (dimField === 2 && dimWire === WIRE_LENGTH) {
                            out.dims.push(dr.stringField());
                            return true;
                        }
                        return false;
                    });
                    return true;
                }
                return false;
            });
            return true;
        }
        return false;
    });
    return out;
}

function readValueInfo(reader) {
    const info = { name: '', elemType: null, dtype: null, dims: [] };
    walk(reader, (field, wire, r) => {
        if (field === 1 && wire === WIRE_LENGTH) {
            info.name = r.stringField();
            return true;
        }
        if (field === 2 && wire === WIRE_LENGTH) {
            const typeBytes = r.bytesField();
            const typeReader = new ProtoReader(typeBytes);
            walk(typeReader, (typeField, typeWire, tr) => {
                if (typeField === 1 && typeWire === WIRE_LENGTH) {
                    const tensorBytes = tr.bytesField();
                    const tensorReader = new ProtoReader(tensorBytes);
                    const tensor = readTensorType(tensorReader);
                    info.elemType = tensor.elemType;
                    info.dtype = tensor.dtype;
                    info.dims = tensor.dims;
                    return true;
                }
                return false;
            });
            return true;
        }
        return false;
    });
    return info;
}

/**
 * Read the graph header of an ONNX model.
 *
 * @param {Uint8Array} bytes the first bytes of the file
 * @returns {{ inputs: object[], outputs: object[], opTypes: string[],
 *            opsets: {domain: string, version: number}[], irVersion: number|null,
 *            bytesConsumed: number }}
 */
export function parseOnnxGraph(bytes) {
    const reader = new ProtoReader(bytes);
    const out = {
        inputs: [],
        outputs: [],
        opTypes: [],
        opsets: [],
        irVersion: null,
        // A graph whose weights live in separate files is refused: the local
        // engine only loads a self-contained model, and a relative path in a
        // model file must never be able to read another file from the PC.
        usesExternalData: false,
        bytesConsumed: 0,
    };
    let graphBytes = null;

    walk(reader, (field, wire, r) => {
        if (field === 1 && wire === WIRE_VARINT) {
            out.irVersion = r.varint();
            return true;
        }
        if (field === 7 && wire === WIRE_LENGTH) {
            graphBytes = r.bytesField();
            return true;
        }
        if (field === 8 && wire === WIRE_LENGTH) {
            const opsetBytes = r.bytesField();
            const opsetReader = new ProtoReader(opsetBytes);
            const entry = { domain: '', version: 0 };
            walk(opsetReader, (opsetField, opsetWire, or) => {
                if (opsetField === 1 && opsetWire === WIRE_LENGTH) {
                    entry.domain = or.stringField();
                    return true;
                }
                if (opsetField === 2 && opsetWire === WIRE_VARINT) {
                    entry.version = or.varint();
                    return true;
                }
                return false;
            });
            out.opsets.push(entry);
            return true;
        }
        return false;
    });

    if (!graphBytes) {
        throw new OnnxError('ONNX_GRAPH_MISSING', 'the file has no graph');
    }
    const graphReader = new ProtoReader(graphBytes);
    walk(graphReader, (field, wire, r) => {
        if (field === 1 && wire === WIRE_LENGTH) {
            const nodeBytes = r.bytesField();
            const nodeReader = new ProtoReader(nodeBytes);
            walk(nodeReader, (nodeField, nodeWire, nr) => {
                if (nodeField === 4 && nodeWire === WIRE_LENGTH) {
                    out.opTypes.push(nr.stringField());
                    return true;
                }
                return false;
            });
            return true;
        }
        if (field === 5 && wire === WIRE_LENGTH) {
            // GraphProto.initializer -> TensorProto. We only look at the
            // external-data marker; the weights themselves stay unread.
            const tensorReader = new ProtoReader(r.bytesField());
            walk(tensorReader, (tensorField, tensorWire, tr) => {
                if (tensorField === 14 && tensorWire === WIRE_VARINT) {
                    // TensorProto.data_location == EXTERNAL (1)
                    if (tr.varint() === 1) out.usesExternalData = true;
                    return true;
                }
                if (tensorField === 13 && tensorWire === WIRE_LENGTH) {
                    // TensorProto.external_data is only present for a tensor
                    // stored outside the model.
                    tr.bytesField();
                    out.usesExternalData = true;
                    return true;
                }
                return false;
            });
            return true;
        }
        if (field === 11 && wire === WIRE_LENGTH) {
            out.inputs.push(readValueInfo(new ProtoReader(r.bytesField())));
            return true;
        }
        if (field === 12 && wire === WIRE_LENGTH) {
            out.outputs.push(readValueInfo(new ProtoReader(r.bytesField())));
            return true;
        }
        return false;
    });

    out.bytesConsumed = reader.offset;
    return out;
}

// ---------------------------------------------------------------------------
// Streaming reader
// ---------------------------------------------------------------------------
//
// A single-file ONNX model carries its weights as GraphProto.initializer
// entries, and the C++ protobuf writer emits the initializers before the
// graph inputs and outputs. A probe that reads only the first few megabytes
// therefore stops inside the weights and never sees the shape contract.
//
// The reader below walks the protobuf without buffering a length-delimited
// field: `skip()` only moves the file offset. TensorProto.raw_data (field 9)
// is the large field; the only fields the probe reads are the small metadata
// messages and the external-data marker inside each initializer.

const MAX_METADATA_MESSAGE = 4 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;

class BlobProtoReader {
    constructor(blob, start = 0, end = blob.size) {
        this.blob = blob;
        this.pos = start;
        this.end = Math.min(end, blob.size);
        this.cache = null;
        this.cacheStart = 0;
        if (this.pos < 0 || this.end < this.pos) {
            throw new OnnxError('ONNX_TRUNCATED', 'the graph runs past the end of the file', {
                bytesConsumed: this.pos,
                fileSize: blob.size,
            });
        }
    }

    get remaining() {
        return this.end - this.pos;
    }

    /** A truncation error that says where the file ended. */
    truncated(message, expectedEnd = null) {
        const extra = {
            bytesConsumed: this.pos,
            fileSize: this.blob.size,
        };
        if (expectedEnd !== null) extra.expectedEnd = expectedEnd;
        return new OnnxError('ONNX_TRUNCATED', message, extra);
    }

    async fill() {
        if (this.remaining <= 0) throw this.truncated('unexpected end of protobuf');
        const length = Math.min(READ_CHUNK, this.remaining);
        const buffer = await this.blob.slice(this.pos, this.pos + length).arrayBuffer();
        if (buffer.byteLength !== length) {
            throw this.truncated('the file ended while it was being read');
        }
        this.cache = new Uint8Array(buffer);
        this.cacheStart = this.pos;
    }

    async byte() {
        if (this.pos >= this.end) throw this.truncated('unexpected end of protobuf');
        const offset = this.pos - this.cacheStart;
        if (!this.cache || offset < 0 || offset >= this.cache.length) await this.fill();
        return this.cache[this.pos++ - this.cacheStart];
    }

    async varint() {
        let result = 0;
        let shift = 0;
        for (;;) {
            const byte = await this.byte();
            result += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0) return result;
            shift += 7;
            if (shift > 63) throw this.truncated('varint is too long');
        }
    }

    async skip(length) {
        if (length < 0 || length > this.remaining) {
            throw this.truncated('field runs past the end of the file', this.pos + Math.max(0, length));
        }
        this.pos += length;
    }

    async bytes(length) {
        if (length < 0 || length > this.remaining) {
            throw this.truncated('field runs past the end of the file', this.pos + Math.max(0, length));
        }
        const buffer = await this.blob.slice(this.pos, this.pos + length).arrayBuffer();
        if (buffer.byteLength !== length) {
            throw this.truncated('the file ended while it was being read', this.pos + length);
        }
        this.pos += length;
        return new Uint8Array(buffer);
    }

    /** A bounded view over the next `length` bytes; the parent moves past it. */
    async sub(length) {
        if (length < 0 || length > this.remaining) {
            throw this.truncated('field runs past the end of the file', this.pos + Math.max(0, length));
        }
        const child = new BlobProtoReader(this.blob, this.pos, this.pos + length);
        this.pos += length;
        return child;
    }
}

async function skipBlobGroup(reader) {
    let depth = 1;
    while (depth > 0 && reader.remaining > 0) {
        const key = await reader.varint();
        const wire = key & 0x7;
        if (wire === 3) depth += 1;
        else if (wire === 4) depth -= 1;
        else await skipBlobField(reader, wire);
    }
}

async function skipBlobField(reader, wireType) {
    switch (wireType) {
        case WIRE_VARINT: await reader.varint(); return;
        case WIRE_FIXED64: await reader.skip(8); return;
        case WIRE_LENGTH: await reader.skip(await reader.varint()); return;
        case WIRE_FIXED32: await reader.skip(4); return;
        case 3: await skipBlobGroup(reader); return;
        case 4: return;
        // Wire types 6 and 7 are reserved; some tools may emit them. Skip gracefully.
        case 6:
        case 7:
            return;
        default: throw new OnnxError('ONNX_WIRE_TYPE_UNKNOWN', `unknown protobuf wire type ${wireType}`);
    }
}

async function readBlobMessage(reader, maxBytes = MAX_METADATA_MESSAGE) {
    const length = await reader.varint();
    if (length > reader.remaining) {
        throw reader.truncated('field runs past the end of the file', reader.pos + length);
    }
    if (length > maxBytes) {
        await reader.skip(length);
        return null;
    }
    return reader.bytes(length);
}

function readOpsetBytes(bytes) {
    const entry = { domain: '', version: 0 };
    walk(new ProtoReader(bytes), (field, wire, reader) => {
        if (field === 1 && wire === WIRE_LENGTH) {
            entry.domain = reader.stringField();
            return true;
        }
        if (field === 2 && wire === WIRE_VARINT) {
            entry.version = reader.varint();
            return true;
        }
        return false;
    });
    return entry;
}

async function parseBlobTensor(reader, out) {
    while (reader.remaining > 0) {
        const key = await reader.varint();
        const field = key >>> 3;
        const wire = key & 0x7;
        if (field === 14 && wire === WIRE_VARINT) {
            if (await reader.varint() === 1) out.usesExternalData = true;
            continue;
        }
        if (field === 13 && wire === WIRE_LENGTH) {
            // external_data is only present when the bytes are elsewhere.
            await reader.skip(await reader.varint());
            out.usesExternalData = true;
            continue;
        }
        await skipBlobField(reader, wire);
    }
}

async function parseBlobGraph(reader, out) {
    while (reader.remaining > 0) {
        const key = await reader.varint();
        const field = key >>> 3;
        const wire = key & 0x7;
        if (field === 1 && wire === WIRE_LENGTH) {
            const bytes = await readBlobMessage(reader);
            if (bytes) {
                walk(new ProtoReader(bytes), (nodeField, nodeWire, nodeReader) => {
                    if (nodeField === 4 && nodeWire === WIRE_LENGTH) {
                        out.opTypes.push(nodeReader.stringField());
                        return true;
                    }
                    return false;
                });
            }
            continue;
        }
        if (field === 5 && wire === WIRE_LENGTH) {
            const length = await reader.varint();
            if (length > reader.remaining) throw reader.truncated('initializer runs past the end of the file', reader.pos + length);
            await parseBlobTensor(await reader.sub(length), out);
            continue;
        }
        if ((field === 11 || field === 12) && wire === WIRE_LENGTH) {
            const bytes = await readBlobMessage(reader);
            if (bytes) {
                const info = readValueInfo(new ProtoReader(bytes));
                (field === 11 ? out.inputs : out.outputs).push(info);
            }
            continue;
        }
        await skipBlobField(reader, wire);
    }
}

async function parseBlobModel(reader, out) {
    let graphSeen = false;
    while (reader.remaining > 0) {
        const key = await reader.varint();
        const field = key >>> 3;
        const wire = key & 0x7;
        if (field === 1 && wire === WIRE_VARINT) {
            out.irVersion = await reader.varint();
            continue;
        }
        if (field === 7 && wire === WIRE_LENGTH) {
            const length = await reader.varint();
            if (length > reader.remaining) throw reader.truncated('graph runs past the end of the file', reader.pos + length);
            graphSeen = true;
            await parseBlobGraph(await reader.sub(length), out);
            continue;
        }
        if (field === 8 && wire === WIRE_LENGTH) {
            const bytes = await readBlobMessage(reader);
            if (bytes) out.opsets.push(readOpsetBytes(bytes));
            continue;
        }
        await skipBlobField(reader, wire);
    }
    if (!graphSeen) throw new OnnxError('ONNX_GRAPH_MISSING', 'the file has no graph');
    out.bytesConsumed = reader.pos;
    return out;
}

/**
 * Read a graph without loading the weights.
 *
 * This is the probe used for a real file. The in-memory `parseOnnxGraph()`
 * remains the entry point for tests and for a caller that already has the
 * bytes; both return the same shape.
 *
 * @param {Blob|File|{ slice: Function, size: number }} blob
 * @returns {Promise<object>}
 */
export async function parseOnnxGraphFromBlob(blob) {
    if (!blob || typeof blob.slice !== 'function' || typeof blob.size !== 'number') {
        throw new OnnxError('ONNX_MAGIC_INVALID', 'the source is not a readable ONNX file');
    }
    const reader = new BlobProtoReader(blob, 0, blob.size);
    return parseBlobModel(reader, {
        inputs: [],
        outputs: [],
        opTypes: [],
        opsets: [],
        irVersion: null,
        usesExternalData: false,
        bytesConsumed: 0,
    });
}

/** The Falcon-OCR graph shape this build knows how to drive. */
export const FALCON_OCR_SIGNATURE = Object.freeze({
    inputs: ['tokens', 'image_patches', 'pos_t', 'pos_hw', 'attention_mask', 'past_key_values'],
    outputs: ['next_token', 'present_key_values'],
});

/**
 * What each Falcon-OCR tensor must look like.
 *
 * Names are not enough: a graph can have an input called `tokens` of the
 * wrong rank, or a `present_key_values` with the wrong layer count, and
 * fail deep inside the runtime after a long load. The fixed dimensions are
 * the ones the exported graph hard-codes; a symbolic dimension is allowed
 * (the exporter names the batch/sequence axes) and reported as a warning.
 */
export const FALCON_OCR_RULES = Object.freeze({
    inputs: {
        tokens: { dtype: 'int64', rank: 2 },
        image_patches: { dtype: 'float32', rank: 3, fixed: { 2: 768 } },
        pos_t: { dtype: 'int64', rank: 2 },
        pos_hw: { dtype: 'float32', rank: 3, fixed: { 2: 2 } },
        attention_mask: { dtype: 'bool', rank: 3 },
        past_key_values: { dtype: 'float32', rank: 6, fixed: { 0: 22, 1: 2, 3: 16, 5: 64 } },
    },
    outputs: {
        next_token: { dtype: 'int64', rank: 1 },
        present_key_values: { dtype: 'float32', rank: 6, fixed: { 0: 22, 1: 2, 3: 16, 5: 64 } },
    },
});

function checkTensor(name, actual, rule, direction, mismatches, warnings) {
    if (!actual) {
        mismatches.push(`${direction} "${name}" is missing`);
        return;
    }
    if (rule.dtype && actual.dtype !== rule.dtype) {
        mismatches.push(`${direction} "${name}" is ${actual.dtype}, expected ${rule.dtype}`);
    }
    if (rule.rank && actual.dims.length !== rule.rank) {
        mismatches.push(`${direction} "${name}" has rank ${actual.dims.length}, expected ${rule.rank}`);
        return;
    }
    for (const [indexText, expected] of Object.entries(rule.fixed ?? {})) {
        const index = Number(indexText);
        const value = actual.dims[index];
        if (value === undefined) {
            mismatches.push(`${direction} "${name}" has no dimension ${index}`);
        } else if (typeof value === 'string') {
            warnings.push(`${direction} "${name}" dimension ${index} is symbolic ("${value}"); the graph will be checked at load time`);
        } else if (Number(value) !== expected) {
            mismatches.push(`${direction} "${name}" dimension ${index} is ${value}, expected ${expected}`);
        }
    }
}

/**
 * Validate the graph against the Falcon-OCR contract.
 *
 * Returns `{ ok, mismatches, warnings }`. `matchesFalconOcrShape` remains the
 * boolean form for callers that only need a yes/no answer.
 */
export function validateFalconOcrShape(graph, rules = FALCON_OCR_RULES) {
    const mismatches = [];
    const warnings = [];
    const inputs = new Map(graph.inputs.map((input) => [input.name, input]));
    const outputs = new Map(graph.outputs.map((output) => [output.name, output]));

    const expectedInputs = Object.keys(rules.inputs);
    const expectedOutputs = Object.keys(rules.outputs);
    if (inputs.size !== expectedInputs.length) {
        mismatches.push(`graph has ${inputs.size} inputs, expected ${expectedInputs.length}`);
    }
    if (outputs.size !== expectedOutputs.length) {
        mismatches.push(`graph has ${outputs.size} outputs, expected ${expectedOutputs.length}`);
    }
    for (const name of expectedInputs) checkTensor(name, inputs.get(name), rules.inputs[name], 'input', mismatches, warnings);
    for (const name of expectedOutputs) checkTensor(name, outputs.get(name), rules.outputs[name], 'output', mismatches, warnings);

    return { ok: mismatches.length === 0, mismatches, warnings };
}

/**
 * True when the graph's inputs and outputs match the Falcon-OCR adapter.
 * Names are compared as a set: ONNX does not promise an order.
 */
export function matchesFalconOcrShape(graph, rules = FALCON_OCR_RULES) {
    // The boolean form keeps the old compatibility surface, but also checks
    // the shapes and dtypes: a name-only match is not enough to load safely.
    if (graph.inputs.length !== Object.keys(rules.inputs).length
        || graph.outputs.length !== Object.keys(rules.outputs).length) {
        return false;
    }
    return validateFalconOcrShape(graph, rules).ok;
}
