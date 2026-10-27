// The local runtime configuration.
//
// Local mode has no cloud quota: the only bounds are the model's context and
// the device's memory. The config is a set of defaults, and the user may
// override any of them.

import { describe, it, expect } from 'vitest';
import {
    DEFAULT_LOCAL_CONFIG,
    DEFAULTS,
    deviceDefaults,
    deepMerge,
    detectTier,
    normalizeTier,
    resolveConfig,
    resolveLocalConfig,
    validateConfig,
    extractionBudgets,
} from '../../src/features/import-agent/local/local-config.js';
import { deviceSignals } from '../../src/features/import-agent/local/manifest.js';
import { clampLocalConfig, normalizeLocalProfile } from '../../supabase/functions/_shared/import-core/local-runtime.js';

describe('deviceDefaults', () => {
    it('gives the low tier a smaller context and fewer threads', () => {
        const low = deviceDefaults('low');
        expect(low.text.contextTokens).toBe(4096);
        expect(low.text.threads).toBe(2);
        expect(low.ocr.stripWidth).toBe(640);
    });

    it('gives the high tier a larger context', () => {
        expect(deviceDefaults('high').text.contextTokens).toBe(16384);
    });

    it('leaves the middle tier on the defaults', () => {
        expect(deviceDefaults('mid')).toEqual({});
    });
});

describe('deepMerge', () => {
    it('merges the nested groups without dropping the other keys', () => {
        const merged = deepMerge(
            { text: { a: 1, b: 2 }, runtime: { c: 3 } },
            { text: { b: 9 } },
        );
        expect(merged).toEqual({ text: { a: 1, b: 9 }, runtime: { c: 3 } });
    });
});

describe('resolveLocalConfig', () => {
    it('resolves defaults, then the tier, then the user choices', () => {
        const { config } = resolveLocalConfig('low', { text: { contextTokens: 12288 } });
        expect(config.text.contextTokens).toBe(12288);
        // The tier still supplies the values the user did not choose.
        expect(config.text.threads).toBe(2);
        expect(config.runtime.leaseSeconds).toBe(1800);
    });

    it('warns about a KV cache that does not fit the context', () => {
        const { warnings } = resolveLocalConfig('high', { text: { contextTokens: 32768 } });
        expect(warnings.join(' ')).toMatch(/KV cache/);
    });

    it('warns when the heartbeat is more than half the lease', () => {
        const { warnings } = resolveLocalConfig('mid', {
            runtime: { leaseSeconds: 120, heartbeatSeconds: 90 },
        });
        expect(warnings.join(' ')).toMatch(/lease/);
    });
});

describe('clampLocalConfig', () => {
    it('keeps every value inside the shared bounds', () => {
        const clamped = clampLocalConfig({
            text: { contextTokens: 10_000_000, threads: 9999, maxOutputTokens: -5 },
            runtime: { leaseSeconds: 1, parallel: 99, maxAttempts: 0 },
        });
        expect(clamped.text.contextTokens).toBe(131072);
        expect(clamped.text.threads).toBe(16);
        expect(clamped.text.maxOutputTokens).toBe(256);
        expect(clamped.runtime.leaseSeconds).toBe(60);
        expect(clamped.runtime.parallel).toBe(4);
        expect(clamped.runtime.maxAttempts).toBe(1);
    });

    it('fills the missing groups', () => {
        const clamped = clampLocalConfig({});
        expect(clamped.text.contextTokens).toBe(8192);
        expect(clamped.ocr.stripWidth).toBe(896);
        expect(clamped.runtime.leaseSeconds).toBe(900);
    });

    it('leaves the values the user chose alone', () => {
        const clamped = clampLocalConfig({ text: { contextTokens: 4096 } });
        expect(clamped.text.contextTokens).toBe(4096);
    });

    it('keeps the entered System RAM inside the shared bounds', () => {
        expect(clampLocalConfig({ runtime: { systemMemoryGb: 2000 } }).runtime.systemMemoryGb).toBe(1024);
        expect(clampLocalConfig({ runtime: { systemMemoryGb: -4 } }).runtime.systemMemoryGb).toBe(0);
        expect(clampLocalConfig({ runtime: { systemMemoryGb: 16 } }).runtime.systemMemoryGb).toBe(16);
        expect(clampLocalConfig({}).runtime.systemMemoryGb).toBe(0);
    });
});

