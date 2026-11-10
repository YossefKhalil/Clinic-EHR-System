// Browser-side model storage. Files live in OPFS, never in a remote bucket,
// and every byte is checked against the pinned manifest before it is loaded.

import { createSHA256 } from 'hash-wasm';
import { MODEL_MANIFEST, MODEL_URLS } from './manifest.js';

const DIR_NAME = 'import-model';
const CHUNK = 8 * 1024 * 1024;

export class ModelStoreError extends Error {
    constructor(code, detail = '') {
        super(detail || code);
        this.name = 'ModelStoreError';
        this.code = code;
        this.detail = detail;
    }
}

async function root() {
    if (!navigator.storage?.getDirectory) {
        throw new ModelStoreError('STORAGE_UNSUPPORTED');
    }
    return navigator.storage.getDirectory();
}

async function dir(create = false) {
    const base = await root();
    return base.getDirectoryHandle(DIR_NAME, { create });
}

export async function requestPersistence() {
    try {
        if (navigator.storage?.persist) return await navigator.storage.persist();
    } catch {
        // best effort only
    }
    return false;
}

export async function storageEstimate() {
    try {
        return await navigator.storage?.estimate?.() ?? null;
    } catch {
        return null;
    }
}

export async function readStoredFile(kind) {
    try {
        const handle = await (await dir(false)).getFileHandle(MODEL_MANIFEST.files[kind].name);
        return await handle.getFile();
    } catch {
        return null;
    }
}

export async function storedModel() {
    const [model, projector] = await Promise.all([
        readStoredFile('model'),
        readStoredFile('projector'),
    ]);
    return { model, projector, ready: Boolean(model && projector) };
}

export async function removeStoredModel() {
    try {
        const base = await root();
        await base.removeEntry(DIR_NAME, { recursive: true });
    } catch (err) {
        if (err?.name !== 'NotFoundError') throw new ModelStoreError('STORAGE_FAILED', String(err));
    }
}

async function sha256OfBlob(blob, onProgress) {
    const hasher = await createSHA256();
    hasher.init();
    let offset = 0;
    while (offset < blob.size) {
        const slice = blob.slice(offset, Math.min(offset + CHUNK, blob.size));
        hasher.update(new Uint8Array(await slice.arrayBuffer()));
        offset += CHUNK;
        onProgress?.(Math.min(offset, blob.size), blob.size);
    }
    return hasher.digest('hex');
}

export async function verifyFile(file, expected, onProgress) {
    if (!file) throw new ModelStoreError('MODEL_FILE_MISSING');
    if (file.size !== expected.bytes) {
        throw new ModelStoreError('MODEL_SIZE_MISMATCH', `${file.size} != ${expected.bytes}`);
    }
    const digest = await sha256OfBlob(file, onProgress);
    if (digest.toLowerCase() !== expected.sha256.toLowerCase()) {
        throw new ModelStoreError('MODEL_HASH_MISMATCH', digest);
    }
    return digest;
}

async function writeResponse(kind, response, expected, onProgress, signal) {
    if (!response.ok || !response.body) {
        throw new ModelStoreError('DOWNLOAD_FAILED', `HTTP ${response.status}`);
    }
    const handle = await (await dir(true)).getFileHandle(expected.name, { create: true });
    const writable = await handle.createWritable();
    const hasher = await createSHA256();
    hasher.init();
    const reader = response.body.getReader();
    let loaded = 0;
    try {
        for (;;) {
            if (signal?.aborted) throw new ModelStoreError('ABORTED');
            const { done, value } = await reader.read();
            if (done) break;
            loaded += value.byteLength;
            if (loaded > expected.bytes) {
                throw new ModelStoreError('MODEL_SIZE_MISMATCH', 'larger than the pinned file');
            }
            hasher.update(value);
            await writable.write(value);
            onProgress?.(loaded, expected.bytes);
        }
        await writable.close();
    } catch (err) {
        try {
            await writable.abort();
        } catch {
            // ignore
        }
        try {
            await (await dir(true)).removeEntry(expected.name);
        } catch {
            // ignore
        }
        throw err;
    }
    const digest = hasher.digest('hex');
    if (loaded !== expected.bytes || digest.toLowerCase() !== expected.sha256.toLowerCase()) {
        try {
            await (await dir(true)).removeEntry(expected.name);
        } catch {
            // ignore
        }
        throw new ModelStoreError('MODEL_HASH_MISMATCH', digest);
    }
    return handle.getFile();
}

export async function downloadModel({ onProgress, signal } = {}) {
    await requestPersistence();
    const total = MODEL_MANIFEST.files.model.bytes + MODEL_MANIFEST.files.projector.bytes;
    let base = 0;
    const report = (kind) => (loaded, size) => {
        onProgress?.({
            phase: kind,
            fileLoaded: loaded,
            fileTotal: size,
            loaded: base + loaded,
            total,
            percent: Math.min(100, ((base + loaded) / total) * 100),
        });
    };

    // Download the projector first: it is small, so a failure is quick and the
    // large file is not left half-finished for a bad URL.
    const projectorResponse = await fetch(MODEL_URLS.projector, { signal });
    await writeResponse('projector', projectorResponse, MODEL_MANIFEST.files.projector, report('projector'), signal);
    base = MODEL_MANIFEST.files.projector.bytes;

    const modelResponse = await fetch(MODEL_URLS.model, { signal });
    await writeResponse('model', modelResponse, MODEL_MANIFEST.files.model, report('model'), signal);

    const files = await storedModel();
    if (!files.ready) throw new ModelStoreError('STORAGE_FAILED', 'files not readable after download');
    return files;
}

export async function verifyLocalFiles(modelFile, projectorFile, onProgress) {
    if (!modelFile || !projectorFile) throw new ModelStoreError('MODEL_FILE_MISSING');
    onProgress?.({ phase: 'verify-model', percent: 0 });
    await verifyFile(modelFile, MODEL_MANIFEST.files.model, (loaded, total) => {
        onProgress?.({ phase: 'verify-model', percent: (loaded / total) * 50 });
    });
    onProgress?.({ phase: 'verify-projector', percent: 50 });
    await verifyFile(projectorFile, MODEL_MANIFEST.files.projector, (loaded, total) => {
        onProgress?.({ phase: 'verify-projector', percent: 50 + (loaded / total) * 50 });
    });
    onProgress?.({ phase: 'verified', percent: 100 });
    return { model: modelFile, projector: projectorFile, ready: true, source: 'disk' };
}