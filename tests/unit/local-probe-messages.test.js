// Probe messages.
//
// Every refusal code the capability probe can return must have a sentence in
// both locales. The card shows the sentence, not the raw English detail, so a
// missing key is a broken refusal rather than a cosmetic gap.

import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
    PROBE_MESSAGE_KEYS,
    probeMessageKey,
    probeMessageParams,
    formatBytes,
    formatProbeMessage,
} from '../../src/features/import-agent/local/probe-messages.js';
import { PROBE_CODES } from '../../src/features/import-agent/local/adapters.js';

const en = JSON.parse(fs.readFileSync(new URL('../../src/locales/en.json', import.meta.url), 'utf8'));
const ar = JSON.parse(fs.readFileSync(new URL('../../src/locales/ar.json', import.meta.url), 'utf8'));

describe('the probe message catalogue', () => {
    it('has a key for every probe code', () => {
        for (const code of Object.values(PROBE_CODES)) {
            expect(probeMessageKey(code)).toBe(`aiSettings.local.probe.${code}`);
        }
    });

    it('keeps the same sentence keys and placeholders in both locales', () => {
        for (const key of Object.values(PROBE_MESSAGE_KEYS)) {
            expect(en[key]).toBeTypeOf('string');
            expect(ar[key]).toBeTypeOf('string');
            const marks = (value) => (String(value).match(/:[a-zA-Z_][a-zA-Z0-9_]*/g) || []).sort();
            expect(marks(ar[key])).toEqual(marks(en[key]));
        }
    });
});

describe('formatProbeMessage', () => {
    it('renders the code through the locale function', () => {
        const text = formatProbeMessage(
            (key, params) => `${key}|${params.architecture}`,
            {
                code: 'GGUF_ARCH_UNSUPPORTED',
                capabilities: { architecture: 'brand-new' },
            },
        );
        expect(text).toBe('aiSettings.local.probe.GGUF_ARCH_UNSUPPORTED|brand-new');
    });

    it('fills the read and total size a truncated file reports', () => {
        const params = probeMessageParams({
            code: 'ONNX_TRUNCATED',
            bytesConsumed: 1500,
            fileSize: 2048,
        });
        expect(params.read).toBe('1.5 KB');
        expect(params.total).toBe('2.0 KB');
        expect(params.architecture).toBe('?');
    });

    it('falls back to the code and the diagnostic detail', () => {
        expect(formatProbeMessage(() => '', { code: 'SOMETHING_NEW', message: 'broken' }))
            .toBe('SOMETHING_NEW: broken');
    });
});

describe('formatBytes', () => {
    it('uses the same rounded units as the card', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(999)).toBe('999 B');
        expect(formatBytes(1500)).toBe('1.5 KB');
        expect(formatBytes(2 * 1024 * 1024)).toBe('2.1 MB');
    });
});
