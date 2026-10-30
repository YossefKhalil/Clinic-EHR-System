// The v2 profile: plain JSON, no file handles.
//
// v1 had to store handles and blobs, and a profile carrying something
// non-cloneable threw DataCloneError (1704bd8). v2 stores strings and numbers
// only, and this test proves that stays true.

import { describe, it, expect } from 'vitest';
import { defaultModel } from '../../src/features/import-agent/local-v2/catalog.js';
import {
    PROFILE_KEY,
    clearV2Profile,
    emptyV2Profile,
    loadV2Profile,
    normalizeV2Profile,
    profileIdentity,
    saveV2Profile,
} from '../../src/features/import-agent/local-v2/profile.js';

function fakeStore(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
    };
}

describe('the v2 profile', () => {
    it('starts on the catalog default with nothing saved', () => {
        const profile = loadV2Profile(fakeStore());
        expect(profile.modelId).toBe(defaultModel().id);
        expect(profile.contextWindow).toBe(defaultModel().contextWindow);
        expect(profile.savedAt).toBeNull();
    });

    it('round-trips through storage and stamps savedAt', () => {
        const store = fakeStore();
        const saved = saveV2Profile({ ...emptyV2Profile(), sampling: { temperature: 0.3 } }, store);

        expect(saved.savedAt).toBeTypeOf('number');
        expect(store.map.has(PROFILE_KEY)).toBe(true);

        const loaded = loadV2Profile(store);
        expect(loaded.savedAt).toBe(saved.savedAt);
        expect(loaded.sampling.temperature).toBe(0.3);
    });

    it('clamps values the browser could not use', () => {
        const profile = normalizeV2Profile({
            modelId: defaultModel().id,
            contextWindow: 999_999,
            sampling: { temperature: 99, topP: 0.001, frequencyPenalty: -9 },
        });
        // The window cannot exceed what the model was built for.
        expect(profile.contextWindow).toBe(defaultModel().contextWindow);
        expect(profile.sampling.temperature).toBe(2);
        expect(profile.sampling.topP).toBe(0.05);
        expect(profile.sampling.frequencyPenalty).toBe(-2);
    });

    it('raises a context window that is too small to be useful', () => {
        expect(normalizeV2Profile({ contextWindow: 100 }).contextWindow).toBe(512);
    });

    it('falls back to the default model for an unknown id', () => {
        expect(normalizeV2Profile({ modelId: 'gone' }).modelId).toBe(defaultModel().id);
    });

    it('survives a corrupt stored value', () => {
        const store = fakeStore({ [PROFILE_KEY]: '{not json' });
        expect(loadV2Profile(store).modelId).toBe(defaultModel().id);
    });

    it('clears', () => {
        const store = fakeStore();
        saveV2Profile(emptyV2Profile(), store);
        clearV2Profile(store);
        expect(store.map.has(PROFILE_KEY)).toBe(false);
        expect(loadV2Profile(store).savedAt).toBeNull();
    });

    it('is cloneable, so it can cross a worker boundary', () => {
        const profile = saveV2Profile(emptyV2Profile(), fakeStore());
        expect(() => structuredClone(profile)).not.toThrow();
    });

    it('names the model a job is started with', () => {
        const identity = profileIdentity({ modelId: defaultModel().id, contextWindow: 2048 });
        expect(identity).toEqual({
            modelId: defaultModel().id,
            quant: defaultModel().quant,
            contextWindow: 2048,
        });
    });
});
