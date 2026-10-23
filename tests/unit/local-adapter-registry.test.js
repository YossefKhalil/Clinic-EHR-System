// The Task 3 adapter registry.
//
// These tests build the model headers themselves, so they prove the probe
// contract without a multi-hundred-megabyte model on the test machine:
// architecture/template/context for GGUF, names/shapes/dtypes for ONNX, the
// refusal codes, and the object `getAdapter()` hands to the pump.

import { describe, it, expect } from 'vitest';
import {
    probeGGUF,
    probeONNX,
    getAdapter,
    PROBE_CODES,
    ADAPTER_IDS,
} from '../../src/features/import-agent/local/adapters.js';
import { createGgufAdapter } from '../../src/features/import-agent/local/gguf-adapter.js';
import {
    createOnnxAdapter,
    createOnnxSession,
    sessionIoMismatches,
} from '../../src/features/import-agent/local/onnx-adapter.js';
import * as falcon from '../../src/features/import-agent/local/falcon-ocr.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class Writer {
    constructor() {
        this.bytes = [];
    }

    u8(value) { this.bytes.push(value & 0xff); return this; }

    u32(value) {
        this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
        return this;
    }

    u64(value) {
        let rest = value;
        for (let i = 0; i < 8; i += 1) {
            this.bytes.push(rest & 0xff);
            rest = Math.floor(rest / 256);
        }
        return this;
    }

    str(text) {
        const encoded = new TextEncoder().encode(text);
        this.u64(encoded.length);
        for (const byte of encoded) this.bytes.push(byte);
        return this;
    }

    result() { return new Uint8Array(this.bytes); }
}

function ggufBytes({
    architecture = 'llama',
    chatTemplate = 'chatml',
    contextLength = 4096,
    tensors = [],
} = {}) {
    const writer = new Writer();
    writer.u32(0x46554747);
    writer.u32(3);
    writer.u64(tensors.length);

    const kv = [];
    if (architecture) {
        kv.push({ key: 'general.architecture', type: 8, write: (w) => w.str(architecture) });
    }
    if (chatTemplate) {
        kv.push({ key: 'tokenizer.chat_template', type: 8, write: (w) => w.str(chatTemplate) });
    }
    if (contextLength) {
        kv.push({ key: `${architecture}.context_length`, type: 4, write: (w) => w.u32(contextLength) });
    }
    writer.u64(kv.length);
    for (const entry of kv) {
        writer.str(entry.key);
        writer.u32(entry.type);
        entry.write(writer);
    }
    for (const tensor of tensors) {
        writer.str(tensor.name);
        writer.u32(tensor.dims.length);
        for (const dim of tensor.dims) writer.u64(dim);
        writer.u32(0); // ggml type
        writer.u64(0); // offset
    }
    return writer.result();
}

function fakeFile(name, bytes) {
    return {
        name,
        size: bytes.byteLength,
        lastModified: 0,
        slice: (start, end) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
    };
}

/** A protobuf writer: varints, length-delimited fields. */
class Proto {
    constructor() {
        this.bytes = [];
    }

    varint(value) {
        let rest = value;
        do {
            let byte = rest & 0x7f;
            rest = Math.floor(rest / 128);
            if (rest > 0) byte |= 0x80;
            this.bytes.push(byte);
        } while (rest > 0);
        return this;
    }

    tag(field, wire) { return this.varint((field << 3) | wire); }

    bytesField(field, payload) {
        this.tag(field, 2);
        this.varint(payload.length);
        for (const byte of payload) this.bytes.push(byte);
        return this;
    }

    varintField(field, value) {
        this.tag(field, 0);
        this.varint(value);
        return this;
    }

    stringField(field, text) {
        return this.bytesField(field, new TextEncoder().encode(text));
    }

    result() { return new Uint8Array(this.bytes); }
}

function valueInfo(name, elemType, dims) {
    const dimension = new Proto();
    for (const dim of dims) dimension.varintField(1, dim);
    const shape = new Proto();
    shape.bytesField(1, dimension.result());
    const tensor = new Proto();
    tensor.varintField(1, elemType);
    tensor.bytesField(2, shape.result());
    const type = new Proto();
    type.bytesField(1, tensor.result());
    const info = new Proto();
    info.stringField(1, name);
    info.bytesField(2, type.result());
    return info.result();
}

