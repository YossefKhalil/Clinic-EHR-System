// The local profile across a settings reload.
//
// The server only knows the model name, size and hash. The file handle lives
// in IndexedDB. A settings save rebuilds the draft from the server, so the
// persistence layer has to carry a handle forward instead of writing `null`
// over it.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    clearProfile,
    emptyProfile,
    loadProfile,
    profileComplete,
    saveProfile,
} from '../../src/features/import-agent/local/model-profile.js';
import {
    createLocalState,
    emptySlot,
    persistLocalState,
    restoreLocalState,
} from '../../src/services/ai-local.js';

function handleOf(name = 'text.gguf') {
    // IndexedDB stores handles by structured clone. A plain object is all the
    // tests need; the browser's real FileSystemFileHandle is cloneable too,
    // while a stub with methods would not be.
    return { kind: 'file', name, size: 11 };
}

beforeEach(async () => {
    await clearProfile();
});

describe('the local profile round-trip', () => {
    it('saves and loads the file handle with the profile', async () => {
        const handle = handleOf();
        const profile = emptyProfile();
        profile.mode = 'split';
        profile.text = {
            handle,
            name: 'text.gguf',
            kind: 'gguf',
            size: 11,
            sha256: '',
        };

        await saveProfile(profile);
        const loaded = await loadProfile();

        expect(loaded.mode).toBe('split');
        expect(loaded.text.name).toBe('text.gguf');
        expect(loaded.text.handle).toMatchObject({ kind: 'file', name: 'text.gguf' });
    });

    it('accepts a split profile with only the text model', () => {
        const profile = emptyProfile();
        profile.mode = 'split';
        profile.text = { name: 'text.gguf' };

        expect(profileComplete(profile)).toBe(true);
        expect(profile.vision).toBe(null);
        expect(profile.support).toBe(null);
    });
});

describe('a save after the card reloads', () => {
    it('keeps the stored handle when the draft has the same file name', async () => {
        const handle = handleOf();
        const first = createLocalState();
        first.mode = 'split';
        first.text = {
            ...emptySlot(),
            handle,
            name: 'text.gguf',
            size: 11,
            status: 'ok',
        };
        await persistLocalState(first);

        // This is the shape after the server response rebuilt the form: the
        // name and the size are there, but the browser-side handle is not.
        const second = createLocalState();
        second.mode = 'split';
        second.text = {
            ...emptySlot(),
            name: 'text.gguf',
            size: 11,
            status: 'warn',
        };
        await persistLocalState(second);

        const loaded = await loadProfile();
        expect(loaded.text.handle).toMatchObject({ kind: 'file', name: 'text.gguf' });
    });

    it('does not carry a handle over a different file', async () => {
        const first = createLocalState();
        first.mode = 'split';
        first.text = {
            ...emptySlot(),
            handle: handleOf('old.gguf'),
            name: 'old.gguf',
            size: 11,
        };
        await persistLocalState(first);

        const second = createLocalState();
        second.mode = 'split';
        second.text = {
            ...emptySlot(),
            name: 'new.gguf',
            size: 11,
            status: 'warn',
        };
        await persistLocalState(second);

        expect((await loadProfile()).text.handle).toBe(null);
    });
});

describe('restoring the card after a reload', () => {
    it('shows Not verified, not Ready, until permission is granted again', async () => {
        const handle = handleOf();
        const state = createLocalState();
        state.mode = 'split';
        state.text = {
            ...emptySlot(),
            handle,
            name: 'text.gguf',
            size: 11,
            status: 'ok',
            sha256: 'A'.repeat(64),
        };
        await persistLocalState(state);

        const restored = await restoreLocalState(createLocalState());

        expect(restored.mode).toBe('split');
        expect(restored.text.handle).toMatchObject({ kind: 'file', name: 'text.gguf' });
        expect(restored.text.name).toBe('text.gguf');
        expect(restored.text.status).toBe('warn');
        expect(restored.text.sha256).toBe('A'.repeat(64));
    });

    it('keeps the stored File for browsers without a handle', async () => {
        const file = new File(['model bytes'], 'text.gguf', { lastModified: 1 });
        const first = createLocalState();
        first.mode = 'split';
        first.text = {
            ...emptySlot(),
            file,
            name: file.name,
            size: file.size,
            status: 'warn',
        };
        await persistLocalState(first);

        const loaded = await loadProfile();
        expect(loaded.text.handle).toBe(null);
        expect(loaded.text.file).toBeTruthy();
        expect(loaded.text.file.name).toBe('text.gguf');

        const restored = await restoreLocalState(createLocalState());
        expect(restored.text.file).toBeTruthy();
        expect(restored.text.status).toBe('warn');
        expect(restored.text.message).toBe('aiSettings.local.fileRestored');
    });

    it('keeps the optional projector with the single model', async () => {
        const state = createLocalState();
        state.mode = 'single';
        state.multimodal = {
            ...emptySlot(),
            handle: handleOf('model.gguf'),
            name: 'model.gguf',
            size: 11,
            status: 'ok',
        };
        state.mmproj = {
            ...emptySlot(),
            file: new File(['projector bytes'], 'mmproj-model-f16.gguf', { lastModified: 1 }),
            name: 'mmproj-model-f16.gguf',
            size: 15,
            status: 'ok',
        };
        await persistLocalState(state);

        const loaded = await loadProfile();
        expect(loaded.mode).toBe('single');
        expect(loaded.mmproj.name).toBe('mmproj-model-f16.gguf');
        expect(loaded.mmproj.file).toBeTruthy();

        const restored = await restoreLocalState(createLocalState());
        expect(restored.mmproj.name).toBe('mmproj-model-f16.gguf');
        expect(restored.mmproj.file).toBeTruthy();
    });

    it('explains how to repair a profile whose handle is missing', async () => {
        const profile = emptyProfile();
        profile.mode = 'split';
        profile.text = {
            handle: null,
            name: 'text.gguf',
            kind: 'gguf',
            size: 11,
            sha256: '',
        };
        await saveProfile(profile);

        const restored = await restoreLocalState(createLocalState());

        expect(restored.text.status).toBe('error');
        expect(restored.text.message).toBe('aiSettings.local.handleMissing');
        expect(restored.text.code).toBe('MODEL_FILE_UNAVAILABLE');
    });
});
