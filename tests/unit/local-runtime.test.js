// The shared local runtime rules.
//
// The browser and the Edge Function must clamp the local runtime settings to
// the same bounds, so the rules live in one module that both import.

import { describe, it, expect } from 'vitest';
import {
    clampLocalConfig,
    clampNumber,
    normalizeLocalProfile,
} from '../../supabase/functions/_shared/import-core/local-runtime.js';
import { LOCAL_RUNTIME_BOUNDS } from '../../supabase/functions/_shared/import-core/limits.js';

describe('clampNumber', () => {
    it('keeps a number inside the range', () => {
        expect(clampNumber(5, 1, 10, 0)).toBe(5);
        expect(clampNumber(0, 1, 10, 7)).toBe(1);
        expect(clampNumber(99, 1, 10, 7)).toBe(10);
    });

    it('falls back when the value is not a number', () => {
        expect(clampNumber('abc', 1, 10, 7)).toBe(7);
        expect(clampNumber(null, 1, 10, 7)).toBe(7);
        expect(clampNumber(undefined, 1, 10, 7)).toBe(7);
    });
});

describe('the shared bounds', () => {
    it('covers every value the browser may send', () => {
        expect(LOCAL_RUNTIME_BOUNDS.contextTokens.min).toBeGreaterThan(0);
        expect(LOCAL_RUNTIME_BOUNDS.leaseSeconds.max).toBeGreaterThan(LOCAL_RUNTIME_BOUNDS.leaseSeconds.min);
        expect(LOCAL_RUNTIME_BOUNDS.parallel.max).toBeGreaterThanOrEqual(1);
        expect(LOCAL_RUNTIME_BOUNDS.maxAttempts.max).toBeGreaterThanOrEqual(LOCAL_RUNTIME_BOUNDS.maxAttempts.min);
    });
});

describe('clampLocalConfig', () => {
    it('clamps a value the browser could not have produced', () => {
        const clamped = clampLocalConfig({ runtime: { parallel: 1000 } });
        expect(clamped.runtime.parallel).toBe(LOCAL_RUNTIME_BOUNDS.parallel.max);
    });

    it('does not drop the values it does not know', () => {
        const clamped = clampLocalConfig({ text: { custom: 'kept' } });
        expect(clamped.text.custom).toBe('kept');
    });
});

describe('normalizeLocalProfile', () => {
    it('never keeps a file handle', () => {
        const profile = normalizeLocalProfile({
            mode: 'single',
            name: 'model.gguf',
            size: 10,
            handle: { name: 'model.gguf' },
        });
        expect(profile.handle).toBeUndefined();
        expect(profile.name).toBe('model.gguf');
    });

    it('refuses a mode it does not know', () => {
        expect(normalizeLocalProfile({ mode: 'triple' }).mode).toBeUndefined();
    });
});
