// Reading a model folder before anything is loaded.
//
// A folder is not a model until it has the four pieces: the chat config, the
// weights, the tokenizer and the wasm library. Each refusal names the piece
// that is missing, and a folder that only lacks the library is still usable —
// MLC ships the model and its library from two different places.

import { describe, it, expect } from 'vitest';
import {
    fileName,
    guessQuant,
    mountModel,
    readModelFolder,
    serviceWorkerSupported,
    slugify,
} from '../../src/features/import-agent/local-v2/folder.js';

function fakeFile(name, size, text) {
    return { name, size, text: async () => text };
}

const config = (overrides = {}) => JSON.stringify({
    model_type: 'qwen3',
    quantization: 'q4f16_1',
    context_window_size: 8192,
    ...overrides,
});

function fullFolder(overrides = {}) {
    return [
        fakeFile('mlc-chat-config.json', 1_200, config()),
        fakeFile('params_shard_0.bin', 900_000_000),
        fakeFile('params_shard_1.bin', 100_000_000),
        fakeFile('tokenizer.json', 2_000),
        fakeFile('Qwen3-4B-q4f16_1_cs1k-webgpu.wasm', 3_000_000),
        ...(overrides.extra ?? []),
    ];
}

describe('readModelFolder', () => {
    it('accepts a complete MLC folder and describes it', async () => {
        const read = await readModelFolder(fullFolder(), { folderName: 'Qwen3-4B-q4f16_1-MLC' });

        expect(read.ok).toBe(true);
        expect(read.model).toMatchObject({
            id: 'qwen3-4b-q4f16_1-mlc',
            name: 'Qwen3-4B-q4f16_1-MLC',
            quant: 'q4f16_1',
            contextWindow: 8192,
            fileCount: 5,
            hasLibrary: true,
            libName: 'Qwen3-4B-q4f16_1_cs1k-webgpu.wasm',
        });
        expect(read.model.bytes).toBe(1_003_003_200);
        expect(read.model.vramEstimateMb).toBeGreaterThan(1_000);
        expect(read.model.modalities).toEqual(['text']);
    });

    it('refuses a folder that is not the model folder', async () => {
        const read = await readModelFolder([fakeFile('README.md', 10)], { folderName: 'Downloads' });
        expect(read.ok).toBe(false);
        expect(read.errors[0]).toBe('aiSettings.localV2.folder.error.noConfig');
    });

    it('refuses a config it cannot read', async () => {
        const entries = fullFolder();
        entries[0] = fakeFile('mlc-chat-config.json', 10, '{not json');
        const read = await readModelFolder(entries, { folderName: 'broken' });
        expect(read.ok).toBe(false);
        expect(read.errors).toContain('aiSettings.localV2.folder.error.badConfig');
    });

    it('accepts tensor-cache.json as the weight list', async () => {
        const entries = fullFolder().filter((file) => !file.name.startsWith('params_shard_'));
        entries.push(fakeFile('tensor-cache.json', 4_000, '{}'));

        const read = await readModelFolder(entries, { folderName: 'manifest-build' });
        expect(read.ok).toBe(true);
        expect(read.model.hasLibrary).toBe(true);
    });

    it('names the missing weights and the missing tokenizer', async () => {
        const entries = [
            fakeFile('mlc-chat-config.json', 1_200, config()),
            fakeFile('model-webgpu.wasm', 3_000_000),
        ];
        const read = await readModelFolder(entries, { folderName: 'bare' });
        expect(read.ok).toBe(false);
        expect(read.errors).toEqual([
            'aiSettings.localV2.folder.error.noWeights',
            'aiSettings.localV2.folder.error.noTokenizer',
        ]);
    });

    it('keeps a folder whose only missing piece is the library', async () => {
        const entries = fullFolder().filter((file) => !file.name.endsWith('.wasm'));
        const read = await readModelFolder(entries, { folderName: 'weights-only' });

        expect(read.ok).toBe(true);
        expect(read.model.hasLibrary).toBe(false);
        expect(read.model.libName).toBe('');
        // The library is picked on its own, so the folder still counts.
        expect(read.model.contextWindow).toBe(8192);
    });

    it('takes a library picked separately', async () => {
        const entries = fullFolder().filter((file) => !file.name.endsWith('.wasm'));
        const library = fakeFile('MiniCPM2-2B-q4f16_1_cs1k-webgpu.wasm', 2_400_000);
        const read = await readModelFolder(entries, { folderName: 'minicpm', modelLib: library });

        expect(read.ok).toBe(true);
        expect(read.model.hasLibrary).toBe(true);
        expect(read.model.libName).toBe('MiniCPM2-2B-q4f16_1_cs1k-webgpu.wasm');
    });

    it('falls back to 4096 when the config states no window', async () => {
        const entries = fullFolder();
        entries[0] = fakeFile('mlc-chat-config.json', 100, config({ context_window_size: undefined }));
        const read = await readModelFolder(entries, { folderName: 'no-window' });
        expect(read.model.contextWindow).toBe(4096);
    });

    it('never reports a window smaller than 512 or larger than WebLLM accepts', async () => {
        const tiny = fullFolder();
        tiny[0] = fakeFile('mlc-chat-config.json', 100, config({ context_window_size: 64 }));
        expect((await readModelFolder(tiny, { folderName: 'tiny' })).model.contextWindow).toBe(512);

        const huge = fullFolder();
        huge[0] = fakeFile('mlc-chat-config.json', 100, config({ context_window_size: 9_999_999 }));
        expect((await readModelFolder(huge, { folderName: 'huge' })).model.contextWindow).toBe(1_048_576);
    });

    it('guesses the quant from the folder name when the config is silent', async () => {
        const entries = fullFolder();
        entries[0] = fakeFile('mlc-chat-config.json', 100, JSON.stringify({ model_type: 'llama' }));
        const read = await readModelFolder(entries, { folderName: 'Llama-3.2-3B-q4f32_1-MLC' });
        expect(read.model.quant).toBe('q4f32_1');
    });
});

describe('folder helpers', () => {
    it('turns a folder name into an id', () => {
        expect(slugify('Qwen3.5-4B-q4f16_1-MLC')).toBe('qwen3-5-4b-q4f16_1-mlc');
        expect(slugify('../../etc')).toBe('etc');
        expect(slugify('')).toBe('local-model');
    });

    it('reads the file name out of a directory-input entry', () => {
        expect(fileName({ name: 'x.bin', webkitRelativePath: 'Model/x.bin' })).toBe('x.bin');
        expect(fileName({ name: 'x.bin' })).toBe('x.bin');
        expect(fileName(null)).toBe('');
    });

    it('guesses a quant from a build name', () => {
        expect(guessQuant('Qwen3.5-4B-q4f16_1-MLC')).toBe('q4f16_1');
        expect(guessQuant('some-folder')).toBe('');
    });

    it('knows when the browser cannot serve local files', () => {
        expect(serviceWorkerSupported({})).toBe(false);
        expect(serviceWorkerSupported(null)).toBe(false);
        expect(serviceWorkerSupported({ serviceWorker: {} })).toBe(true);
    });
});

describe('mountModel', () => {
    it('refuses a browser without a service worker, with a sentence key', async () => {
        await expect(mountModel({ files: [] }, { navigator: {} })).rejects.toMatchObject({
            code: 'SERVICE_WORKER_MISSING',
            key: 'aiSettings.localV2.folder.error.worker',
        });
    });
});