describe('tier detection and defaults', () => {
    it('suggests low without WebGPU, high only with every signal', () => {
        expect(detectTier({ webgpu: false, threads: 16, memory: 16 })).toBe('low');
        expect(detectTier({ webgpu: true, threads: 8, memory: 8, maxBufferSize: 512 * 1024 * 1024 })).toBe('high');
        expect(detectTier({ webgpu: true, threads: 8, memory: 8, maxBufferSize: 64 * 1024 * 1024 })).toBe('mid');
    });

    it('accepts the public medium spelling for the internal mid tier', () => {
        expect(normalizeTier('medium')).toBe('mid');
        expect(normalizeTier('middle')).toBe('mid');
        expect(normalizeTier('nonsense')).toBe('mid');
        expect(deviceDefaults('medium')).toEqual({});
    });

    it('exposes resolved defaults for every public tier', () => {
        expect(DEFAULTS.low.text.contextTokens).toBe(4096);
        expect(DEFAULTS.medium.text.contextTokens).toBe(8192);
        expect(DEFAULTS.high.text.contextTokens).toBe(16384);
        expect(DEFAULTS.low.runtime.leaseSeconds).toBe(1800);
    });

    it('classifies missing device signals as unknown, not ready', () => {
        expect(deviceSignals({ webgpu: true, threads: 8, memory: 0, storageFree: 0 })).toMatchObject({
            webgpu: 'ok',
            threads: 'ok',
            memory: 'warn',
            storage: 'warn',
        });
    });

    it('lets the entered RAM replace the value the browser cannot report', () => {
        // Firefox reports 0 for deviceMemory. A clinic that typed 8 GB must
        // still be able to earn the high tier.
        expect(detectTier({
            webgpu: true,
            threads: 8,
            memory: 0,
            systemMemoryGb: 8,
            maxBufferSize: 512 * 1024 * 1024,
        })).toBe('high');
        expect(deviceSignals({ webgpu: true, threads: 8, memory: 0, systemMemoryGb: 8 }).memory).toBe('ok');
    });

    it('prefers the entered RAM over a smaller reported value', () => {
        expect(detectTier({
            webgpu: true,
            threads: 8,
            memory: 4,
            systemMemoryGb: 16,
            maxBufferSize: 512 * 1024 * 1024,
        })).toBe('high');
        expect(detectTier({
            webgpu: true,
            threads: 8,
            memory: 16,
            systemMemoryGb: 4,
            maxBufferSize: 512 * 1024 * 1024,
        })).toBe('mid');
    });
});

describe('resolveConfig', () => {
    it('uses the task argument order: user config first, tier second', () => {
        const config = resolveConfig({ text: { contextTokens: 12288 } }, 'low');
        expect(config.text.contextTokens).toBe(12288);
        expect(config.text.threads).toBe(2);
        expect(config.runtime.leaseSeconds).toBe(1800);
    });

    it('treats medium as an alias for mid', () => {
        expect(resolveConfig({}, 'medium').text.contextTokens).toBe(8192);
    });
});

describe('validateConfig', () => {
    it('accepts a complete resolved config', () => {
        expect(validateConfig(DEFAULTS.medium)).toEqual({ valid: true, errors: [] });
    });

    it('rejects values outside the shared bounds', () => {
        const { valid, errors } = validateConfig({
            text: { contextTokens: 10_000_000, threads: 99, kvCacheType: 'f32' },
            runtime: { parallel: 99 },
        });
        expect(valid).toBe(false);
        expect(errors).toEqual(expect.arrayContaining([
            'text.contextTokens',
            'text.threads',
            'text.kvCacheType',
            'runtime.parallel',
        ]));
    });

    it('checks the relational bounds the runtimes rely on', () => {
        const { valid, errors } = validateConfig({
            text: { batchSize: 128, ubatchSize: 512 },
            runtime: { leaseSeconds: 120, heartbeatSeconds: 90 },
        });
        expect(valid).toBe(false);
        expect(errors).toContain('text.ubatchSize');
        expect(errors).toContain('runtime.heartbeatSeconds');
    });

    it('ignores missing keys so the defaults can fill them', () => {
        expect(validateConfig({}).valid).toBe(true);
    });
});

describe('extractionBudgets', () => {
    it('derives the output budget from the context, not from a fixed cap', () => {
        const small = extractionBudgets({ text: { contextTokens: 4096, maxOutputTokens: 4096 } });
        const large = extractionBudgets({ text: { contextTokens: 16384, maxOutputTokens: 4096 } });
        expect(small.maxOutputTokens).toBeLessThan(large.maxOutputTokens);
        expect(large.maxOutputTokens).toBe(4096);
        expect(small.promptBudget).toBeGreaterThan(0);
    });
});

describe('normalizeLocalProfile', () => {
    it('keeps the names, the sizes and the hash, and drops the rest', () => {
        const profile = normalizeLocalProfile({
            mode: 'split',
            name: 'model.gguf',
            size: 1234,
            sha256: 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
            textName: 'text.gguf',
            handle: { secret: true },
            evil: 'x',
        });
        expect(profile.mode).toBe('split');
        expect(profile.name).toBe('model.gguf');
        expect(profile.size).toBe(1234);
        expect(profile.sha256).toMatch(/^[0-9A-F]{64}$/);
        expect(profile.textName).toBe('text.gguf');
        expect(profile.handle).toBeUndefined();
        expect(profile.evil).toBeUndefined();
    });

    it('drops a hash that is not a hash', () => {
        const profile = normalizeLocalProfile({ sha256: 'not-a-hash' });
        expect(profile.sha256).toBeUndefined();
    });
});

describe('DEFAULT_LOCAL_CONFIG', () => {
    it('has the three groups the code reads', () => {
        expect(DEFAULT_LOCAL_CONFIG.text).toBeTruthy();
        expect(DEFAULT_LOCAL_CONFIG.ocr).toBeTruthy();
        expect(DEFAULT_LOCAL_CONFIG.runtime).toBeTruthy();
    });
});
