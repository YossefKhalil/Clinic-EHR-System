// The support files of a vision model.
//
// The tokenizer and the config files are small, so they are kept in the
// browser next to the model. They are only required when a vision model
// is configured in the split layout.

import { describe, it, expect } from 'vitest';
import {
    emptyProfile,
    profileComplete,
    supportFilesComplete,
    missingSupportFiles,
    supportFilesFromFileList,
} from '../../src/features/import-agent/local/model-profile.js';
import { OCR_SUPPORT_FILES } from '../../src/features/import-agent/local/manifest.js';

function fakeFile(name) {
    return { name, size: 10 };
}

describe('the support files', () => {
    it('are needed by the two-model layout only when vision is present', () => {
        const profile = emptyProfile();
        profile.mode = 'split';
        profile.text = { name: 'text.gguf' };
        // Without vision, support files not needed
        expect(profileComplete(profile)).toBe(true);

        profile.vision = { name: 'vision.onnx' };
        expect(profileComplete(profile)).toBe(true);

        // Support files only needed when vision is present
        profile.support = { files: { 'tokenizer.json': fakeFile('tokenizer.json') } };
        expect(profileComplete(profile)).toBe(true);
        expect(missingSupportFiles(profile.support)).toContain('config.json');

        for (const name of OCR_SUPPORT_FILES) profile.support.files[name] = fakeFile(name);
        expect(profileComplete(profile)).toBe(true);
        expect(missingSupportFiles(profile.support)).toEqual([]);
    });

    it('are read from a file list', () => {
        const support = supportFilesFromFileList([
            fakeFile('tokenizer.json'),
            fakeFile('config.json'),
        ]);
        expect(Object.keys(support.files)).toEqual(['tokenizer.json', 'config.json']);
        expect(missingSupportFiles(support).length).toBe(OCR_SUPPORT_FILES.length - 2);
    });

    it('are complete when every file is there', () => {
        const support = { files: Object.fromEntries(OCR_SUPPORT_FILES.map((name) => [name, fakeFile(name)])) };
        expect(supportFilesComplete(support)).toBe(true);
        expect(missingSupportFiles(support)).toEqual([]);
    });
});