const FALCON_INPUTS = [
    valueInfo('tokens', 7, [1, 512]),
    valueInfo('image_patches', 1, [1, 256, 768]),
    valueInfo('pos_t', 7, [1, 512]),
    valueInfo('pos_hw', 1, [1, 512, 2]),
    valueInfo('attention_mask', 9, [1, 512, 512]),
    valueInfo('past_key_values', 1, [22, 2, 1, 16, 0, 64]),
];
const FALCON_OUTPUTS = [
    valueInfo('next_token', 7, [1]),
    valueInfo('present_key_values', 1, [22, 2, 1, 16, 512, 64]),
];

function buildGraph({
    inputs = FALCON_INPUTS,
    outputs = FALCON_OUTPUTS,
    opsets = [{ domain: '', version: 17 }],
    initializers = [],
} = {}) {
    const graph = new Proto();
    for (const input of inputs) graph.bytesField(11, input);
    for (const output of outputs) graph.bytesField(12, output);
    for (const initializer of initializers) graph.bytesField(5, initializer);
    const model = new Proto();
    model.varintField(1, 8);
    for (const opset of opsets) {
        const entry = new Proto();
        if (opset.domain) entry.stringField(1, opset.domain);
        entry.varintField(2, opset.version);
        model.bytesField(8, entry.result());
    }
    model.bytesField(7, graph.result());
    return model.result();
}

// ---------------------------------------------------------------------------
// GGUF probe
// ---------------------------------------------------------------------------

describe('probeGGUF', () => {
    it('reads the architecture, template and context window', async () => {
        const result = await probeGGUF(fakeFile('text.gguf', ggufBytes({
            architecture: 'qwen2',
            chatTemplate: 'chatml',
            contextLength: 8192,
        })));
        expect(result.ok).toBe(true);
        expect(result.adapter).toBe(ADAPTER_IDS.WLLAMA);
        expect(result.architecture).toBe('qwen2');
        expect(result.chatTemplate).toBe('chatml');
        expect(result.capabilities.contextWindow).toBe(8192);
        expect(result.capabilities.vision).toBe(false);
    });

    it('reports vision tensors', async () => {
        const result = await probeGGUF(fakeFile('vision.gguf', ggufBytes({
            tensors: [{ name: 'clip.vision.patch.weight', dims: [768, 768] }],
        })));
        expect(result.ok).toBe(true);
        expect(result.capabilities.vision).toBe(true);
    });

    it('refuses a missing chat template unless the config supplies one', async () => {
        const file = fakeFile('text.gguf', ggufBytes({ chatTemplate: null }));
        const strict = await probeGGUF(file);
        expect(strict.ok).toBe(false);
        expect(strict.error).toBe(PROBE_CODES.GGUF_TEMPLATE_MISSING);

        const overridden = await probeGGUF(file, { chatTemplate: '{{ system }}{{ user }}' });
        expect(overridden.ok).toBe(true);
        expect(overridden.chatTemplate).toBe('{{ system }}{{ user }}');
        expect(overridden.warnings.join(' ')).toMatch(/configured template/i);
    });

    it('refuses a vision GGUF in a split text slot', async () => {
        const result = await probeGGUF(fakeFile('vision.gguf', ggufBytes({
            tensors: [{ name: 'clip.vision.patch.weight', dims: [768, 768] }],
        })), { mode: 'split' });
        expect(result.ok).toBe(false);
        expect(result.error).toBe(PROBE_CODES.VISION_GGUF_UNSUPPORTED);
    });

    it('refuses an unsupported architecture', async () => {
        const result = await probeGGUF(fakeFile('model.gguf', ggufBytes({ architecture: 'brand-new' })));
        expect(result.ok).toBe(false);
        expect(result.error).toBe(PROBE_CODES.GGUF_ARCH_UNSUPPORTED);
    });
});

