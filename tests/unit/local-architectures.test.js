// The architecture manifest.
//
// The runtime's architecture list is evidence, not a public API: it is copied
// from the wllama build the app ships with. This test keeps the copy and the
// installed package in step, so an upgrade cannot silently widen or narrow the
// models the settings card offers.

import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
    SUPPORTED_ARCHITECTURES,
    isSupportedArchitecture,
    runtimeIdentityLabel,
} from '../../src/features/import-agent/local/gguf-metadata.js';

const manifest = JSON.parse(fs.readFileSync(
    new URL('../../src/features/import-agent/local/architectures.json', import.meta.url),
    'utf8',
));
const wllamaPackage = JSON.parse(fs.readFileSync(
    new URL('../../node_modules/@wllama/wllama/package.json', import.meta.url),
    'utf8',
));

describe('the checked-in architecture list', () => {
    it('belongs to the installed wllama build', () => {
        expect(manifest.wllamaVersion).toBe(wllamaPackage.version);
        expect(manifest.architectures).toEqual(SUPPORTED_ARCHITECTURES);
    });

    it('keeps the common architectures the app documented before', () => {
        for (const name of ['llama', 'mistral', 'qwen2', 'gemma', 'gemma2', 'gemma3', 'phi2', 'phi3', 'deepseek2', 'falcon']) {
            expect(SUPPORTED_ARCHITECTURES).toContain(name);
        }
        expect(isSupportedArchitecture('llama')).toBe(true);
        expect(isSupportedArchitecture('not-a-real-architecture')).toBe(false);
    });

    it('names only the runtime it can actually identify', () => {
        // wllama does not expose the llama.cpp revision, so the label stops at
        // the wrapper version instead of inventing one.
        expect(runtimeIdentityLabel()).toMatch(/^wllama \d+\.\d+\.\d+/);
    });
});
