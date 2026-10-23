// Chunked SHA-256 for model files.
//
// A local model is large: the text model is ~686 MB and the vision model is
// ~450 MB. Reading either into one buffer just to hash it would take the tab
// out on a clinic PC, so the file is read in fixed-size slices and fed to
// hash-wasm one slice at a time. The memory high-water mark is one slice,
// whatever the size of the file.
//
// The digest is cached in IndexedDB under the file's identity (name, size and
// modification time). A model is hashed once, not on every visit to the
// settings panel. The cache is keyed by what the browser exposes about a
// `File`, because a `FileSystemFileHandle` itself is not a usable key.

import { createSHA256 } from 'hash-wasm';

/** The slice size. 64 MB keeps the memory flat without thousands of reads. */
export const SHA256_CHUNK_SIZE = 64 * 1024 * 1024;

const DB_NAME = 'clinic-local-models';
const DB_VERSION = 1;
const STORE_META = 'meta';
const CACHE_PREFIX = 'sha256:';

function modelError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
}

function indexedDbAvailable() {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb() {
    return new Promise((resolve, reject) => {
        if (!indexedDbAvailable()) {
            reject(modelError('INDEXEDDB_UNAVAILABLE', 'IndexedDB is not available in this browser'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('INDEXEDDB_OPEN_FAILED'));
    });
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('INDEXEDDB_REQUEST_FAILED'));
    });
}

async function readCached(key) {
    if (!indexedDbAvailable()) return null;
    try {
        const db = await openDb();
        try {
            const transaction = db.transaction(STORE_META, 'readonly');
            const value = await requestResult(transaction.objectStore(STORE_META).get(key));
            return typeof value === 'string' && value ? value.toUpperCase() : null;
        } finally {
            db.close?.();
        }
    } catch {
        // The cache is a nicety, not a gate: a private window or a full quota
        // must not stop a clinic from verifying its model.
        return null;
    }
}

async function writeCached(key, digest) {
    if (!indexedDbAvailable()) return;
    try {
        const db = await openDb();
        try {
            await new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_META, 'readwrite');
                transaction.objectStore(STORE_META).put(digest, key);
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error || new Error('INDEXEDDB_WRITE_FAILED'));
                transaction.onabort = () => reject(transaction.error || new Error('INDEXEDDB_WRITE_ABORTED'));
            });
        } finally {
            db.close?.();
        }
    } catch {
        // Same as above: a failed cache write never fails the hash.
    }
}

/** The cache key for a file: name + size + modification time. */
export function hashCacheKey(file) {
    const name = String(file?.name ?? '');
    const size = Number(file?.size ?? 0);
    const modified = Number(file?.lastModified ?? 0);
    return `${CACHE_PREFIX}${name}:${size}:${modified}`;
}

/**
 * Resolve a handle or a file-like object to something with `size` and
 * `slice()`. A handle is asked for its file; the caller is responsible for
 * having a permission-granting gesture when the browser requires one.
 */
export async function resolveModelFile(input) {
    if (!input) throw modelError('MODEL_FILE_MISSING', 'there is no model file to read');
    if (typeof input.getFile === 'function') {
        try {
            return await input.getFile();
        } catch (error) {
            throw modelError('MODEL_FILE_UNAVAILABLE', String(error?.message ?? 'the model file is not reachable'));
        }
    }
    if (typeof input.slice === 'function') return input;
    if (typeof input.arrayBuffer === 'function') return input;
    throw modelError('MODEL_FILE_UNREADABLE', 'the model file cannot be read');
}

async function readSlice(file, start, end) {
    const slice = file.slice(start, end);
    if (slice && typeof slice.arrayBuffer === 'function') return slice.arrayBuffer();
    if (slice instanceof Uint8Array || slice instanceof ArrayBuffer) return slice;
    if (slice && typeof slice.then === 'function') return slice;
    throw modelError('MODEL_FILE_UNREADABLE', 'the model file returned no bytes');
}

function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(value);
}

/**
 * Hash one file without the cache. Exposed for tests and for callers that
 * know the file is new.
 *
 * @param {File|Blob|{size: number, slice: Function}} file
 * @param {{ chunkSize?: number, onProgress?: (read: number, total: number) => void }} [options]
 * @returns {Promise<string>} 64 uppercase hex characters
 */
export async function hashFile(file, options = {}) {
    const source = await resolveModelFile(file);
    const total = Number(source.size) || 0;
    const chunkSize = Math.max(1, Number(options.chunkSize) || SHA256_CHUNK_SIZE);
    const hasher = await createSHA256();
    hasher.init();

    let read = 0;
    for (let offset = 0; offset < total; offset += chunkSize) {
        const end = Math.min(total, offset + chunkSize);
        let bytes;
        try {
            bytes = asBytes(await readSlice(source, offset, end));
        } catch (error) {
            if (error?.code) throw error;
            throw modelError('MODEL_FILE_UNREADABLE', String(error?.message ?? 'the model file could not be read'));
        }
        hasher.update(bytes);
        read = end;
        options.onProgress?.(read, total);
    }

    if (total === 0 && typeof source.arrayBuffer === 'function') {
        // A Blob with an unknown size is still hashable in one read.
        const bytes = asBytes(await source.arrayBuffer());
        if (bytes.byteLength > 0) hasher.update(bytes);
    }

    return hasher.digest('hex').toUpperCase();
}

/**
 * The SHA-256 of a model file, cached by file identity.
 *
 * @param {FileSystemFileHandle|File|Blob} input a handle, or the file itself
 * @param {{ cache?: boolean, chunkSize?: number, onProgress?: Function }} [options]
 * @returns {Promise<string>} 64 uppercase hex characters
 */
export async function computeSHA256(input, options = {}) {
    const file = await resolveModelFile(input);
    const key = hashCacheKey(file);
    if (options.cache !== false) {
        const cached = await readCached(key);
        if (cached) {
            options.onProgress?.(Number(file.size) || 0, Number(file.size) || 0);
            return cached;
        }
    }
    const digest = await hashFile(file, options);
    if (options.cache !== false) await writeCached(key, digest);
    return digest;
}

/** Drop the cached digest for one file (the next verify re-reads it). */
export async function clearHashCache(input) {
    if (!indexedDbAvailable()) return false;
    try {
        const file = await resolveModelFile(input);
        const key = hashCacheKey(file);
        const db = await openDb();
        try {
            await new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_META, 'readwrite');
                transaction.objectStore(STORE_META).delete(key);
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error || new Error('INDEXEDDB_DELETE_FAILED'));
                transaction.onabort = () => reject(transaction.error || new Error('INDEXEDDB_DELETE_ABORTED'));
            });
            return true;
        } finally {
            db.close?.();
        }
    } catch {
        return false;
    }
}
