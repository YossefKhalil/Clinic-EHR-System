// The catalog is not a single model any more.
//
// Two things are worth guarding here:
//
//   1. every built-in entry can actually be loaded — either it carries its
//      own two addresses, or its id exists in the WebLLM release this app
//      pinned (checked against the installed package, not a copy);
//   2. a model the clinic pastes in is validated before it is stored, so a
//      typo never turns into a multi-gigabyte download that dies at the end.

import { describe, it, expect } from 'vitest';
import {
    CUSTOM_KEY,
    addCustomModel,
    allModels,
    assessFit,
    defaultModel,
    loadCustomModels,
    modelById,
    models,
    removeCustomModel,
    validateCustomModel,
} from '../../src/features/import-agent/local-v2/catalog.js';
import { buildAppConfig } from '../../src/features/import-agent/local-v2/engine.js';
import {
    SELECTED_KEY,
    loadSelectedModelId,
    saveSelectedModelId,
} from '../../src/features/import-agent/local-v2/profile.js';

function fakeStore(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
    };
}

const customInput = {
    id: 'MiniCPM2-2B-q4f16_1-MLC',
    name: 'MiniCPM2 2B',
    baseUrl: 'https://huggingface.co/mlc-ai/MiniCPM2-2B-q4f16_1-MLC/',
    modelLib: 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_87/base/MiniCPM2-2B-q4f16_1_cs1k-webgpu.wasm',
    contextWindow: 4096,
    downloadGb: 1.4,
};

describe('the shipped catalog', () => {
    it('offers more than one family, and no duplicates', () => {
        const list = models();
        expect(list.length).toBeGreaterThanOrEqual(8);
        expect(new Set(list.map((model) => model.id)).size).toBe(list.length);
        const families = new Set(list.map((model) => model.publisher));
        expect(families.size).toBeGreaterThanOrEqual(4);
        expect(list.some((model) => model.id === defaultModel().id)).toBe(true);
    });

    it('describes every entry well enough for the card', () => {
        for (const model of models()) {
            expect(model.id).toMatch(/-MLC$/);
            expect(model.name).toBeTruthy();
            expect(model.contextWindow).toBeGreaterThanOrEqual(512);
            expect(model.downloadGb).toBeGreaterThan(0);
            expect(model.vramEstimateMb).toBeGreaterThan(0);
            expect(model.modalities).toContain('text');
            expect(model.modalities).not.toContain('vision');
            expect(model.sampling.temperature).toBeGreaterThanOrEqual(0);
        }
    });

    it('loads each entry one of two ways: its own addresses, or the pinned runtime', () => {
        for (const model of models()) {
            const ownLinks = Boolean(model.baseUrl && model.modelLib);
            expect(ownLinks || model.source === 'webllm').toBe(true);
        }
    });

    it('names ids the installed WebLLM release can resolve', async () => {
        // The package is the authority: an id that is not in this release
        // would fail at load time, after the download.
        const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
        const known = new Set(prebuiltAppConfig.model_list.map((entry) => entry.model_id));
        for (const model of models()) {
            if (model.baseUrl && model.modelLib) continue;
            expect(known.has(model.id), `${model.id} is not in web-llm ${prebuiltAppConfig.model_list.length} models`).toBe(true);
        }
    });

    it('builds an app config for a prebuilt entry from the package itself', async () => {
        const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
        const gemma = models().find((model) => model.id === 'gemma-4-E2B-it-q4f16_1-MLC');
        expect(gemma).toBeTruthy();

        const config = buildAppConfig(gemma, prebuiltAppConfig.model_list, 2048);
        const entry = config.model_list[0];
        const source = prebuiltAppConfig.model_list.find((item) => item.model_id === gemma.id);

        // Addresses and wasm come from the runtime, so they cannot drift.
        expect(entry.model).toBe(source.model);
        expect(entry.model_lib).toBe(source.model_lib);
        expect(entry.overrides.context_window_size).toBe(2048);
        // The build's own overrides survive.
        expect(entry.required_features).toEqual(source.required_features);
    });

    it('keeps the build-specific overrides of a runtime entry', async () => {
        const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
        const qwen = models().find((model) => model.id === 'Qwen3.5-4B-q4f16_1-MLC');
        const config = buildAppConfig(qwen, prebuiltAppConfig.model_list, 4096);
        const source = prebuiltAppConfig.model_list.find((item) => item.model_id === qwen.id);
        expect(config.model_list[0].overrides.conv_config).toEqual(source.overrides.conv_config);
    });

    it('refuses a built-in id the pinned release does not ship', () => {
        expect(() => buildAppConfig({ id: 'Not-Real-q4f16_1-MLC', contextWindow: 4096 }, [])).toThrow(/not in WebLLM/);
        try {
            buildAppConfig({ id: 'Not-Real-q4f16_1-MLC', contextWindow: 4096 }, []);
        } catch (error) {
            expect(error.code).toBe('MODEL_NOT_IN_RUNTIME');
        }
    });
});

