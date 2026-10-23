// Chunked SHA-256 for local model files.
//
// The digest has to be the real SHA-256 (a record says which model produced
// it), computed without ever holding the whole file in memory, and cached by
// the file's identity so a second verify is cheap.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    SHA256_CHUNK_SIZE,
    computeSHA256,
    hashFile,
    hashCacheKey,
    clearHashCache,
} from '../../src/features/import-agent/local/hash-wasm.js';
import {
    readFileChunked,
    verifyHandle,
    fileFromHandle,
    releaseHandle,
    pickModelFile,
    pickSupportDirectory,
    readDirectoryFiles,
    verifySha256,
} from '../../src/features/import-agent/local/model-store.js';

const encoder = new TextEncoder();

function fileOf(text, name = 'model.bin', lastModified = 1) {
    return new File([encoder.encode(text)], name, { lastModified });
}

function handleOf(file) {
    return {
        kind: 'file',
        name: file.name,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        getFile: async () => file,
    };
}

describe('hashFile', () => {
    it('matches the known SHA-256 of the content', async () => {
        // sha256("abc") is a published test vector.
        const digest = await hashFile(fileOf('abc'));
        expect(digest).toBe('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD');
    });

    it('reads the file in slices, not in one buffer', async () => {
        const file = fileOf('abcdefghij', 'chunked.bin');
        const reads = [];
        const digest = await hashFile(file, {
            chunkSize: 3,
            onProgress: (read, total) => reads.push([read, total]),
        });
        expect(reads).toEqual([[3, 10], [6, 10], [9, 10], [10, 10]]);
        expect(digest).toBe(await hashFile(file));
    });

    it('has a 64 MB default slice', () => {
        expect(SHA256_CHUNK_SIZE).toBe(64 * 1024 * 1024);
    });
});

describe('computeSHA256', () => {
    it('accepts a file handle as well as a File', async () => {
        const file = fileOf('abc', 'handle.gguf');
        expect(await computeSHA256(handleOf(file))).toBe(await computeSHA256(file));
    });

    it('caches by name, size and modification time', async () => {
        const key = hashCacheKey(fileOf('abc', 'same.gguf', 42));
        expect(key).toBe('sha256:same.gguf:3:42');

        const first = fileOf('abc', 'cached.gguf', 7);
        const digest = await computeSHA256(first);
        // Same identity, different bytes: the cache answers, which is exactly
        // why the modification time is part of the key.
        const replaced = fileOf('xyz', 'cached.gguf', 7);
        expect(await computeSHA256(replaced)).toBe(digest);

        expect(await clearHashCache(replaced)).toBe(true);
        expect(await computeSHA256(replaced)).not.toBe(digest);
    });

    it('can bypass the cache', async () => {
        const first = fileOf('abc', 'uncached.gguf', 7);
        const replaced = fileOf('xyz', 'uncached.gguf', 7);
        expect(await computeSHA256(first, { cache: false })).not.toBe(await computeSHA256(replaced, { cache: false }));
    });
});

describe('readFileChunked', () => {
    it('streams a file in the requested slices', async () => {
        const file = fileOf('abcdefghij', 'stream.bin');
        const chunks = [];
        const read = await readFileChunked(handleOf(file), (chunk, offset, total) => {
            chunks.push({ text: new TextDecoder().decode(chunk), offset, total });
        }, { chunkSize: 4 });

        expect(read).toBe(10);
        expect(chunks).toEqual([
            { text: 'abcd', offset: 0, total: 10 },
            { text: 'efgh', offset: 4, total: 10 },
            { text: 'ij', offset: 8, total: 10 },
        ]);
    });

    it('accepts a File and stops when the callback says so', async () => {
        const file = fileOf('abcdefghij', 'stop.bin');
        let calls = 0;
        const read = await readFileChunked(file, () => { calls += 1; return false; }, { chunkSize: 2 });
        expect(calls).toBe(1);
        expect(read).toBe(2);
    });
});

describe('handles', () => {
    it('asks for a permission that is not granted yet', async () => {
        const asked = [];
        const handle = {
            queryPermission: async () => 'prompt',
            requestPermission: async ({ mode }) => { asked.push(mode); return 'granted'; },
        };
        expect(await verifyHandle(handle)).toBe(true);
        expect(asked).toEqual(['read']);
    });

    it('reports a refused permission as invalid', async () => {
        const handle = {
            queryPermission: async () => 'denied',
            requestPermission: async () => 'denied',
        };
        expect(await verifyHandle(handle)).toBe(false);
        expect(await fileFromHandle(handle)).toBe(null);
    });

    it('treats a plain File as readable and a released handle as unusable', async () => {
        const file = fileOf('abc', 'plain.gguf');
        expect(await verifyHandle(file)).toBe(true);
        expect(await fileFromHandle(file)).toBe(file);

        const handle = handleOf(file);
        releaseHandle(handle);
        expect(await verifyHandle(handle)).toBe(false);
        expect(await fileFromHandle(handle)).toBe(null);
    });

    it('does not need a permission API on a test handle', async () => {
        expect(await verifyHandle({ getFile: async () => fileOf('abc') })).toBe(true);
        expect(await verifyHandle(null)).toBe(false);
    });
});

describe('pickers', () => {
    beforeEach(() => {
        delete globalThis.window;
    });

    it('offers both model extensions by default', async () => {
        let options = null;
        const handle = handleOf(fileOf('abc', 'model.gguf'));
        globalThis.window = {
            showOpenFilePicker: async (value) => { options = value; return [handle]; },
        };
        expect(await pickModelFile()).toBe(handle);
        expect(options.types[0].accept['application/octet-stream']).toEqual(['.gguf', '.onnx']);
        expect(options.multiple).toBe(false);
        delete globalThis.window;
    });

    it('narrows the picker to the requested extension', async () => {
        let options = null;
        globalThis.window = {
            showOpenFilePicker: async (value) => { options = value; return [handleOf(fileOf('abc'))]; },
        };
        await pickModelFile('onnx');
        expect(options.types[0].accept['application/octet-stream']).toEqual(['.onnx']);
        delete globalThis.window;
    });

    it('returns null when the picker is cancelled', async () => {
        globalThis.window = {
            showOpenFilePicker: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
        };
        expect(await pickModelFile()).toBe(null);
        delete globalThis.window;
    });

    it('reads a support directory into a file map', async () => {
        const tokenizer = fileOf('{}', 'tokenizer.json');
        const config = fileOf('{}', 'config.json');
        const directory = {
            name: 'falcon',
            entries: async function* entries() {
                yield ['tokenizer.json', { kind: 'file', getFile: async () => tokenizer }];
                yield ['subfolder', { kind: 'directory' }];
                yield ['config.json', { kind: 'file', getFile: async () => config }];
            },
        };
        const files = await readDirectoryFiles(directory);
        expect(Object.keys(files).sort()).toEqual(['config.json', 'tokenizer.json']);

        let options = null;
        globalThis.window = {
            showDirectoryPicker: async (value) => { options = value; return directory; },
        };
        expect(await pickSupportDirectory()).toBe(directory);
        expect(options).toEqual({ mode: 'read' });
        delete globalThis.window;
    });
});

describe('verifySha256', () => {
    it('accepts a missing expectation and matches the stored hash', async () => {
        const file = fileOf('abc', 'verify.gguf');
        expect(await verifySha256(file, undefined)).toBe(true);
        const digest = await computeSHA256(file);
        expect(await verifySha256(file, digest.toLowerCase())).toBe(true);
        expect(await verifySha256(file, '0'.repeat(64))).toBe(false);
    });
});
