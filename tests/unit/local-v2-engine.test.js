// The WebLLM seam, with a fake engine module.
//
// The real package is never imported here: a test that needs a GPU is not a
// test. What is tested is the mapping — the app config the engine is given,
// the progress reports it forwards, the chat call, and the code every
// failure turns into.

import { describe, it, expect, vi } from 'vitest';
import { buildAppConfig, createEngine, mapEngineError } from '../../src/features/import-agent/local-v2/engine.js';

const model = {
    id: 'qwen3-4b',
    name: 'Qwen3-4B-q4f16_1-MLC',
    quant: 'q4f16_1',
    contextWindow: 8192,
    baseUrl: 'https://clinic.example/__local-mlc/abc123/',
    modelLib: 'https://clinic.example/__local-mlc/abc123/Qwen3-4B-q4f16_1_webgpu.wasm',
};

function fakeEngine(overrides = {}) {
    const create = vi.fn(async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    return {
        chat: { completions: { create } },
        unload: vi.fn(async () => {}),
        create,
        ...overrides,
    };
}

function loaderReturning(raw) {
    const calls = [];
    const CreateMLCEngine = vi.fn(async (id, options) => {
        calls.push({ id, options });
        return raw;
    });
    return { loader: async () => ({ CreateMLCEngine }), CreateMLCEngine, calls };
}

describe('buildAppConfig', () => {
    it('points the engine at the mounted folder', () => {
        const appConfig = buildAppConfig(model);
        expect(appConfig.model_list).toHaveLength(1);
        expect(appConfig.model_list[0]).toEqual({
            model: model.baseUrl,
            model_id: model.id,
            model_lib: model.modelLib,
            overrides: { context_window_size: 8192 },
        });
    });

    it('uses the window the clinic chose', () => {
        expect(buildAppConfig(model, 2048).model_list[0].overrides.context_window_size).toBe(2048);
    });

    it('refuses a model that was never mounted', () => {
        expect(() => buildAppConfig({ id: 'no-folder' })).toThrow(/mounted folder/);
        try {
            buildAppConfig({ id: 'no-folder' });
        } catch (error) {
            expect(error.code).toBe('MODEL_NOT_LOCAL');
        }
    });
});

describe('createEngine', () => {
    it('loads the folder model and forwards progress', async () => {
        const raw = fakeEngine();
        const { loader, CreateMLCEngine, calls } = loaderReturning(raw);
        const reports = [];

        const engine = await createEngine({ model, loader, onProgress: (report) => reports.push(report) });

        expect(CreateMLCEngine).toHaveBeenCalledTimes(1);
        expect(calls[0].id).toBe(model.id);
        expect(calls[0].options.appConfig.model_list[0].model).toBe(model.baseUrl);

        calls[0].options.initProgressCallback({ text: 'Fetching param cache', progress: 0.5 });
        expect(reports[0]).toEqual({ phase: 'loading', text: 'Fetching param cache', progress: 0.5 });
        expect(engine.model.id).toBe(model.id);
    });

    it('asks for a non-streaming completion', async () => {
        const raw = fakeEngine();
        const { loader } = loaderReturning(raw);
        const engine = await createEngine({ model, loader });

        await engine.chat({ messages: [{ role: 'user', content: 'hi' }] });
        expect(raw.create).toHaveBeenCalledWith({ messages: [{ role: 'user', content: 'hi' }], stream: false });
    });

    it('maps an engine failure at the seam', async () => {
        const raw = fakeEngine({ chat: { completions: { create: async () => { throw new Error('out of memory while allocating KV cache'); } } } });
        const { loader } = loaderReturning(raw);
        const engine = await createEngine({ model, loader });

        await expect(engine.chat({ messages: [] })).rejects.toMatchObject({ code: 'GPU_OUT_OF_MEMORY' });
    });

    it('reports a package that will not load', async () => {
        const loader = async () => { throw new Error('network down'); };
        await expect(createEngine({ model, loader })).rejects.toMatchObject({ code: 'WEBLLM_PACKAGE_MISSING' });
    });

    it('reports a package without the engine export', async () => {
        const loader = async () => ({ somethingElse: true });
        await expect(createEngine({ model, loader })).rejects.toMatchObject({ code: 'WEBLLM_PACKAGE_MISSING' });
    });

    it('refuses to load without a model', async () => {
        await expect(createEngine({ model: null })).rejects.toMatchObject({ code: 'MODEL_UNKNOWN' });
    });

    it('unloads without throwing when the engine cannot', async () => {
        const raw = fakeEngine({ unload: async () => { throw new Error('gone'); } });
        const { loader } = loaderReturning(raw);
        const engine = await createEngine({ model, loader });
        await expect(engine.unload()).resolves.toBeUndefined();
    });
});

describe('mapEngineError', () => {
    const cases = [
        ['device lost', 'WEBGPU_DEVICE_LOST'],
        ['GPUDevice is lost', 'WEBGPU_DEVICE_LOST'],
        ['CUDA error: out of memory', 'GPU_OUT_OF_MEMORY'],
        ['the prompt exceeds the context window', 'CONTEXT_TOO_SMALL'],
        ['Cannot find tensor-cache.json', 'MODEL_LIBRARY_MISMATCH'],
        ['fetch failed: not mounted: params_shard_0.bin', 'MODEL_DOWNLOAD_FAILED'],
        ['navigator.gpu is undefined', 'WEBGPU_MISSING'],
        ['something else entirely', 'LOCAL_ENGINE_ERROR'],
    ];

    for (const [message, code] of cases) {
        it(`maps "${message}" to ${code}`, () => {
            const mapped = mapEngineError(new Error(message));
            expect(mapped.code).toBe(code);
            // The original message is kept for the details disclosure.
            expect(mapped.message).toBe(message);
        });
    }

    it('does not remap an error that already carries a code', () => {
        const error = new Error('WebGPU is not available');
        error.code = 'WEBGPU_MISSING';
        expect(mapEngineError(error)).toBe(error);
    });
});
