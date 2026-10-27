// The model setup.
//
// The setup is where the picked files become a loaded runtime. The projector
// is the part that is easy to get wrong: wllama needs both blobs, and a
// multimodal GGUF without its projector must not claim it can read photos.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    initWllama: vi.fn(async () => ({ ok: true })),
    createLocalProvider: vi.fn(() => ({ complete: vi.fn() })),
    unloadWllama: vi.fn(async () => {}),
    probeModelFile: vi.fn(async () => ({ ok: true, capabilities: { kind: 'gguf' }, warnings: [] })),
    initFalcon: vi.fn(async () => {}),
    ocrImageBitmap: vi.fn(async () => ({ lines: [] })),
    unloadFalcon: vi.fn(),
}));

vi.mock('../../src/features/import-agent/local/wllama-provider.js', () => ({
    initWllama: mocks.initWllama,
    createLocalProvider: mocks.createLocalProvider,
    unloadWllama: mocks.unloadWllama,
}));
vi.mock('../../src/features/import-agent/local/adapters.js', () => ({
    probeModelFile: mocks.probeModelFile,
}));
vi.mock('../../src/features/import-agent/local/falcon-ocr.js', () => ({
    initFalcon: mocks.initFalcon,
    ocrImageBitmap: mocks.ocrImageBitmap,
    unloadFalcon: mocks.unloadFalcon,
}));
vi.mock('../../src/features/import-agent/local/model-store.js', () => ({
    fileFromHandle: vi.fn(async (handle) => handle?.file ?? null),
}));

import { setupLocalModels } from '../../src/features/import-agent/local/setup.js';

const textFile = () => new File(['model'], 'model.gguf', { lastModified: 1 });
const projectorFile = () => new File(['mmproj'], 'mmproj-model-f16.gguf', { lastModified: 1 });

beforeEach(() => {
    mocks.initWllama.mockClear();
    mocks.probeModelFile.mockReset();
});

describe('the single layout', () => {
    it('loads the model and its projector as two blobs', async () => {
        const model = textFile();
        const projector = projectorFile();
        mocks.probeModelFile.mockImplementation(async (file, options) => (
            options?.role === 'projector'
                ? { ok: true, capabilities: { kind: 'gguf', projector: true }, warnings: [] }
                : { ok: true, capabilities: { kind: 'gguf', multimodal: true, vision: true }, warnings: [] }
        ));

        await setupLocalModels({
            profile: {
                mode: 'single',
                multimodal: { file: model, name: 'model.gguf', allowUnsupportedArchitecture: true },
                mmproj: { file: projector, name: 'mmproj-model-f16.gguf' },
            },
            config: {},
            tier: 'mid',
        });

        expect(mocks.probeModelFile).toHaveBeenNthCalledWith(
            1,
            model,
            expect.objectContaining({ mode: 'single', allowUnsupportedArchitecture: true }),
        );
        expect(mocks.probeModelFile).toHaveBeenNthCalledWith(2, projector, { role: 'projector' });
        expect(mocks.initWllama).toHaveBeenCalledWith(
            { blobs: [model, projector], label: 'model.gguf' },
            expect.objectContaining({
                capabilities: expect.objectContaining({ multimodal: true }),
            }),
        );
    });

    it('does not claim photo support without a projector', async () => {
        const model = textFile();
        mocks.probeModelFile.mockResolvedValue({
            ok: true,
            capabilities: { kind: 'gguf', multimodal: true, vision: true },
            warnings: [],
        });

        await setupLocalModels({
            profile: { mode: 'single', multimodal: { file: model, name: 'model.gguf' } },
            config: {},
            tier: 'mid',
        });

        expect(mocks.initWllama).toHaveBeenCalledWith(
            { file: model, label: 'model.gguf' },
            expect.objectContaining({
                capabilities: expect.objectContaining({ multimodal: false }),
            }),
        );
    });
});

describe('the split layout', () => {
    it('loads the text file from storage and probes it as a split model', async () => {
        const text = new File(['text'], 'text.gguf', { lastModified: 1 });
        const vision = new File(['onnx'], 'vision.onnx', { lastModified: 1 });
        mocks.probeModelFile.mockResolvedValue({
            ok: true,
            capabilities: { kind: 'gguf', multimodal: false, vision: false },
            warnings: [],
        });

        await setupLocalModels({
            profile: {
                mode: 'split',
                text: { file: text, name: 'text.gguf' },
                vision: { file: vision, name: 'vision.onnx' },
                support: { files: { 'tokenizer.json': new File(['{}'], 'tokenizer.json') } },
            },
            config: {},
            tier: 'mid',
        });

        expect(mocks.probeModelFile).toHaveBeenNthCalledWith(
            1,
            text,
            expect.objectContaining({ mode: 'split' }),
        );
        expect(mocks.initWllama).toHaveBeenCalledWith(
            { file: text, label: 'text.gguf' },
            expect.any(Object),
        );
    });
});
