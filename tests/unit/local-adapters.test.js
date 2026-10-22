// The capability probe.
//
// The probe decides whether a model file can be used, and says why when it
// cannot. Each refusal has its own code, so the settings panel can tell the
// clinic what to do.

import { describe, it, expect } from 'vitest';
import {
    probeModelFile,
    fileKind,
    sniffKind,
    PROBE_CODES,
    ADAPTERS,
} from '../../src/features/import-agent/local/adapters.js';

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
        for (let i = 0; i < 8; i += 1) { this.bytes.push(rest & 0xff); rest = Math.floor(rest / 256); }
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

function ggufBytes({ architecture = 'llama', chatTemplate = 'chatml', tensors = [] } = {}) {
    const writer = new Writer();
    writer.u32(0x46554747);
    writer.u32(3);
    writer.u64(tensors.length);
    const kv = [];
    if (architecture) kv.push({ key: 'general.architecture', write: (w) => w.str(architecture) });
    if (chatTemplate) kv.push({ key: 'tokenizer.chat_template', write: (w) => w.str(chatTemplate) });
    writer.u64(kv.length);
    for (const entry of kv) {
        writer.str(entry.key);
        writer.u32(8); // string
        entry.write(writer);
    }
    for (const tensor of tensors) {
        writer.str(tensor.name);
        writer.u32(tensor.dims.length);
        for (const dim of tensor.dims) writer.u64(dim);
        writer.u32(0);
        writer.u64(0);
    }
    return writer.result();
}

/** A file-like object the probe can read the head of. */
function fakeFile(name, bytes) {
    return {
        name,
        size: bytes.byteLength,
        lastModified: 0,
        slice: (start, end) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer }),
    };
}

describe('fileKind', () => {
    it('reads the kind from the name', () => {
        expect(fileKind('model.gguf')).toBe('gguf');
        expect(fileKind('MODEL.ONNX')).toBe('onnx');
        expect(fileKind('model.bin')).toBe('unknown');
    });
});

describe('sniffKind', () => {
    it('reads the kind from the bytes', () => {
        expect(sniffKind(ggufBytes())).toBe('gguf');
        expect(sniffKind(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe('zip');
        expect(sniffKind(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe('unknown');
    });

    it('recognises an ONNX graph', () => {
        // A protobuf key is a varint: field 1 (ir_version) with the varint
        // wire type, or field 7 (the graph) with the length wire type.
        expect(sniffKind(new Uint8Array([0x08, 0x07]))).toBe('onnx');
        expect(sniffKind(new Uint8Array([0x3a, 0x10, 0, 0]))).toBe('onnx');
    });
});

describe('probeModelFile', () => {
    it('accepts a text GGUF with a chat template', async () => {
        const file = fakeFile('model.gguf', ggufBytes({ architecture: 'llama' }));
        const result = await probeModelFile(file);
        expect(result.ok).toBe(true);
        expect(result.adapter).toBe(ADAPTERS.GGUF_TEXT);
        expect(result.capabilities.multimodal).toBe(false);
        expect(result.capabilities.architecture).toBe('llama');
    });

    it('accepts a GGUF that carries a vision tower', async () => {
        const file = fakeFile('model.gguf', ggufBytes({
            architecture: 'llama',
            tensors: [{ name: 'clip.vision.patch.weight', dims: [768, 768] }],
        }));
        const result = await probeModelFile(file);
        expect(result.ok).toBe(true);
        expect(result.adapter).toBe(ADAPTERS.GGUF_MULTIMODAL);
        expect(result.capabilities.multimodal).toBe(true);
    });

    it('refuses an architecture the runtime does not build', async () => {
        const file = fakeFile('model.gguf', ggufBytes({ architecture: 'brand-new-arch' }));
        const result = await probeModelFile(file);
        expect(result.ok).toBe(false);
        expect(result.code).toBe(PROBE_CODES.GGUF_ARCH_UNSUPPORTED);
        expect(result.detail).toContain('brand-new-arch');
    });

    it('warns about a model without a chat template but still accepts it', async () => {
        const file = fakeFile('model.gguf', ggufBytes({ architecture: 'llama', chatTemplate: null }));
        const result = await probeModelFile(file);
        expect(result.ok).toBe(true);
        expect(result.warnings.join(' ')).toMatch(/chat template/i);
    });

    it('refuses a file whose name and bytes disagree', async () => {
        const file = fakeFile('model.gguf', new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]));
        const result = await probeModelFile(file);
        expect(result.ok).toBe(false);
        expect(result.code).toBe(PROBE_CODES.FILE_MISMATCH);
    });

    it('refuses a file that is neither a GGUF nor an ONNX graph', async () => {
        const file = fakeFile('model.bin', new Uint8Array(64).fill(7));
        const result = await probeModelFile(file);
        expect(result.ok).toBe(false);
        expect(result.code).toBe(PROBE_CODES.FILE_TYPE_UNKNOWN);
    });

    it('refuses an ONNX graph whose shape matches no known adapter', async () => {
        // A protobuf with a graph field, but a graph that is not the OCR one.
        const graph = new Uint8Array([0x0a, 0x02, 0x61, 0x62]);
        const file = fakeFile('vision.onnx', graph);
        const result = await probeModelFile(file);
        expect(result.ok).toBe(false);
        expect([PROBE_CODES.ONNX_IO_UNMATCHED, PROBE_CODES.FILE_TYPE_UNKNOWN]).toContain(result.code);
    });
});