describe('a model the clinic adds', () => {
    it('is normalised and accepted', () => {
        const result = validateCustomModel(customInput, fakeStore());
        expect(result.ok).toBe(true);
        expect(result.model.baseUrl).not.toMatch(/\/$/);
        expect(result.model.quant).toBe('q4f16_1');
        expect(result.model.custom).toBe(true);
        expect(result.model.source).toBe('custom');
    });

    it('refuses a bad id, a missing address, a non-wasm library and a silly window', () => {
        const bad = validateCustomModel(
            { id: 'has space', baseUrl: 'ftp://x', modelLib: 'https://x/y.bin', contextWindow: 12 },
            fakeStore(),
        );
        expect(bad.ok).toBe(false);
        expect(Object.keys(bad.errors).sort()).toEqual(['baseUrl', 'contextWindow', 'id', 'modelLib']);
    });

    it('refuses an id that is already shipped', () => {
        const bad = validateCustomModel({ ...customInput, id: defaultModel().id }, fakeStore());
        expect(bad.ok).toBe(false);
        expect(bad.errors.id).toBe('aiSettings.localV2.custom.error.duplicate');
    });

    it('is stored, listed and found, then removed', () => {
        const store = fakeStore();
        const { model } = validateCustomModel(customInput, store);
        addCustomModel(model, store);

        expect(loadCustomModels(store)).toHaveLength(1);
        expect(allModels(store).some((entry) => entry.id === model.id)).toBe(true);
        expect(modelById(model.id, store)?.name).toBe('MiniCPM2 2B');
        expect(store.map.has(CUSTOM_KEY)).toBe(true);

        removeCustomModel(model.id, store);
        expect(loadCustomModels(store)).toHaveLength(0);
        expect(modelById(model.id, store)).toBeNull();
    });

    it('survives a corrupt stored list', () => {
        const store = fakeStore({ [CUSTOM_KEY]: '{oops' });
        expect(loadCustomModels(store)).toEqual([]);
        expect(allModels(store)).toHaveLength(models().length);
    });

    it('loads from its own addresses, without the runtime list', () => {
        const { model } = validateCustomModel(customInput, fakeStore());
        const config = buildAppConfig(model, [], 2048);
        expect(config.model_list[0]).toMatchObject({
            model_id: model.id,
            model: model.baseUrl,
            model_lib: model.modelLib,
        });
        expect(config.model_list[0].overrides.context_window_size).toBe(2048);
    });

    it('is still judged against the device, and unknown figures are not guessed', () => {
        const { model } = validateCustomModel(customInput, fakeStore());
        const device = { available: true, shaderF16: true, features: ['shader-f16'] };

        // No size or memory figure: the checks that need them are skipped.
        const unknown = { ...model, downloadGb: 0, vramEstimateMb: 0 };
        expect(assessFit(unknown, device, { deviceMemoryGb: 2, freeBytes: 1e9 }).ok).toBe(true);

        // A stated size is enforced.
        expect(assessFit(model, device, { deviceMemoryGb: 16, freeBytes: 1e9 }).code).toBe('STORAGE_SHORT');
    });
});

describe('the picked model', () => {
    it('is remembered on its own, apart from the tested one', () => {
        const store = fakeStore();
        expect(loadSelectedModelId(store)).toBeNull();
        saveSelectedModelId('Qwen3.5-4B-q4f16_1-MLC', store);
        expect(loadSelectedModelId(store)).toBe('Qwen3.5-4B-q4f16_1-MLC');
        expect(store.map.has(SELECTED_KEY)).toBe(true);
        // Picking a model does not claim it was tested.
        expect(store.map.has('clinic.localAi.v2.profile')).toBe(false);
    });

    it('is forgotten when cleared', () => {
        const store = fakeStore();
        saveSelectedModelId('gone', store);
        saveSelectedModelId(null, store);
        expect(loadSelectedModelId(store)).toBeNull();
    });
});
