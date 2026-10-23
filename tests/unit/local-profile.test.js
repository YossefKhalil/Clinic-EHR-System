// The local model profile.
//
// The profile says which models the clinic picked. The files themselves stay
// in the browser, so the profile only ever holds names, sizes and hashes.

import { describe, it, expect } from 'vitest';
import {
    emptyProfile,
    profileComplete,
    fileKind,
    missingSupportFiles,
    supportFilesComplete,
    supportFilesFromFileList,
    PROFILE_MODES,
} from '../../src/features/import-agent/local/model-profile.js';
import { OCR_SUPPORT_FILES } from '../../src/features/import-agent/local/manifest.js';

describe('emptyProfile', () => {
    it('starts on the single layout with nothing picked', () => {
        const profile = emptyProfile();
        expect(profile.mode).toBe('single');
        expect(profile.multimodal).toBeNull();
        expect(profile.text).toBeNull();
        expect(profile.vision).toBeNull();
        expect(profile.support).toBeNull();
    });
});

describe('profileComplete', () => {
    it('needs one model for the single layout', () => {
        const profile = emptyProfile();
        expect(profileComplete(profile)).toBe(false);
        profile.multimodal = { name: 'model.gguf' };
        expect(profileComplete(profile)).toBe(true);
    });

    it('needs text model for the split layout, vision and support files are optional', () => {
        const profile = emptyProfile();
        profile.mode = 'split';
        profile.text = { name: 'text.gguf' };
        profile.vision = { name: 'vision.onnx' };
        expect(profileComplete(profile)).toBe(true);

        // Vision is optional
        profile.vision = null;
        expect(profileComplete(profile)).toBe(true);

        // Support files are optional
        profile.vision = { name: 'vision.onnx' };
        profile.support = { files: { 'tokenizer.json': {} } };
        expect(profileComplete(profile)).toBe(true);
    });

    it('requires text model for split layout', () => {
        const profile = emptyProfile();
        profile.mode = 'split';
        profile.vision = { name: 'vision.onnx' };
        expect(profileComplete(profile)).toBe(false);

        profile.text = { name: 'text.gguf' };
        expect(profileComplete(profile)).toBe(true);
    });
});

describe('fileKind', () => {
    it('reads the kind from the name', () => {
        expect(fileKind('a.GGUF')).toBe('gguf');
        expect(fileKind('b.onnx')).toBe('onnx');
        expect(fileKind('c.txt')).toBe('unknown');
    });
});

describe('the support files', () => {
    it('names the files the vision model needs', () => {
        expect(OCR_SUPPORT_FILES).toContain('tokenizer.json');
        expect(OCR_SUPPORT_FILES).toContain('config.json');
        expect(OCR_SUPPORT_FILES).toContain('special_tokens_map.json');
    });

    it('lists the files that are missing', () => {
        const support = { files: { 'tokenizer.json': {} } };
        expect(supportFilesComplete(support)).toBe(false);
        expect(missingSupportFiles(support)).toContain('config.json');
        expect(missingSupportFiles(support)).not.toContain('tokenizer.json');
    });

    it('reads the files of a file list', () => {
        const files = [
            { name: 'tokenizer.json' },
            { name: 'config.json' },
        ];
        const support = supportFilesFromFileList(files);
        expect(Object.keys(support.files).sort()).toEqual(['config.json', 'tokenizer.json']);
    });
});

describe('PROFILE_MODES', () => {
    it('knows the two layouts', () => {
        expect(PROFILE_MODES).toEqual(['single', 'split']);
    });
});
