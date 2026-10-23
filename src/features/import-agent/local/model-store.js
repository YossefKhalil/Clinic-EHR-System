// The model store.
//
// The model files stay on the clinic's PC. What the browser needs from them
// is the bytes (to load the model) and a hash (to say which model produced a
// record). The file handle itself lives with the profile, in model-profile.js.
//
// Performance:
//  - The hash is read in pieces, so a 686 MB file never lands in memory as
//    one buffer (hash-wasm.js).
//  - A file that is replaced by one with the same name and the same size is
//    hashed again: the stamp in the cache includes the modification time.
//
// This module is deliberately free of the profile model: it only deals with
// pickers and handles, so both the settings card and the verification flow
// can use it without importing the profile store.

import { computeSHA256, resolveModelFile, SHA256_CHUNK_SIZE } from './hash-wasm.js';

/** The default model extensions the picker offers. */
const MODEL_EXTENSIONS = ['.gguf', '.onnx'];

function modelError(code, message, extra = {}) {
    const error = new Error(message || code);
    error.code = code;
    Object.assign(error, extra);
    return error;
}

/** True when this browser can hand back a persistent file handle. */
export function supportsFileHandles() {
    return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

/** True when this browser can hand back a folder handle. */
export function supportsDirectoryHandles() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function normalizeExtension(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return null;
    if (raw.startsWith('.')) return raw;
    return `.${raw}`;
}

/** Build the `types` argument the picker expects. */
function pickerTypes(accept) {
    if (accept && typeof accept === 'object' && !Array.isArray(accept)) return [accept];
    const requested = Array.isArray(accept) ? accept : (accept ? [accept] : MODEL_EXTENSIONS);
    const extensions = requested.map(normalizeExtension).filter(Boolean);
    return [{
        description: 'Model files',
        accept: { 'application/octet-stream': extensions.length ? extensions : MODEL_EXTENSIONS },
    }];
}

/**
 * Pick one model file.
 *
 * @param {string|string[]} [accept] '.gguf', '.onnx', or a list; both when
 *        omitted
 * @returns {Promise<FileSystemFileHandle|null>} null when the picker is not
 *          available or the user cancelled
 */
export async function pickModelFile(accept = null) {
    if (!supportsFileHandles()) return null;
    try {
        const [handle] = await window.showOpenFilePicker({
            types: pickerTypes(accept),
            multiple: false,
            excludeAcceptAllOption: false,
        });
        return handle ?? null;
    } catch (error) {
        // A cancelled picker is not an error the clinic needs to see.
        if (error?.name === 'AbortError') return null;
        throw error;
    }
}

/**
 * Pick the folder with the tokenizer and config files a vision model needs.
 *
 * @returns {Promise<FileSystemDirectoryHandle|null>} null when the picker is
 *          not available or the user cancelled
 */
export async function pickSupportDirectory() {
    if (!supportsDirectoryHandles()) return null;
    try {
        return await window.showDirectoryPicker({ mode: 'read' });
    } catch (error) {
        if (error?.name === 'AbortError') return null;
        throw error;
    }
}

/** Read every file of a picked directory into a `{ name: File }` map. */
export async function readDirectoryFiles(directory) {
    const files = {};
    if (!directory || typeof directory.entries !== 'function') return files;
    for await (const [name, entry] of directory.entries()) {
        if (entry.kind !== 'file') continue;
        files[name] = await entry.getFile();
    }
    return files;
}

/**
 * Check that a handle still points at something this page may read.
 *
 * After a reload the browser restores the handle but not the permission. The
 * permission is asked for here, which means this must be called from a user
 * gesture (a click on "Verify" or on the model card). A false result means
 * the file was moved, deleted, or the user declined; the settings card then
 * offers "Repair models" and re-opens the picker.
 *
 * @param {FileSystemFileHandle|FileSystemDirectoryHandle} handle
 * @param {{ request?: boolean, mode?: 'read'|'readwrite' }} [options]
 * @returns {Promise<boolean>}
 */
export async function verifyHandle(handle, options = {}) {
    if (!handle) return false;
    if (releasedHandles.has(handle)) return false;
    const mode = options.mode === 'readwrite' ? 'readwrite' : 'read';
    try {
        if (typeof handle.queryPermission !== 'function') {
            // A File-like object has no permission API; if it still has bytes
            // it is usable. This keeps the fake handles in tests simple.
            return typeof handle.getFile === 'function' || typeof handle.slice === 'function';
        }
        const permission = await handle.queryPermission({ mode });
        if (permission === 'granted') return true;
        if (options.request === false) return false;
        if (typeof handle.requestPermission !== 'function') return false;
        return (await handle.requestPermission({ mode })) === 'granted';
    } catch {
        return false;
    }
}

/**
 * Read a file in fixed-size slices.
 *
 * Used for hashing and for any streaming reader that should not hold the
 * whole model in memory. The callback may return `false` to stop early.
 *
 * @param {FileSystemFileHandle|File|Blob} handle
 * @param {(chunk: Uint8Array, offset: number, total: number) => any} [callback]
 * @param {{ chunkSize?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<number>} the number of bytes read
 */
export async function readFileChunked(handle, callback = null, options = {}) {
    const file = await resolveModelFile(handle);
    const total = Number(file.size) || 0;
    const chunkSize = Math.max(1, Number(options.chunkSize) || SHA256_CHUNK_SIZE);
    let offset = 0;

    while (offset < total) {
        if (options.signal?.aborted) throw modelError('CANCELLED', 'the read was cancelled');
        const end = Math.min(total, offset + chunkSize);
        let bytes;
        try {
            const slice = file.slice(offset, end);
            const buffer = await slice.arrayBuffer();
            bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        } catch (error) {
            throw modelError('MODEL_FILE_UNREADABLE', String(error?.message ?? 'the model file could not be read'));
        }
        if (typeof callback === 'function') {
            const keepGoing = await callback(bytes, offset, total);
            if (keepGoing === false) {
                offset = end;
                break;
            }
        }
        offset = end;
    }

    return offset;
}

// A released handle is one the page has finished with. There is no browser
// API to revoke a permission or close a handle; dropping the reference is
// what "release" means here. The weak set also makes a stale handle fail
// verification, so the settings card offers the repair picker instead of
// loading a file the page has already let go of.
const releasedHandles = new WeakSet();

/**
 * Finish with a handle.
 *
 * The browser keeps the permission and the file; this only tells the app that
 * the handle should not be reused. It never deletes or modifies the model.
 */
export function releaseHandle(handle) {
    if (handle && typeof handle === 'object') releasedHandles.add(handle);
}

/** True when `releaseHandle` has been called for this handle. */
export function isHandleReleased(handle) {
    return Boolean(handle) && releasedHandles.has(handle);
}

/**
 * Read a file the user picked and ask for the read permission.
 *
 * The permission is asked for when the file is needed, because a browser
 * only grants it inside a gesture or right after one.
 */
export async function fileFromHandle(handle) {
    if (!handle) return null;
    if (releasedHandles.has(handle)) return null;
    // A `File` (or a test stand-in with bytes) needs no permission dance.
    if (typeof handle.getFile !== 'function' && typeof handle.slice === 'function') return handle;
    try {
        const granted = await verifyHandle(handle);
        if (!granted) return null;
        return await handle.getFile();
    } catch {
        return null;
    }
}

/** Chunked SHA-256: the memory stays flat even for a 700 MB file. */
export async function sha256OfFile(file) {
    return computeSHA256(file);
}

/**
 * Check a file against the hash it is expected to have.
 *
 * The result is remembered, so the same file is not hashed twice. A file
 * without an expected hash is accepted: the clinic may use any model.
 */
export async function verifySha256(file, expected) {
    if (!expected) return true;
    const actual = await computeSHA256(file);
    return actual === String(expected).toUpperCase();
}

export { computeSHA256 };
