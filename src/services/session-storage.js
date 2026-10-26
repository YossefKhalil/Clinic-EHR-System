// Where the Supabase session is kept.
//
// "Remember me" chooses the storage: checked keeps the session in
// `localStorage`, so it survives a browser restart; unchecked keeps it in
// `sessionStorage`, so it survives navigation and a reload in the same tab and
// ends when the tab closes. The preference itself always lives in
// `localStorage`, so the checkbox comes back the way the user left it.

export const REMEMBER_KEY = 'clinic.rememberSession';

function safeStorage(candidate) {
    try {
        // Reading `window.localStorage` itself can throw (blocked storage).
        return candidate ?? null;
    } catch {
        return null;
    }
}

function defaultLocal() {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
}

function defaultSession() {
    try {
        return typeof window !== 'undefined' ? window.sessionStorage : null;
    } catch {
        return null;
    }
}

/** True unless the user explicitly unchecked "Remember me" last time. */
export function readRememberPreference(local = defaultLocal()) {
    const store = safeStorage(local);
    try {
        const raw = store?.getItem(REMEMBER_KEY);
        return raw === '0' ? false : true;
    } catch {
        return true;
    }
}

export function saveRememberPreference(remember, local = defaultLocal()) {
    const store = safeStorage(local);
    try {
        store?.setItem(REMEMBER_KEY, remember ? '1' : '0');
    } catch {
        // A full or blocked storage must not break signing in.
    }
}

/**
 * The storage object handed to supabase-js.
 *
 * Reads look in both stores (a remembered session is always in
 * `localStorage`); writes go to the one the current preference selects and
 * clear the other, so switching the checkbox moves the session instead of
 * leaving a stale copy behind.
 */
export function createSessionStorage({ local, session } = {}) {
    const localStore = safeStorage(local ?? defaultLocal());
    const sessionStore = safeStorage(session ?? defaultSession());

    return {
        getItem(key) {
            try {
                const remembered = localStore?.getItem(key);
                if (remembered !== null && remembered !== undefined) return remembered;
            } catch { /* fall through to the tab store */ }
            try {
                return sessionStore?.getItem(key) ?? null;
            } catch {
                return null;
            }
        },
        setItem(key, value) {
            if (readRememberPreference(localStore)) {
                try { localStore?.setItem(key, value); } catch { /* ignore */ }
                try { sessionStore?.removeItem(key); } catch { /* ignore */ }
                return;
            }
            try { sessionStore?.setItem(key, value); } catch { /* ignore */ }
            try { localStore?.removeItem(key); } catch { /* ignore */ }
        },
        removeItem(key) {
            try { localStore?.removeItem(key); } catch { /* ignore */ }
            try { sessionStore?.removeItem(key); } catch { /* ignore */ }
        },
    };
}
