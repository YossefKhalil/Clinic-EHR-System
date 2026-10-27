// The GGUF header reader.
//
// The header is what the capability probe reads, so the reader is checked
// against a file this test builds itself: a GGUF with a known architecture,
// a known chat template and a known vision tensor.

import { describe, it, expect } from 'vitest';
import {
    parseGgufHeader,
    hasVisionTensors,
    isProjectorGguf,
    isSupportedArchitecture,
    runtimeIdentityLabel,
    GgufError,
    GGUF_VALUE_TYPES,
} from '../../src/features/import-agent/local/gguf-metadata.js';

class Writer {
    constructor() {
        this.bytes = [];
    }

    u8(value) {
        this.bytes.push(value & 0xff);
        return this;
    }

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

    result() {
        return new Uint8Array(this.bytes);
    }
}

function buildGguf({ architecture = 'llama', chatTemplate = '{{ bos }}', tensors = [], version = 3 } = {}) {
    const writer = new Writer();
    writer.u32(0x46554747); // "GGUF"
    writer.u32(version);
    writer.u64(tensors.length);
    const kv = [];
    if (architecture) {
        kv.push({ key: 'general.architecture', type: GGUF_VALUE_TYPES.STRING, write: (w) => w.str(architecture) });
    }
    if (chatTemplate) {
        kv.push({ key: 'tokenizer.chat_template', type: GGUF_VALUE_TYPES.STRING, write: (w) => w.str(chatTemplate) });
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

describe('parseGgufHeader', () => {
    it('reads the architecture, the chat template and the tensors', () => {
        const bytes = buildGguf({
            architecture: 'qwen3',
            chatTemplate: 'chatml-template',
            tensors: [
                { name: 'token_embd.weight', dims: [4096, 32000] },
                { name: 'blk.0.attn_q.weight', dims: [4096, 4096] },
            ],
        });
        const header = parseGgufHeader(bytes);
        expect(header.version).toBe(3);
        expect(header.architecture).toBe('qwen3');
        expect(header.chatTemplate).toBe('chatml-template');
        expect(header.tensors).toHaveLength(2);
        expect(header.tensors[0].name).toBe('token_embd.weight');
        expect(header.tensors[0].dims).toEqual([4096, 32000]);
    });

    it('refuses a file that is not a GGUF', () => {
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
        expect(() => parseGgufHeader(bytes)).toThrow(GgufError);
        try {
            parseGgufHeader(bytes);
        } catch (error) {
            expect(error.code).toBe('GGUF_MAGIC_INVALID');
        }
    });

    it('refuses a file that is too small to hold a header', () => {
        expect(() => parseGgufHeader(new Uint8Array([0x47, 0x47]))).toThrow(/magic/);
    });
});

describe('hasVisionTensors', () => {
    it('is true for a vision tower and false for a text model', () => {
        expect(hasVisionTensors([{ name: 'text_embd.weight' }])).toBe(false);
        expect(hasVisionTensors([{ name: 'clip.vision.patch.weight' }])).toBe(true);
        expect(hasVisionTensors([{ name: 'mmproj.weight' }])).toBe(true);
    });
});

describe('isProjectorGguf', () => {
    it('recognises the clip architecture, the mmproj tensors and the mmproj name', () => {
        expect(isProjectorGguf({ architecture: 'clip', tensors: [] }, 'model.gguf')).toBe(true);
        expect(isProjectorGguf({ architecture: 'llama', tensors: [{ name: 'mmproj.weight' }] }, 'model.gguf')).toBe(true);
        expect(isProjectorGguf({ architecture: 'llama', tensors: [] }, 'mmproj-model-f16.gguf')).toBe(true);
        expect(isProjectorGguf({ architecture: 'llama', tensors: [{ name: 'token_embd.weight' }] }, 'model.gguf')).toBe(false);
    });
});

describe('runtimeIdentityLabel', () => {
    it('names the wrapper build the manifest was generated from', () => {
        expect(runtimeIdentityLabel()).toMatch(/^wllama \d+\.\d+\.\d+/);
    });
});

describe('isSupportedArchitecture', () => {
    it('refuses an architecture the runtime does not build', () => {
        expect(isSupportedArchitecture('llama')).toBe(true);
        expect(isSupportedArchitecture('qwen3')).toBe(true);
        expect(isSupportedArchitecture('some-new-architecture')).toBe(false);
        expect(isSupportedArchitecture(null)).toBe(false);
    });
});
