// The v2 catalog and the device-fit decision.
//
// The fit check is what the card shows before 4 GB start downloading, so the
// refusals are tested by hand: no WebGPU, no adapter, no float16 shaders, too
// little memory, too little storage, and the one case that must pass.

import { describe, it, expect } from 'vitest';
import {
    assessFit,
    defaultModel,
    formatGb,
    modelById,
    modelBytes,
    models,
    needsShaderF16,
} from '../../src/features/import-agent/local-v2/catalog.js';

const device = (overrides = {}) => ({
    available: true,
    shaderF16: true,
    features: ['shader-f16'],
    ...overrides,
});

const roomyCapacity = { deviceMemoryGb: 16, freeBytes: 100e9 };

describe('the catalog', () => {
    it('ships the reference model with everything the engine needs', () => {
        const model = defaultModel();
        expect(model).not.toBeNull();
        expect(model.id).toBe('LFM2.5-8B-A1B-q4f16_1-MLC');
        expect(model.baseUrl).toMatch(/^https:\/\//);
        expect(model.modelLib).toMatch(/webgpu\.wasm$/);
        expect(model.contextWindow).toBe(4096);
        expect(model.modalities).toContain('text');
        expect(model.modalities).not.toContain('vision');
    });

    it('finds a model by id and returns null for an unknown one', () => {
        expect(modelById('LFM2.5-8B-A1B-q4f16_1-MLC')?.name).toBe('LFM2.5-8B-A1B');
        expect(modelById('nope')).toBeNull();
        expect(models().length).toBeGreaterThan(0);
    });

    it('turns gigabytes into bytes and back for the card', () => {
        const model = defaultModel();
        expect(modelBytes(model)).toBe(4_440_000_000);
        expect(formatGb(4_440_000_000)).toBe('4.4 GB');
        expect(formatGb(20e9)).toBe('20 GB');
        expect(formatGb(0)).toBe('0 GB');
    });

    it('knows which quants need half-precision shaders', () => {
        expect(needsShaderF16({ quant: 'q4f16_1' })).toBe(true);
        expect(needsShaderF16({ quant: 'q4f32_1' })).toBe(false);
        expect(needsShaderF16({})).toBe(false);
    });
});

describe('assessFit', () => {
    const model = defaultModel();

    it('refuses a browser without WebGPU', () => {
        const fit = assessFit(model, { available: false, code: 'WEBGPU_MISSING' }, roomyCapacity);
        expect(fit.ok).toBe(false);
        expect(fit.code).toBe('WEBGPU_MISSING');
    });

    it('passes through the adapter refusal', () => {
        const fit = assessFit(model, { available: false, code: 'WEBGPU_ADAPTER_MISSING' }, roomyCapacity);
        expect(fit.code).toBe('WEBGPU_ADAPTER_MISSING');
    });

    it('refuses a GPU without shader-f16 and names the quant', () => {
        const fit = assessFit(model, device({ shaderF16: false, features: [] }), roomyCapacity);
        expect(fit.code).toBe('WEBGPU_SHADER_F16_MISSING');
        expect(fit.params.quant).toBe('q4f16_1');
    });

    it('refuses a device that reports too little memory, with both numbers', () => {
        const fit = assessFit(model, device(), { deviceMemoryGb: 2, freeBytes: 100e9 });
        expect(fit.code).toBe('DEVICE_RAM_SHORT');
        expect(fit.params.haveGb).toBe('2');
        expect(Number(fit.params.needGb)).toBeGreaterThan(2);
    });

    it('refuses a device without the disk space, with both numbers', () => {
        const fit = assessFit(model, device(), { deviceMemoryGb: 16, freeBytes: 1e9 });
        expect(fit.code).toBe('STORAGE_SHORT');
        expect(fit.params.needGb).toBe('5.3');
        expect(fit.params.freeGb).toBe('1.0');
    });

    it('accepts a capable device', () => {
        const fit = assessFit(model, device(), roomyCapacity);
        expect(fit).toEqual({ ok: true, code: null, params: {} });
    });

    it('does not invent limits when the browser reports nothing', () => {
        // No deviceMemory / storage estimate: the checks that need them are
        // skipped rather than guessed.
        const fit = assessFit(model, device(), { deviceMemoryGb: 0, freeBytes: null });
        expect(fit.ok).toBe(true);
    });

    it('refuses an unknown model', () => {
        expect(assessFit(null, device(), roomyCapacity).code).toBe('MODEL_UNKNOWN');
    });
});
