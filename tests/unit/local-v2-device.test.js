// The device-fit decision.
//
// The fit check is what the card shows before a model is loaded, so the
// refusals are tested by hand: no WebGPU, no adapter, no float16 shaders, too
// little memory, and the two cases that must pass — a capable machine and a
// browser that reports nothing at all.

import { describe, it, expect } from 'vitest';
import {
    assessFit,
    formatGb,
    needsShaderF16,
} from '../../src/features/import-agent/local-v2/device.js';

const device = (overrides = {}) => ({
    available: true,
    shaderF16: true,
    features: ['shader-f16'],
    ...overrides,
});

const roomyCapacity = { deviceMemoryGb: 16, freeBytes: 100e9 };

const model = {
    id: 'qwen3-4b',
    quant: 'q4f16_1',
    contextWindow: 4096,
    // 4.7 GB of weights plus the KV cache at 4096.
    vramEstimateMb: 5700,
};

describe('assessFit', () => {
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

    it('refuses a computer that reports too little memory, with both numbers', () => {
        const fit = assessFit(model, device(), { deviceMemoryGb: 2, freeBytes: 100e9 });
        expect(fit.code).toBe('DEVICE_RAM_SHORT');
        expect(fit.params.haveGb).toBe('2');
        expect(Number(fit.params.needGb)).toBeGreaterThan(2);
    });

    it('accepts a capable machine', () => {
        expect(assessFit(model, device(), roomyCapacity)).toEqual({ ok: true, code: null, params: {} });
    });

    it('does not invent limits when the browser reports nothing', () => {
        // No deviceMemory: the check is skipped rather than guessed. The
        // files are on disk already, so storage is not a fit question.
        const fit = assessFit(model, device(), { deviceMemoryGb: 0, freeBytes: null });
        expect(fit.ok).toBe(true);
    });

    it('refuses an unknown model', () => {
        expect(assessFit(null, device(), roomyCapacity).code).toBe('MODEL_UNKNOWN');
    });

    it('does not judge a model whose size is unknown', () => {
        const fit = assessFit({ ...model, vramEstimateMb: 0 }, device(), { deviceMemoryGb: 2 });
        expect(fit.ok).toBe(true);
    });
});

describe('model helpers', () => {
    it('turns bytes into gigabytes for the card', () => {
        expect(formatGb(4_440_000_000)).toBe('4.4 GB');
        expect(formatGb(20e9)).toBe('20 GB');
        expect(formatGb(0)).toBe('0 GB');
    });

    it('knows which quants need half-precision shaders', () => {
        expect(needsShaderF16({ quant: 'q4f16_1' })).toBe(true);
        expect(needsShaderF16({ quant: 'q4f32_1' })).toBe(false);
        expect(needsShaderF16({ requiresShaderF16: true })).toBe(true);
        expect(needsShaderF16({})).toBe(false);
    });
});