// ---------------------------------------------------------------------------
// GGUF adapter
// ---------------------------------------------------------------------------

describe('GgufAdapter', () => {
    it('keeps the import-extract complete() shape', async () => {
        const calls = [];
        const provider = {
            async complete(request) {
                calls.push(request);
                return { text: 'hello', usage: { in: 3, out: 2 } };
            },
        };
        const adapter = createGgufAdapter({ mode: 'single', provider, config: { text: { maxOutputTokens: 128 } } });
        const result = await adapter.complete([
            { role: 'system', content: 'extract the records' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'here is the page' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                ],
            },
        ]);
        expect(result.text).toBe('hello');
        expect(result.usage).toEqual({ in: 3, out: 2 });
        expect(calls[0].system).toBe('extract the records');
        expect(calls[0].user[1]).toEqual({ type: 'image', dataUrl: 'data:image/png;base64,AAAA' });
    });

    it('refuses an image in split mode', async () => {
        const adapter = createGgufAdapter({
            mode: 'split',
            provider: { async complete() { return { text: '' }; } },
        });
        await expect(adapter.complete([
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        ])).rejects.toMatchObject({ code: 'VISION_GGUF_UNSUPPORTED' });
    });

    it('is built by the registry', async () => {
        const probe = await probeGGUF(fakeFile('text.gguf', ggufBytes()));
        const adapter = getAdapter(probe, { mode: 'split' });
        expect(adapter.id).toBe(ADAPTER_IDS.WLLAMA);
        expect(typeof adapter.complete).toBe('function');
        expect(typeof adapter.release).toBe('function');
    });

    it('does not build an adapter from a failed probe', () => {
        let caught = null;
        try {
            getAdapter({ error: PROBE_CODES.GGUF_TEMPLATE_MISSING });
        } catch (error) {
            caught = error;
        }
        expect(caught?.code).toBe(PROBE_CODES.GGUF_TEMPLATE_MISSING);
    });
});

// ---------------------------------------------------------------------------
// ONNX probe
// ---------------------------------------------------------------------------

describe('probeONNX', () => {
    it('returns the graph shapes and the Falcon adapter', async () => {
        const result = await probeONNX(fakeFile('vision.onnx', buildGraph()));
        expect(result.ok).toBe(true);
        expect(result.adapter).toBe(ADAPTER_IDS.ONNX_FALCON_OCR);
        expect(result.inputShapes.tokens).toEqual([1, 512]);
        expect(result.inputShapes.image_patches).toEqual([1, 256, 768]);
        expect(result.outputShapes.next_token).toEqual([1]);
    });

    it('skips inline weights instead of loading them into the probe', async () => {
        // ONNX writes initializers before inputs/outputs. A probe that reads
        // the file into one buffer cannot reach the shapes of a 450 MB model;
        // the streaming reader only reads the metadata and moves past the
        // raw_data field.
        const raw = new Uint8Array(256 * 1024).fill(1);
        const initializer = new Proto();
        initializer.bytesField(9, raw); // TensorProto.raw_data
        const bytes = buildGraph({ initializers: [initializer.result()] });
        let largestRead = 0;
        const file = {
            name: 'vision.onnx',
            size: bytes.byteLength,
            slice(start, end) {
                largestRead = Math.max(largestRead, end - start);
                return { arrayBuffer: async () => bytes.slice(start, end).buffer };
            },
        };
        const result = await probeONNX(file);
        expect(result.ok).toBe(true);
        expect(result.inputShapes.tokens).toEqual([1, 512]);
        expect(largestRead).toBeLessThan(128 * 1024);
    });

    it('refuses a graph whose dtype or shape does not match', async () => {
        const badInputs = [...FALCON_INPUTS];
        badInputs[0] = valueInfo('tokens', 1, [1, 512]); // float32, not int64
        const result = await probeONNX(fakeFile('vision.onnx', buildGraph({ inputs: badInputs, outputs: FALCON_OUTPUTS })));
        expect(result.ok).toBe(false);
        expect(result.error).toBe(PROBE_CODES.ONNX_IO_UNMATCHED);
        expect(result.mismatches.join(' ')).toMatch(/tokens/);
    });

    it('refuses a model whose weights live in external files', async () => {
        const tensor = new Proto();
        tensor.varintField(14, 1); // TensorProto.data_location = EXTERNAL
        const result = await probeONNX(fakeFile('vision.onnx', buildGraph({ initializers: [tensor.result()] })));
        expect(result.ok).toBe(false);
        expect(result.error).toBe(PROBE_CODES.ONNX_EXTERNAL_DATA_UNSUPPORTED);
    });

    it('builds an ONNX adapter from the registry', async () => {
        const probe = await probeONNX(fakeFile('vision.onnx', buildGraph()));
        const adapter = getAdapter(probe);
        expect(adapter).toBeInstanceOf(Object);
        expect(adapter.id).toBe(ADAPTER_IDS.ONNX_FALCON_OCR);
        expect(typeof adapter.run).toBe('function');
        expect(typeof adapter.release).toBe('function');
    });
});

