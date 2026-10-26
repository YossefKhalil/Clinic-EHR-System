import { describe, it, expect } from 'vitest';
import {
    REMEMBER_KEY,
    readRememberPreference,
    saveRememberPreference,
    createSessionStorage,
} from '../../src/services/session-storage.js';

function memoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
        dump: () => Object.fromEntries(map),
    };
}

const SESSION_KEY = 'sb-test-auth-token';

describe('remember preference', () => {
    it('defaults to remembering the session', () => {
        expect(readRememberPreference(memoryStorage())).toBe(true);
    });

    it('round-trips the unchecked choice', () => {
        const local = memoryStorage();
        saveRememberPreference(false, local);
        expect(local.getItem(REMEMBER_KEY)).toBe('0');
        expect(readRememberPreference(local)).toBe(false);
    });

    it('survives a storage that throws', () => {
        const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
        expect(readRememberPreference(broken)).toBe(true);
        expect(() => saveRememberPreference(false, broken)).not.toThrow();
    });
});

describe('auth storage', () => {
    it('writes a remembered session to localStorage only', () => {
        const local = memoryStorage();
        const session = memoryStorage();
        const storage = createSessionStorage({ local, session });

        storage.setItem(SESSION_KEY, 'remembered');

        expect(local.getItem(SESSION_KEY)).toBe('remembered');
        expect(session.getItem(SESSION_KEY)).toBeNull();
    });

    it('writes an unremembered session to sessionStorage only', () => {
        const local = memoryStorage();
        const session = memoryStorage();
        saveRememberPreference(false, local);
        const storage = createSessionStorage({ local, session });

        storage.setItem(SESSION_KEY, 'tab-only');

        expect(session.getItem(SESSION_KEY)).toBe('tab-only');
        expect(local.getItem(SESSION_KEY)).toBeNull();
    });

    it('moves a session when the preference changes', () => {
        const local = memoryStorage();
        const session = memoryStorage();
        saveRememberPreference(false, local);
        const storage = createSessionStorage({ local, session });
        storage.setItem(SESSION_KEY, 'first');

        saveRememberPreference(true, local);
        storage.setItem(SESSION_KEY, 'second');

        expect(local.getItem(SESSION_KEY)).toBe('second');
        expect(session.getItem(SESSION_KEY)).toBeNull();
    });

    it('reads from either store', () => {
        const local = memoryStorage();
        const session = memoryStorage();
        session.setItem(SESSION_KEY, 'tab');
        const storage = createSessionStorage({ local, session });
        expect(storage.getItem(SESSION_KEY)).toBe('tab');

        local.setItem(SESSION_KEY, 'disk');
        expect(storage.getItem(SESSION_KEY)).toBe('disk');
    });

    it('sign-out clears both stores', () => {
        const local = memoryStorage();
        const session = memoryStorage();
        local.setItem(SESSION_KEY, 'a');
        session.setItem(SESSION_KEY, 'b');
        const storage = createSessionStorage({ local, session });

        storage.removeItem(SESSION_KEY);

        expect(local.getItem(SESSION_KEY)).toBeNull();
        expect(session.getItem(SESSION_KEY)).toBeNull();
    });
});
