// The shared local runtime rules.
//
// The browser and the Edge Function must clamp the local runtime settings to
// the same bounds, so the rules live in one module that both import.

import { describe, it, expect } from 'vitest';
import {
    clampLocalConfig,
    clampNumber,
    isDeterministicLocalError,
    localConfigDrift,
    localModelIdentity,
    localProfileSummary,
    normalizeLocalProfile,
    sameLocalModel,
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

    it('uses the lease and attempt bounds the task promises', () => {
        expect(LOCAL_RUNTIME_BOUNDS.leaseSeconds).toEqual({ min: 60, max: 3600 });
        expect(LOCAL_RUNTIME_BOUNDS.maxAttempts).toEqual({ min: 1, max: 10 });
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

    it('keeps the per-slot hashes', () => {
        const textHash = 'A'.repeat(64);
        const visionHash = 'B'.repeat(64);
        const profile = normalizeLocalProfile({
            mode: 'split',
            textName: 'text.gguf',
            textSha256: textHash,
            visionName: 'vision.onnx',
            visionSha256: visionHash,
        });
        expect(profile.textSha256).toBe(textHash);
        expect(profile.visionSha256).toBe(visionHash);
    });
});

describe('localProfileSummary', () => {
    it('flattens the picked slots and never keeps a handle', () => {
        const textHash = 'A'.repeat(64);
        const visionHash = 'B'.repeat(64);
        const summary = localProfileSummary({
            mode: 'split',
            text: { name: 'text.gguf', size: 10, sha256: textHash, handle: { name: 'secret' } },
            vision: { name: 'vision.onnx', size: 20, sha256: visionHash },
            support: { name: 'support', handle: { name: 'secret' }, files: {} },
        });
        expect(summary).toEqual({
            mode: 'split',
            textName: 'text.gguf',
            textSize: 10,
            textSha256: textHash,
            visionName: 'vision.onnx',
            visionSize: 20,
            visionSha256: visionHash,
            supportName: 'support',
        });
        expect(JSON.stringify(summary)).not.toContain('secret');
    });
});

describe('localModelIdentity', () => {
    it('names the multimodal model in the single layout', () => {
        const hash = 'A'.repeat(64);
        expect(localModelIdentity({ mode: 'single', name: 'model.gguf', sha256: hash }))
            .toEqual({ mode: 'single', name: 'model.gguf', sha256: hash });
    });

    it('names the text model and carries the optional vision model in the split layout', () => {
        const textHash = 'A'.repeat(64);
        const visionHash = 'B'.repeat(64);
        expect(localModelIdentity({
            mode: 'split',
            textName: 'text.gguf',
            textSha256: textHash,
            visionName: 'vision.onnx',
            visionSha256: visionHash,
        })).toEqual({
            mode: 'split',
            name: 'text.gguf',
            sha256: textHash,
            vision: { name: 'vision.onnx', sha256: visionHash },
        });
    });
});

describe('sameLocalModel', () => {
    it('accepts the same name and hash', () => {
        const model = { mode: 'single', name: 'model.gguf', sha256: 'A'.repeat(64) };
        expect(sameLocalModel(model, { ...model })).toBe(true);
    });

    it('refuses a different hash even when the name is the same', () => {
        expect(sameLocalModel(
            { mode: 'single', name: 'model.gguf', sha256: 'A'.repeat(64) },
            { mode: 'single', name: 'model.gguf', sha256: 'B'.repeat(64) },
        )).toBe(false);
    });

    it('does not treat a missing hash as a different file', () => {
        expect(sameLocalModel(
            { mode: 'single', name: 'model.gguf', sha256: 'A'.repeat(64) },
            { mode: 'single', name: 'model.gguf' },
        )).toBe(true);
    });

    it('refuses a different layout or vision model', () => {
        expect(sameLocalModel(
            { mode: 'single', name: 'model.gguf' },
            { mode: 'split', name: 'model.gguf' },
        )).toBe(false);
        expect(sameLocalModel(
            { mode: 'split', name: 'text.gguf', vision: { name: 'a.onnx' } },
            { mode: 'split', name: 'text.gguf', vision: { name: 'b.onnx' } },
        )).toBe(false);
    });
});

describe('localConfigDrift', () => {
    it('ignores runtime knobs that do not change the result', () => {
        const base = clampLocalConfig({});
        expect(localConfigDrift(base, {
            ...base,
            runtime: { ...base.runtime, leaseSeconds: 1200, parallel: 2 },
        })).toBe(false);
    });

    it('refuses a different context window or OCR setting', () => {
        const base = clampLocalConfig({});
        expect(localConfigDrift(base, {
            ...base,
            text: { ...base.text, contextTokens: 4096 },
        })).toBe(true);
        expect(localConfigDrift(base, {
            ...base,
            ocr: { ...base.ocr, stripWidth: 448 },
        })).toBe(true);
    });

    it('does not invent drift for a job that stored no config', () => {
        expect(localConfigDrift({}, clampLocalConfig({}))).toBe(false);
    });
});

describe('isDeterministicLocalError', () => {
    it('knows the errors that cannot succeed on a retry', () => {
        expect(isDeterministicLocalError('MODEL_FILE_UNAVAILABLE')).toBe(true);
        expect(isDeterministicLocalError('CONFIG_DRIFT')).toBe(true);
        expect(isDeterministicLocalError('TIMEOUT')).toBe(false);
        expect(isDeterministicLocalError(undefined)).toBe(false);
    });
});
