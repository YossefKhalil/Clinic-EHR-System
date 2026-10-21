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
    constructor(code, message) {
        super(message);
        this.name = 'OnnxError';
        this.code = code;
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

    varint() {
        let result = 0;
        let shift = 0;
        for (;;) {
            if (this.remaining < 1) throw new OnnxError('ONNX_TRUNCATED', 'unexpected end of protobuf');
            const byte = this.view.getUint8(this.offset);
            this.offset += 1;
            result += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0) return result;
            shift += 7;
            if (shift > 63) throw new OnnxError('ONNX_TRUNCATED', 'varint is too long');
        }
    }

    skip(wireType) {
        switch (wireType) {
            case WIRE_VARINT: this.varint(); return;
            case WIRE_FIXED64: this.offset += 8; return;
            case WIRE_LENGTH: this.offset += this.varint(); return;
            case WIRE_FIXED32: this.offset += 4; return;
            default:
                throw new OnnxError('ONNX_WIRE_TYPE_UNKNOWN', `unknown protobuf wire type ${wireType}`);
        }
    }

    bytesField() {
        const length = this.varint();
        if (this.remaining < length) throw new OnnxError('ONNX_TRUNCATED', 'field runs past the end of the buffer');
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

/** The Falcon-OCR graph shape this build knows how to drive. */
export const FALCON_OCR_SIGNATURE = Object.freeze({
    inputs: ['tokens', 'image_patches', 'pos_t', 'pos_hw', 'attention_mask', 'past_key_values'],
    outputs: ['next_token', 'present_key_values'],
});

/**
 * True when the graph's inputs and outputs match the Falcon-OCR adapter.
 * Names are compared as a set: ONNX does not promise an order.
 */
export function matchesFalconOcrShape(graph, signature = FALCON_OCR_SIGNATURE) {
    const inputs = new Set(graph.inputs.map((input) => input.name));
    const outputs = new Set(graph.outputs.map((output) => output.name));
    const inputsMatch = signature.inputs.every((name) => inputs.has(name))
        && inputs.size === signature.inputs.length;
    const outputsMatch = signature.outputs.every((name) => outputs.has(name))
        && outputs.size === signature.outputs.length;
    return inputsMatch && outputsMatch;
}