describe('OnnxAdapter session I/O check', () => {
    it('reports missing names before the session runs', () => {
        const adapter = createOnnxAdapter({ probe: { capabilities: { ocr: true } } });
        expect(adapter.loaded).toBe(false);
        adapter.release();
        expect(adapter.loaded).toBe(false);

        const mismatches = sessionIoMismatches({
            inputNames: ['tokens', 'image_patches', 'pos_t'],
            outputNames: ['next_token'],
        });
        expect(mismatches.join(' ')).toMatch(/pos_hw/);
        expect(mismatches.join(' ')).toMatch(/present_key_values/);
    });

    it('refuses external data even when no probe result is passed', async () => {
        const tensor = new Proto();
        tensor.varintField(14, 1); // data_location = EXTERNAL
        const bytes = buildGraph({ initializers: [tensor.result()] });
        let created = false;
        await expect(createOnnxSession(new Blob([bytes]), {}, {
            runtime: {},
            sessionFactory: async () => {
                created = true;
                throw new Error('the session must not be created');
            },
        })).rejects.toMatchObject({ code: 'ONNX_EXTERNAL_DATA_UNSUPPORTED' });
        expect(created).toBe(false);
    });

    it('resolves a profile handle before creating the session', async () => {
        let released = false;
        const session = {
            inputNames: ['tokens', 'image_patches', 'pos_t', 'pos_hw', 'attention_mask', 'past_key_values'],
            outputNames: ['next_token', 'present_key_values'],
            release() { released = true; },
        };
        const handle = {
            async getFile() {
                return new Blob([buildGraph()], { type: 'application/octet-stream' });
            },
        };
        const adapter = createOnnxAdapter({
            probe: { capabilities: { ocr: true } },
            runtime: {},
            sessionFactory: async (data) => {
                expect(data).toBeInstanceOf(Uint8Array);
                return session;
            },
        });
        await adapter.load(handle);
        expect(adapter.loaded).toBe(true);
        expect(adapter.model).toBeInstanceOf(Blob);
        adapter.release();
        expect(released).toBe(true);
        expect(adapter.loaded).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Falcon pipeline surface
// ---------------------------------------------------------------------------

describe('falcon-ocr exports', () => {
    it('exposes the pipeline functions Task 4 calls', () => {
        expect(typeof falcon.runStrip).toBe('function');
        expect(typeof falcon.release).toBe('function');
        expect(typeof falcon.makeStrips).toBe('function');
        expect(typeof falcon.buildPositions).toBe('function');
        expect(typeof falcon.buildAttentionMask).toBe('function');
        expect(typeof falcon.mergeStripLines).toBe('function');
    });

    it('builds a causal plus image-block attention mask', () => {
        const mask = falcon.buildAttentionMask(3, new Uint8Array([0, 1, 1]));
        // [q, k] with S=3: causal everywhere below/on the diagonal, and the
        // two image tokens see each other even when the causal edge is down.
        expect(Array.from(mask)).toEqual([
            1, 0, 0,
            1, 1, 1,
            1, 1, 1,
        ]);
    });
});
