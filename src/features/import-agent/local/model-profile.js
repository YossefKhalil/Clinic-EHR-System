// Model profile: the local models the clinic picked.
//
// Two layouts:
//
//   'single'  one multimodal model (a GGUF with a vision tower). It reads
//             photos and extracts records.
//   'split'   a text model (GGUF) plus a vision model (ONNX). The vision
//             model turns photos into text; the text model extracts records.
//
// The files are picked with the file explorer and remembered as IndexedDB
// handles, so the clinic picks them once. Nothing here is tied to a
// particular model.

import { OCR_SUPPORT_FILES } from './manifest.js';

export const PROFILE_MODES = ['single', 'split'];

export function emptyProfile() {
    return {
        mode: 'single',
        // single mode
        multimodal: null, // { handle, name, kind, size, sha256 }
        // split mode
        text: null,       // { handle, name, kind, size, sha256 }
        vision: null,     // { handle, name, kind, size, sha256 }
        // the files a vision model needs beside the graph
        support: null,    // { name, files: { fileName: File } }
    };
}

export function profileComplete(profile) {
    if (!profile) return false;
    if (profile.mode === 'single') return Boolean(profile.multimodal);
    if (profile.mode === 'split') {
        return Boolean(profile.text) && Boolean(profile.vision) && supportFilesComplete(profile.support);
    }
    return false;
}

/** True when every file a vision model needs is present. */
export function supportFilesComplete(support) {
    if (!support || !support.files) return false;
    return OCR_SUPPORT_FILES.every((name) => Boolean(support.files[name]));
}

/** The support files that are missing, by name. */
export function missingSupportFiles(support) {
    const files = support?.files ?? {};
    return OCR_SUPPORT_FILES.filter((name) => !files[name]);
}

export function fileKind(name) {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.gguf')) return 'gguf';
    if (lower.endsWith('.onnx')) return 'onnx';
    return 'unknown';
}

// The profile and its handles live in IndexedDB.
const DB = 'clinic-local-profile';
const STORE = 'profile';

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveProfile(profile) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put(profile, 'current');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

export async function loadProfile() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).get('current');
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

export async function clearProfile() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).delete('current');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

/**
 * Pick one model file.
 *
 * Chromium can hand back a handle that stays valid across reloads. Other
 * browsers cannot, so the caller falls back to a file input and the clinic
 * picks the file again after a reload.
 */
export async function pickModelFile() {
    if (typeof window === 'undefined' || !window.showOpenFilePicker) return null;
    const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Model files', accept: { 'application/octet-stream': ['.gguf', '.onnx'] } }],
        multiple: false,
    });
    if (!handle) return null;
    const file = await handle.getFile();
    return { handle, name: file.name, kind: fileKind(file.name), size: file.size };
}

/**
 * Pick the folder with the tokenizer and config files a vision model needs.
 *
 * The browser does not expose full paths, so only the file names and their
 * contents are kept. The folder handle is not stored: the files themselves
 * are small (a few megabytes) and are stored so the model still loads after
 * a reload.
 */
export async function pickSupportFolder() {
    if (typeof window === 'undefined' || !window.showDirectoryPicker) return null;
    const directory = await window.showDirectoryPicker();
    const files = {};
    for await (const [name, entry] of directory.entries()) {
        if (entry.kind !== 'file') continue;
        files[name] = await entry.getFile();
    }
    return { name: directory.name, files };
}

/**
 * The same files, picked one by one, for a browser without a folder picker.
 */
export function supportFilesFromFileList(fileList) {
    const files = {};
    for (const file of Array.from(fileList || [])) {
        files[file.name] = file;
    }
    return { name: '', files };
}
