// The v2 profile: plain JSON, no file handles, no paths.
//
// The folder is picked again each session, so the profile cannot remember
// where it was — only the name and the numbers a load needs. This test also
// proves the value stays cloneable: a profile carrying something a worker
// cannot clone threw DataCloneError in v1 (1704bd8).

import { describe, it, expect } from 'vitest';
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
    it('starts empty, with no model claimed', () => {
        const profile = loadV2Profile(fakeStore());
        expect(profile.modelId).toBeNull();
        expect(profile.contextWindow).toBe(4096);
        expect(profile.savedAt).toBeNull();
    });

    it('round-trips through storage and stamps savedAt', () => {
        const store = fakeStore();
        const saved = saveV2Profile(
            { ...emptyV2Profile(), modelId: 'qwen3-4b', sampling: { temperature: 0.3 } },
            store,
        );

        expect(saved.savedAt).toBeTypeOf('number');
        expect(store.map.has(PROFILE_KEY)).toBe(true);

        const loaded = loadV2Profile(store);
        expect(loaded.savedAt).toBe(saved.savedAt);
        expect(loaded.modelId).toBe('qwen3-4b');
        expect(loaded.sampling.temperature).toBe(0.3);
    });

    it('clamps values the browser could not use', () => {
        const profile = normalizeV2Profile({
            modelId: 'qwen3-4b',
            contextWindow: 2_000_000,
            sampling: { temperature: 99, topP: 0.001, frequencyPenalty: -9 },
        });
        // Without the model's own window, only WebLLM's ceiling applies.
        expect(profile.contextWindow).toBe(1_048_576);
        expect(profile.sampling.temperature).toBe(2);
        expect(profile.sampling.topP).toBe(0.05);
        expect(profile.sampling.frequencyPenalty).toBe(-2);
    });

    it('never exceeds the window the compiled model was built for', () => {
        expect(normalizeV2Profile({ contextWindow: 65_536 }, 8192).contextWindow).toBe(8192);
    });

    it('raises a context window that is too small to be useful', () => {
        expect(normalizeV2Profile({ contextWindow: 100 }).contextWindow).toBe(512);
    });

    it('survives a corrupt stored value', () => {
        const store = fakeStore({ [PROFILE_KEY]: '{not json' });
        expect(loadV2Profile(store).modelId).toBeNull();
    });

    it('clears', () => {
        const store = fakeStore();
        saveV2Profile({ ...emptyV2Profile(), modelId: 'gone' }, store);
        clearV2Profile(store);
        expect(store.map.has(PROFILE_KEY)).toBe(false);
        expect(loadV2Profile(store).savedAt).toBeNull();
    });

    it('is cloneable, so it can cross a worker boundary', () => {
        const profile = saveV2Profile({ ...emptyV2Profile(), modelId: 'qwen3-4b' }, fakeStore());
        expect(() => structuredClone(profile)).not.toThrow();
    });

    it('names the model a job is started with, and nothing without one', () => {
        expect(profileIdentity({ modelId: 'qwen3-4b', contextWindow: 2048 })).toEqual({
            modelId: 'qwen3-4b',
            contextWindow: 2048,
        });
        expect(profileIdentity(emptyV2Profile())).toBeNull();
    });
});
