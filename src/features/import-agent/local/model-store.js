// The model store.
//
// The model files stay on the clinic's PC. What the browser needs from them
// is the bytes (to load the model) and a hash (to say which model produced a
// record). The file handle itself lives with the profile, in model-profile.js.
//
// Performance:
//  - The hash is read in pieces, so a 686 MB file never lands in memory as
//    one buffer.
//  - A file that is replaced by one with the same name and the same size is
//    hashed again: the stamp in the cache includes the modification time.

import { createSHA256 } from 'hash-wasm';

const DB_NAME = 'clinic-local-models';
const DB_VERSION = 1;
const STORE_META = 'meta';

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Chunked SHA-256: the memory stays flat even for a 700 MB file. */
export async function sha256OfFile(file) {
    const hasher = await createSHA256();
    hasher.init();
    const reader = file.stream().getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
    }
    return hasher.digest('hex').toUpperCase();
}

/**
 * Read a file the user picked and ask for the read permission.
 *
 * The permission is asked for when the file is needed, because a browser
 * only grants it inside a gesture or right after one.
 */
export async function fileFromHandle(handle) {
    if (!handle) return null;
    try {
        const permission = await handle.queryPermission({ mode: 'read' });
        if (permission !== 'granted') {
            const asked = await handle.requestPermission({ mode: 'read' });
            if (asked !== 'granted') return null;
        }
        return await handle.getFile();
    } catch {
        return null;
    }
}

/**
 * Check a file against the hash it is expected to have.
 *
 * The result is remembered, so the same file is not hashed twice. A file
 * without an expected hash is accepted: the clinic may use any model.
 */
export async function verifySha256(file, expected) {
    if (!expected) return true;
    const metaKey = `sha256:${file.name}:${file.size}:${file.lastModified ?? 0}`;
    let cached = null;
    try {
        const db = await openDb();
        const transaction = db.transaction(STORE_META, 'readonly');
        const request = transaction.objectStore(STORE_META).get(metaKey);
        cached = await new Promise((resolve) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
        });
    } catch {
        cached = null;
    }
    if (cached === expected.toUpperCase()) return true;

    const actual = await sha256OfFile(file);
    const ok = actual === expected.toUpperCase();
    if (ok) {
        try {
            const db = await openDb();
            const transaction = db.transaction(STORE_META, 'readwrite');
            transaction.objectStore(STORE_META).put(actual, metaKey);
        } catch { /* the cache is a nicety, not a gate */ }
    }
    return ok;
}
