// Model profile: the local models the clinic picked.
//
// Two layouts:
//
//   'single'  one multimodal model (a GGUF with a vision tower) plus an
//             optional `mmproj.gguf` projector. It reads photos and extracts
//             records.
//   'split'   a text model (GGUF) plus a vision model (ONNX). The vision
//             model turns photos into text; the text model extracts records.
//
// The files are picked with the file explorer and remembered as IndexedDB
// handles, so the clinic picks them once. Nothing here is tied to a
// particular model.
//
// Storage:
//
//   'profile'   one composite profile (the shape the import engine and the
//               settings card have always used), key 'current'.
//   'profiles'  one record per model slot ('text', 'vision', 'support',
//               'mmproj', and 'multimodal' for the single layout), with its
//               own verification status. The slot records are what the
//               verification state machine reads and writes.
//   'files'     the file bytes, for browsers without the File System Access
//               API (Firefox, Safari). A File handle cannot be restored
//               there, so the File itself is kept and re-hashed on first use.
//               The store is the difference between "pick the model again
//               after every reload" and "pick it once".
//
// The composite and the slot records are kept in step by saveProfile(), so a
// caller that still saves the whole profile and a caller that saves one slot
// see the same handles. The status machine is per slot:
//
//   not_configured -> not_verified -> ready
//                                  -> error(<code>)
//
// A page reload restores the handles but not the browser's permission for
// them. The settings card shows "Not verified" until the clinic clicks and
// the browser grants the permission again (see model-store.js).

import { OCR_SUPPORT_FILES } from './manifest.js';
import { probeModelFile } from './adapters.js';
import { computeSHA256 } from './hash-wasm.js';
import {
    fileFromHandle,
    pickModelFile as pickModelFileHandle,
    pickSupportDirectory,
    readDirectoryFiles,
    verifyHandle,
} from './model-store.js';

export const PROFILE_MODES = ['single', 'split'];

/** The profiles the verification state machine knows. */
export const PROFILE_STATUSES = Object.freeze({
    NOT_CONFIGURED: 'not_configured',
    NOT_VERIFIED: 'not_verified',
    READY: 'ready',
    ERROR: 'error',
});

/** Alias used by the settings card. */
export const VERIFICATION_STATUSES = PROFILE_STATUSES;

/** The per-slot record ids. 'multimodal' is the single layout's text slot. */
export const PROFILE_IDS = Object.freeze(['text', 'vision', 'support', 'mmproj']);
export const PROFILE_SLOTS = Object.freeze(['multimodal', 'mmproj', 'text', 'vision', 'support']);

const STATUS_VALUES = new Set(Object.values(PROFILE_STATUSES));

/**
 * The legal transitions. Re-verifying goes back through `not_verified`;
 * repairing clears the slot back to `not_configured`.
 */
export const STATUS_TRANSITIONS = Object.freeze({
    [PROFILE_STATUSES.NOT_CONFIGURED]: [PROFILE_STATUSES.NOT_VERIFIED],
    [PROFILE_STATUSES.NOT_VERIFIED]: [
        PROFILE_STATUSES.READY,
        PROFILE_STATUSES.ERROR,
        PROFILE_STATUSES.NOT_CONFIGURED,
    ],
    [PROFILE_STATUSES.READY]: [
        PROFILE_STATUSES.NOT_VERIFIED,
        PROFILE_STATUSES.ERROR,
        PROFILE_STATUSES.NOT_CONFIGURED,
    ],
    [PROFILE_STATUSES.ERROR]: [
        PROFILE_STATUSES.NOT_VERIFIED,
        PROFILE_STATUSES.NOT_CONFIGURED,
    ],
});

const REPAIR_CODES = new Set([
    'MODEL_FILE_UNAVAILABLE',
    'MODEL_FILE_UNREADABLE',
    'MODEL_FILE_MISSING',
    'HANDLE_INVALID',
    'PERMISSION_DENIED',
    'SUPPORT_FILES_MISSING',
]);

function profileError(code, message, extra = {}) {
    const error = new Error(message || code);
    error.code = code;
    Object.assign(error, extra);
    return error;
}

/** Map the old UI words ('ok', 'warn', ...) onto the stored values. */
export function normalizeStatus(status) {
    if (STATUS_VALUES.has(status)) return status;
    if (status === 'ok') return PROFILE_STATUSES.READY;
    if (status === 'warn') return PROFILE_STATUSES.NOT_VERIFIED;
    if (status === 'none') return PROFILE_STATUSES.NOT_CONFIGURED;
    return null;
}

/** True when the state machine allows `from -> to`. */
export function canTransition(from, to) {
    const source = normalizeStatus(from) ?? PROFILE_STATUSES.NOT_CONFIGURED;
    const target = normalizeStatus(to);
    if (!target) return false;
    if (source === target) return true;
    return (STATUS_TRANSITIONS[source] ?? []).includes(target);
}

export function emptyProfile() {
    return {
        mode: 'single',
        // single mode
        multimodal: null, // { handle, file, name, kind, size, sha256, status }
        mmproj: null,     // the optional vision projector for 'multimodal'
        // split mode
        text: null,       // { handle, file, name, kind, size, sha256, status }
        vision: null,     // { handle, file, name, kind, size, sha256, status }
        // the files a vision model needs beside the graph
        support: null,    // { name, handle, files: { fileName: File }, status }
    };
}

export function profileComplete(profile) {
    if (!profile) return false;
    if (profile.mode === 'single') return Boolean(profile.multimodal);
    if (profile.mode === 'split') {
        // Text model is required for split mode. Vision and support files are
        // optional - they're only needed when the import contains images.
        return Boolean(profile.text);
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

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

const DB = 'clinic-local-profile';
const DB_VERSION = 3;
const STORE = 'profile';       // the composite profile, key 'current'
const PROFILES = 'profiles';   // one record per slot, key 'id'
const FILES = 'files';         // the File bytes for browsers without handles, key 'id'

function storageAvailable() {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb() {
    return new Promise((resolve, reject) => {
        if (!storageAvailable()) {
            reject(profileError('INDEXEDDB_UNAVAILABLE', 'IndexedDB is not available in this browser'));
            return;
        }
        const request = indexedDB.open(DB, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            if (!db.objectStoreNames.contains(PROFILES)) db.createObjectStore(PROFILES, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || profileError('INDEXEDDB_OPEN_FAILED', 'the profile store did not open'));
    });
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || profileError('INDEXEDDB_REQUEST_FAILED', 'the profile store request failed'));
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || profileError('INDEXEDDB_WRITE_FAILED', 'the profile store write failed'));
        transaction.onabort = () => reject(transaction.error || profileError('INDEXEDDB_WRITE_ABORTED', 'the profile store write was aborted'));
    });
}

async function readValue(storeName, key) {
    const db = await openDb();
    try {
        const transaction = db.transaction(storeName, 'readonly');
        return await requestResult(transaction.objectStore(storeName).get(key));
    } finally {
        db.close?.();
    }
}

async function readAllValues(storeName) {
    const db = await openDb();
    try {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        if (typeof store.getAll === 'function') return await requestResult(store.getAll());
        // Small stores, and old browsers: a cursor is enough.
        return await new Promise((resolve, reject) => {
            const values = [];
            const request = store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(values);
                    return;
                }
                values.push(cursor.value);
                cursor.continue();
            };
            request.onerror = () => reject(request.error || profileError('INDEXEDDB_REQUEST_FAILED', 'the profile store read failed'));
        });
    } finally {
        db.close?.();
    }
}

/**
 * A structured-clone-safe copy of a value.
 *
 * Alpine.js wraps the settings state in reactive Proxies, and a Proxy cannot be
 * written to IndexedDB (`DataCloneError: could not be cloned`). Plain objects
 * and arrays are therefore copied by value before the write. Everything else -
 * File, Blob, FileSystemHandle, Date, typed arrays - keeps its identity,
 * because it is cloneable exactly as it is.
 */
export function toStorable(value) {
    if (Array.isArray(value)) return value.map(toStorable);
    if (value && typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        if (proto === Object.prototype || proto === null) {
            const copy = {};
            for (const [key, entry] of Object.entries(value)) copy[key] = toStorable(entry);
            return copy;
        }
    }
    return value;
}

async function writeValue(storeName, value, key = undefined) {
    const db = await openDb();
    try {
        const transaction = db.transaction(storeName, 'readwrite');
        const done = transactionDone(transaction);
        const storable = toStorable(value);
        const request = key === undefined
            ? transaction.objectStore(storeName).put(storable)
            : transaction.objectStore(storeName).put(storable, key);
        request.onerror = () => { /* the transaction error carries the reason */ };
        await done;
    } finally {
        db.close?.();
    }
}

async function deleteValue(storeName, key) {
    const db = await openDb();
    try {
        const transaction = db.transaction(storeName, 'readwrite');
        const done = transactionDone(transaction);
        transaction.objectStore(storeName).delete(key);
        await done;
    } finally {
        db.close?.();
    }
}

async function clearValues(storeName) {
    const db = await openDb();
    try {
        const transaction = db.transaction(storeName, 'readwrite');
        const done = transactionDone(transaction);
        transaction.objectStore(storeName).clear();
        await done;
    } finally {
        db.close?.();
    }
}

// ---------------------------------------------------------------------------
// File blobs
// ---------------------------------------------------------------------------

function isBlobLike(value) {
    return Boolean(value) && typeof value === 'object'
        && typeof value.size === 'number'
        && typeof value.slice === 'function';
}

/**
 * Keep the bytes of one model file.
 *
 * Chromium stores a FileSystemFileHandle instead; this is the fallback for
 * Firefox and Safari, where a picked File is the only thing that survives a
 * reload. The record keeps the name, the size and the modification time
 * beside the bytes, because a Blob alone has none of them.
 */
export async function saveFileBlob(profileId, file) {
    if (!isBlobLike(file) || !storageAvailable()) return false;
    await writeValue(FILES, {
        name: String(file.name ?? ''),
        type: String(file.type ?? ''),
        lastModified: Number(file.lastModified ?? 0) || 0,
        size: Number(file.size ?? 0) || 0,
        blob: file,
    }, profileId);
    return true;
}

/** The stored file for a slot, or null when there is none (or no storage). */
export async function loadFileBlob(profileId) {
    if (!storageAvailable()) return null;
    try {
        const record = await readValue(FILES, profileId);
        if (!record?.blob) return null;
        const blob = record.blob;
        if (typeof File !== 'undefined' && blob instanceof File) return blob;
        if (typeof File !== 'undefined') {
            return new File([blob], record.name || `${profileId}.bin`, {
                type: record.type || '',
                lastModified: record.lastModified || Date.now(),
            });
        }
        return blob;
    } catch (error) {
        if (error?.code === 'INDEXEDDB_UNAVAILABLE') return null;
        throw error;
    }
}

/** Drop the stored bytes of one slot. */
export async function deleteFileBlob(profileId) {
    if (!storageAvailable()) return;
    try {
        await deleteValue(FILES, profileId);
    } catch (error) {
        if (error?.code !== 'INDEXEDDB_UNAVAILABLE') throw error;
    }
}

/**
 * Attach the stored bytes to a slot record that has no handle.
 *
 * The slot record itself never carries the bytes: they would be cloned into
 * the composite profile as well, and a 700 MB model would be stored twice.
 */
async function hydrateEntry(profileId, entry) {
    if (!entry || entry.handle || entry.file) return entry;
    const file = await loadFileBlob(profileId);
    if (!file) return entry;
    return {
        ...entry,
        file,
        name: entry.name || file.name || '',
        size: entry.size || file.size || 0,
    };
}

// ---------------------------------------------------------------------------
// Record shaping
// ---------------------------------------------------------------------------

function defaultStatus(entry) {
    return entry.handle || entry.name
        ? PROFILE_STATUSES.NOT_VERIFIED
        : PROFILE_STATUSES.NOT_CONFIGURED;
}

/** A complete slot record, whatever the caller passed. */
export function normalizeProfileEntry(profileId, data = {}) {
    if (!PROFILE_SLOTS.includes(profileId)) {
        throw profileError('INVALID_PROFILE_ID', `unknown model profile: ${profileId}`, { profileId });
    }
    const entry = { ...data, id: profileId };
    entry.name = String(entry.name ?? '');
    entry.size = Number.isFinite(Number(entry.size)) ? Number(entry.size) : 0;
    entry.sha256 = String(entry.sha256 ?? '').toUpperCase();
    entry.handle = entry.handle ?? null;
    entry.mode = entry.mode === 'split' ? 'split' : 'single';
    entry.config = entry.config && typeof entry.config === 'object' ? entry.config : {};
    entry.status = normalizeStatus(entry.status) ?? defaultStatus(entry);

    if (entry.status === PROFILE_STATUSES.ERROR) {
        entry.errorCode = String(entry.errorCode ?? 'VERIFY_FAILED');
    } else {
        delete entry.errorCode;
    }
    if (entry.status === PROFILE_STATUSES.READY) {
        if (!Number.isFinite(Number(entry.verifiedAt))) entry.verifiedAt = Date.now();
        else entry.verifiedAt = Number(entry.verifiedAt);
    } else {
        delete entry.verifiedAt;
    }
    return entry;
}

function slotFromComposite(profile, profileId) {
    if (!profile || !profile[profileId]) return null;
    return normalizeProfileEntry(profileId, {
        ...profile[profileId],
        mode: profile.mode === 'split' ? 'split' : 'single',
        config: profile[profileId].config ?? profile.config ?? {},
    });
}

function compositeFromRecords(records) {
    if (!records.length) return null;
    const profile = emptyProfile();
    for (const record of records) {
        if (!PROFILE_SLOTS.includes(record.id)) continue;
        profile[record.id] = record;
    }
    const ids = new Set(records.map((record) => record.id));
    const declared = records.find((record) => record.mode === 'split');
    profile.mode = declared || (ids.has('text') && ids.has('vision')) ? 'split' : 'single';
    if (profile.mode === 'single' && !profile.multimodal && profile.text) {
        // A slot API caller may use 'text' for the only model. Keep the
        // composite readable by the import engine in that case.
        profile.multimodal = profile.text;
    }
    return profile;
}

async function readComposite() {
    if (!storageAvailable()) return null;
    try {
        return (await readValue(STORE, 'current')) || null;
    } catch (error) {
        if (error?.code === 'INDEXEDDB_UNAVAILABLE') return null;
        throw error;
    }
}

async function readSlot(profileId) {
    if (!storageAvailable()) return null;
    try {
        return (await readValue(PROFILES, profileId)) || null;
    } catch (error) {
        if (error?.code === 'INDEXEDDB_UNAVAILABLE') return null;
        throw error;
    }
}

async function readSlots() {
    if (!storageAvailable()) return [];
    try {
        return (await readAllValues(PROFILES)) || [];
    } catch (error) {
        if (error?.code === 'INDEXEDDB_UNAVAILABLE') return [];
        throw error;
    }
}

async function writeSlot(profileId, data, options = {}) {
    const existing = await readSlot(profileId);
    let incoming = data ?? {};
    if (options.preserveHandle !== false) incoming = carryStoredHandle(incoming, existing);
    const merged = existing ? { ...existing, ...incoming } : incoming;
    const entry = normalizeProfileEntry(profileId, merged);
    // The bytes go to the file store, never into the slot record: a record
    // is cloned into the composite profile too, so a File here would store a
    // 700 MB model twice.
    if (entry.file) await saveFileBlob(profileId, entry.file);
    if (entry.handle) await deleteFileBlob(profileId);
    const { file: _file, ...stored } = entry;
    await writeValue(PROFILES, stored);
    return entry;
}

/**
 * Keep a stored handle when the new record still names the same file.
 *
 * A settings save rebuilds the draft from the server, and the server never
 * holds handles. Without this, a save that changes only a runtime value would
 * write `handle: null` over a handle the clinic already granted, and the next
 * import would fail with MODEL_FILE_UNAVAILABLE. A different name or size is
 * a different file, so the old handle is not carried across.
 */
function carryStoredHandle(incoming, existing) {
    if (!incoming || !existing) return incoming;
    if (incoming.handle) return incoming;
    if (!existing.handle) return incoming;
    const incomingName = String(incoming.name ?? '');
    const existingName = String(existing.name ?? '');
    if (incomingName && existingName && incomingName !== existingName) return incoming;
    const incomingSize = Number(incoming.size ?? 0);
    const existingSize = Number(existing.size ?? 0);
    if (incomingSize && existingSize && incomingSize !== existingSize) return incoming;
    const carried = { ...incoming, handle: existing.handle };
    // The support folder's small files are kept too when the draft was
    // rebuilt from the server and therefore carries none.
    if (existing.files && (!carried.files || Object.keys(carried.files).length === 0)) {
        carried.files = existing.files;
    }
    return carried;
}

async function patchComposite(profileId, entry) {
    if (!storageAvailable()) return;
    const profile = await readComposite();
    if (!profile) return;
    if (!entry) {
        profile[profileId] = null;
    } else {
        // The composite is a small record by design. The bytes live in the
        // file store and are attached again on load.
        const { file: _file, ...stored } = entry;
        profile[profileId] = stored;
    }
    await writeValue(STORE, profile, 'current');
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Persist a profile.
 *
 * Two call shapes are supported:
 *
 *   saveProfile(profile)              the whole composite profile (legacy)
 *   saveProfile(profileId, data)      one slot record (text/vision/support)
 *
 * The whole-profile shape is what the settings card has always saved; it also
 * writes the slot records so the verification state machine and
 * `getAllProfiles()` see the same data.
 */
export async function saveProfile(profileOrId, data) {
    if (typeof profileOrId === 'string') {
        const entry = await writeSlot(profileOrId, data ?? {});
        await patchComposite(profileOrId, entry);
        return entry;
    }

    const profile = profileOrId;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        throw profileError('INVALID_PROFILE', 'saveProfile expects a profile object or a profile id');
    }

    // Carry a stored handle forward before the composite is written, not only
    // in the per-slot records: the runner reads the composite profile.
    const storedComposite = await readComposite();
    const composite = { ...profile };
    for (const profileId of PROFILE_SLOTS) {
        const slot = composite[profileId];
        if (!slot) {
            composite[profileId] = null;
            if (storageAvailable()) {
                await deleteValue(PROFILES, profileId);
                await deleteFileBlob(profileId);
            }
            continue;
        }
        const existing = (await readSlot(profileId)) ?? slotFromComposite(storedComposite, profileId);
        const carried = carryStoredHandle(slot, existing);
        composite[profileId] = carried;
        // The bytes live in the file store; the composite and the slot
        // records keep only the small metadata.
        if (carried.file) await saveFileBlob(profileId, carried.file);
        if (carried.handle) await deleteFileBlob(profileId);
        const merged = existing ? { ...existing, ...carried } : carried;
        const entry = normalizeProfileEntry(profileId, {
            ...merged,
            mode: composite.mode === 'split' ? 'split' : 'single',
        });
        const { file: _file, ...stored } = entry;
        await writeValue(PROFILES, stored);
    }

    const compositeRecord = { ...composite };
    for (const profileId of PROFILE_SLOTS) {
        const slot = compositeRecord[profileId];
        if (!slot) continue;
        const { file: _file, ...stored } = slot;
        compositeRecord[profileId] = stored;
    }
    await writeValue(STORE, compositeRecord, 'current');
    return composite;
}

/**
 * Load a profile.
 *
 *   loadProfile()           the composite profile, or null
 *   loadProfile(profileId)  one slot record, or null
 */
export async function loadProfile(profileId = undefined) {
    if (profileId !== undefined && profileId !== null) {
        if (typeof profileId !== 'string') {
            throw profileError('INVALID_PROFILE_ID', 'a profile id is a string');
        }
        const existing = await readSlot(profileId);
        const entry = existing
            ? normalizeProfileEntry(profileId, existing)
            : slotFromComposite(await readComposite(), profileId);
        return hydrateEntry(profileId, entry);
    }

    const composite = await readComposite();
    if (composite) return hydrateComposite(composite);
    const records = await readSlots();
    return hydrateComposite(compositeFromRecords(
        records.map((record) => normalizeProfileEntry(record.id, record)),
    ));
}

/** Attach the stored Firefox/Safari files to every slot of a profile. */
async function hydrateComposite(profile) {
    if (!profile) return profile;
    const entries = await Promise.all(
        PROFILE_SLOTS.map((profileId) => hydrateEntry(profileId, profile[profileId] ?? null)),
    );
    const hydrated = { ...profile };
    for (const [index, profileId] of PROFILE_SLOTS.entries()) {
        hydrated[profileId] = entries[index];
    }
    return hydrated;
}

/** Remove one slot record. Returns true when something was removed. */
export async function deleteProfile(profileId) {
    if (typeof profileId !== 'string' || !profileId) {
        throw profileError('INVALID_PROFILE_ID', 'a profile id is a string');
    }
    const existing = await loadProfile(profileId);
    if (storageAvailable()) {
        try {
            await deleteValue(PROFILES, profileId);
            await deleteFileBlob(profileId);
            await patchComposite(profileId, null);
        } catch (error) {
            if (error?.code !== 'INDEXEDDB_UNAVAILABLE') throw error;
        }
    }
    return Boolean(existing);
}

/** Every configured slot, for the settings card. */
export async function getAllProfiles() {
    const [composite, records] = await Promise.all([readComposite(), readSlots()]);
    const byId = new Map();
    if (composite) {
        for (const profileId of PROFILE_SLOTS) {
            const entry = slotFromComposite(composite, profileId);
            if (entry) byId.set(profileId, entry);
        }
    }
    for (const record of records) {
        if (!record || !PROFILE_SLOTS.includes(record.id)) continue;
        byId.set(record.id, normalizeProfileEntry(record.id, record));
    }
    const hydrated = await Promise.all(
        [...byId.values()].map((entry) => hydrateEntry(entry.id, entry)),
    );
    return hydrated.sort(
        (left, right) => PROFILE_SLOTS.indexOf(left.id) - PROFILE_SLOTS.indexOf(right.id),
    );
}

/** Remove the whole profile (every slot and the composite record). */
export async function clearProfile() {
    if (!storageAvailable()) return;
    await Promise.all([deleteValue(STORE, 'current'), clearValues(PROFILES), clearValues(FILES)]);
}

/**
 * Move one slot through the verification state machine.
 *
 * @param {string} profileId 'text' | 'vision' | 'support' | 'multimodal'
 * @param {'not_configured'|'not_verified'|'ready'|'error'} status
 * @param {string} [errorCode]
 * @returns {Promise<object>} the updated record
 */
export async function updateVerificationStatus(profileId, status, errorCode) {
    const target = normalizeStatus(status);
    if (!target) {
        throw profileError('INVALID_STATUS', `unknown verification status: ${status}`, { status });
    }
    const entry = await loadProfile(profileId);
    if (!entry) {
        throw profileError('PROFILE_NOT_FOUND', `no profile for ${profileId}`, { profileId });
    }

    const from = normalizeStatus(entry.status) ?? PROFILE_STATUSES.NOT_CONFIGURED;
    if (!canTransition(from, target)) {
        throw profileError(
            'INVALID_STATUS_TRANSITION',
            `cannot move ${profileId} from ${from} to ${target}`,
            { profileId, from, to: target },
        );
    }

    const updated = normalizeProfileEntry(profileId, {
        ...entry,
        status: target,
        errorCode: target === PROFILE_STATUSES.ERROR ? (errorCode || 'VERIFY_FAILED') : undefined,
        verifiedAt: target === PROFILE_STATUSES.READY ? Date.now() : undefined,
    });
    await writeSlot(profileId, updated);
    await patchComposite(profileId, updated);
    return updated;
}

/** True when the slot cannot be used until the clinic picks its file again. */
export function profileNeedsRepair(entry) {
    if (!entry) return false;
    if (entry.status === PROFILE_STATUSES.READY) return false;
    // A stored File (Firefox/Safari) is as usable as a Chromium handle.
    if (!entry.handle && !entry.file) return true;
    return entry.status === PROFILE_STATUSES.ERROR && REPAIR_CODES.has(entry.errorCode);
}

/**
 * Clear a stale handle and send the slot back to `not_configured`.
 *
 * The settings card calls this when the verification says the permission or
 * the file is gone, then opens the picker again. The name and the hash are
 * kept for display so the clinic can see which file it is repairing.
 */
export async function repairProfile(profileId) {
    const entry = await loadProfile(profileId);
    if (!entry) return null;
    const cleared = normalizeProfileEntry(profileId, {
        ...entry,
        handle: null,
        file: null,
        status: PROFILE_STATUSES.NOT_CONFIGURED,
        errorCode: undefined,
        verifiedAt: undefined,
    });
    await writeSlot(profileId, cleared, { preserveHandle: false });
    await deleteFileBlob(profileId);
    // The composite profile must stop counting this model as configured;
    // otherwise an import would start and fail on the missing handle.
    await patchComposite(profileId, null);
    return cleared;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * The default smoke render.
 *
 * The plan asks for one prompt and a few tokens before the status becomes
 * "Ready": the header probe says the file *should* load, the smoke render says
 * it *did*. It is skipped outside a browser (the unit tests) and for a vision
 * model, whose smoke render needs an image and belongs to the OCR runtime.
 *
 * The caller can pass `smokeRender` to override this, which is what the
 * settings card does when it wants to show progress.
 */
async function defaultSmokeRender(context) {
    if (typeof window === 'undefined') {
        return { skipped: true, reason: 'no browser runtime' };
    }
    if (context.entry.id !== 'text' && context.entry.id !== 'multimodal') {
        return { skipped: true, reason: 'the vision model is exercised with an image by the OCR runtime' };
    }

    const { setupLocalModels } = await import('./setup.js');
    let profile;
    if (context.entry.id === 'multimodal') {
        // The projector is part of the same model from the runtime's point
        // of view: a smoke render without it would test the text half only.
        const stored = await loadProfile();
        profile = {
            ...emptyProfile(),
            mode: 'single',
            multimodal: context.entry,
            mmproj: stored?.mmproj ?? null,
        };
    } else {
        profile = { ...emptyProfile(), mode: 'split', text: context.entry };
    }
    const setup = await setupLocalModels({
        profile,
        config: context.options.config,
        tier: context.options.tier ?? 'mid',
    });
    try {
        const response = await setup.provider.complete({
            system: 'You are a smoke test. Answer in one word.',
            user: [{ type: 'text', text: 'Say OK.' }],
            maxTokens: 4,
        });
        return { skipped: false, text: response?.text ?? '', usage: response?.usage ?? null };
    } finally {
        // The model is released before the settings card returns, so the
        // smoke render does not leave 700 MB resident for the next import.
        await setup.unload();
    }
}

function normalizeProbeResult(result) {
    if (!result) {
        return {
            ok: false,
            code: 'PROBE_FAILED',
            detail: 'the capability probe returned no result',
            warnings: [],
            params: {},
        };
    }
    if (result.ok === true) return result;
    const code = result.error ?? result.code ?? 'PROBE_FAILED';
    return {
        ok: false,
        code,
        detail: result.detail ?? result.message ?? code,
        warnings: result.warnings ?? [],
        capabilities: result.capabilities,
        // The card formats these, so they must survive the normalisation.
        params: result.params ?? {},
        bytesConsumed: Number(result.bytesConsumed) || 0,
        fileSize: Number(result.fileSize) || 0,
        runtime: result.runtime ?? null,
        runtimeLabel: result.runtimeLabel ?? '',
    };
}

/**
 * Verify one model slot: handle -> SHA-256 -> magic/header probe -> smoke
 * render -> status.
 *
 * The function never leaves the status on `not_verified` after a failure; a
 * failure is recorded as `error(<code>)`, and a missing or unreachable handle
 * comes back with `repair: true` so the settings card can re-open the picker.
 *
 * @param {string} profileId
 * @param {{
 *   probe?: Function, computeSHA256?: Function, smokeRender?: Function|false,
 *   expectedSha256?: string, hash?: boolean, config?: object, tier?: string,
 *   probeOptions?: object, hashOptions?: object
 * }} [options]
 * @returns {Promise<{ok: boolean, status: string, code?: string, sha256?: string,
 *                    probe?: object, warnings?: string[], repair?: boolean}>}
 */
export async function verifyModel(profileId, options = {}) {
    let entry = await loadProfile(profileId);
    if (!entry) {
        return {
            ok: false,
            status: PROFILE_STATUSES.NOT_CONFIGURED,
            code: 'NO_MODEL_PROFILE',
            message: `no profile for ${profileId}`,
            repair: true,
        };
    }

    const supportSlot = profileId === 'support' || entry.id === 'support';

    // A model slot with no file is not something to probe. The support slot
    // is the exception: its small files are persisted, so it can be verified
    // even when the folder handle cannot be re-granted.
    if (!entry.handle && !entry.file && !supportSlot) {
        if (normalizeStatus(entry.status) !== PROFILE_STATUSES.NOT_CONFIGURED) {
            try {
                await updateVerificationStatus(profileId, PROFILE_STATUSES.NOT_CONFIGURED);
            } catch { /* the missing handle is the answer; the status is secondary */ }
        }
        return {
            ok: false,
            status: PROFILE_STATUSES.NOT_CONFIGURED,
            code: 'MODEL_FILE_MISSING',
            message: 'no model file has been picked for this slot',
            repair: true,
        };
    }

    // From here on the slot is being checked. The state machine requires this
    // step, and it also means an interrupted verify never looks "Ready".
    if (normalizeStatus(entry.status) !== PROFILE_STATUSES.NOT_VERIFIED) {
        try {
            entry = await updateVerificationStatus(profileId, PROFILE_STATUSES.NOT_VERIFIED);
        } catch { /* a stale status must not stop the check */ }
    }

    try {
        // A support slot holds a folder, not a model file: the question is
        // whether the folder still exists and still has the files the OCR
        // runtime asks for. The small files themselves are also persisted, so
        // a folder handle that cannot be re-granted is not fatal when they are
        // still stored (see ai-local.js).
        if (supportSlot) {
            const storedFiles = entry.files && typeof entry.files === 'object' ? entry.files : {};
            let missing = OCR_SUPPORT_FILES.filter((name) => !storedFiles[name]);
            let folderReachable = false;

            if (entry.handle?.kind === 'directory' && (await verifyHandle(entry.handle))) {
                folderReachable = true;
                if (typeof entry.handle.getFileHandle === 'function') {
                    missing = [];
                    for (const name of OCR_SUPPORT_FILES) {
                        try {
                            await entry.handle.getFileHandle(name);
                        } catch {
                            missing.push(name);
                        }
                    }
                }
            }

            if (missing.length > 0) {
                throw profileError(
                    folderReachable ? 'SUPPORT_FILES_MISSING' : 'MODEL_FILE_UNAVAILABLE',
                    folderReachable
                        ? `the support folder is missing: ${missing.join(', ')}`
                        : 'the support folder is not reachable; pick it again',
                    { missing },
                );
            }
            const ready = await updateVerificationStatus(profileId, PROFILE_STATUSES.READY);
            return { ok: true, status: ready.status, support: true, warnings: [] };
        }

        const file = entry.file ?? await fileFromHandle(entry.handle);
        if (!file) {
            throw profileError('MODEL_FILE_UNAVAILABLE', 'the model file is not reachable; pick it again');
        }

        // 1. Capability probe: magic bytes and metadata. This refuses an
        //    unsupported file before a 700 MB load. The projector has its own
        //    role: it is a `clip` GGUF, not a text model.
        const probeFn = options.probe ?? probeModelFile;
        const probeOptions = { ...(options.probeOptions ?? {}) };
        if (probeOptions.role === undefined && (profileId === 'mmproj' || entry.id === 'mmproj')) {
            probeOptions.role = 'projector';
        }
        if (probeOptions.mode === undefined && entry.mode) probeOptions.mode = entry.mode;
        const probe = normalizeProbeResult(await probeFn(file, probeOptions));
        if (!probe.ok) {
            throw profileError(probe.code || 'PROBE_FAILED', probe.detail || 'the model file was refused', {
                warnings: probe.warnings ?? [],
                capabilities: probe.capabilities,
                params: probe.params ?? {},
                bytesConsumed: probe.bytesConsumed ?? 0,
                fileSize: probe.fileSize ?? 0,
                runtimeLabel: probe.runtimeLabel ?? '',
            });
        }

        // 2. Chunked SHA-256. The cache makes a second verify free.
        let sha256 = String(entry.sha256 ?? '').toUpperCase();
        if (options.hash !== false) {
            const hashFn = options.computeSHA256 ?? computeSHA256;
            sha256 = String(await hashFn(file, options.hashOptions ?? {})).toUpperCase();
        }
        const expected = String(options.expectedSha256 ?? entry.sha256 ?? '').toUpperCase();
        if (expected && sha256 && expected !== sha256) {
            throw profileError('MODEL_HASH_MISMATCH', 'the model file is not the one that was verified before', {
                expected,
                actual: sha256,
            });
        }

        // 3. Smoke render: one prompt, a few tokens, then release the model.
        let smoke = { skipped: true, reason: 'disabled' };
        if (options.smokeRender === false) {
            smoke = { skipped: true, reason: 'disabled by the caller' };
        } else if (typeof options.smokeRender === 'function') {
            smoke = await options.smokeRender({ profileId, entry, file, probe, options });
        } else {
            smoke = await defaultSmokeRender({ profileId, entry, file, probe, options });
        }
        if (smoke && smoke.ok === false) {
            throw profileError(smoke.code || 'SMOKE_RENDER_FAILED', smoke.message || 'the model did not answer the smoke prompt');
        }

        // 4. Persist the identity and the capability report, then flip the
        //    status. The status update is what makes the card show "Ready".
        const warnings = [...(probe.warnings ?? []), ...(smoke?.warnings ?? [])];
        await saveProfile(profileId, {
            ...entry,
            name: file.name || entry.name,
            size: Number(file.size ?? entry.size) || 0,
            sha256: sha256 || entry.sha256,
            adapter: probe.adapter ?? entry.adapter ?? null,
            capabilities: probe.capabilities ?? entry.capabilities ?? null,
            warnings,
            runtimeLabel: probe.runtimeLabel ?? entry.runtimeLabel ?? '',
            // The override is a property of the slot: setup must keep allowing
            // the architecture after a reload, or the import fails where the
            // card said it was ready.
            allowUnsupportedArchitecture: entry.allowUnsupportedArchitecture === true
                || probeOptions.allowUnsupportedArchitecture === true,
            status: PROFILE_STATUSES.NOT_VERIFIED,
        });
        const ready = await updateVerificationStatus(profileId, PROFILE_STATUSES.READY);
        return {
            ok: true,
            status: ready.status,
            code: null,
            sha256: ready.sha256,
            probe,
            smoke,
            warnings,
            repair: false,
        };
    } catch (error) {
        const code = error?.code || 'VERIFY_FAILED';
        let updated = null;
        try {
            updated = await updateVerificationStatus(profileId, PROFILE_STATUSES.ERROR, code);
        } catch { /* the returned error is the useful one */ }
        return {
            ok: false,
            status: updated?.status ?? PROFILE_STATUSES.ERROR,
            code,
            message: String(error?.message ?? code),
            warnings: error?.warnings ?? [],
            capabilities: error?.capabilities,
            params: error?.params ?? {},
            bytesConsumed: Number(error?.bytesConsumed) || 0,
            fileSize: Number(error?.fileSize) || 0,
            runtimeLabel: error?.runtimeLabel ?? '',
            repair: REPAIR_CODES.has(code),
        };
    }
}

// ---------------------------------------------------------------------------
// Pickers and support files
// ---------------------------------------------------------------------------

/**
 * Pick one model file.
 *
 * Chromium can hand back a handle that stays valid across reloads. Other
 * browsers cannot, so the caller falls back to a file input and the clinic
 * picks the file again after a reload.
 *
 * @param {string|string[]} [accept] '.gguf', '.onnx', or both
 * @returns {Promise<{handle: FileSystemFileHandle, name: string, kind: string,
 *          size: number, lastModified: number}|null>}
 */
export async function pickModelFile(accept = null) {
    const handle = await pickModelFileHandle(accept);
    if (!handle) return null;
    const file = await handle.getFile();
    return {
        handle,
        // Kept for sessions where the handle cannot be re-granted (or for the
        // caller that does not want to call `getFile()` a second time).
        file,
        name: file.name,
        kind: fileKind(file.name),
        size: file.size,
        lastModified: file.lastModified ?? 0,
    };
}

/**
 * Pick the folder with the tokenizer and config files a vision model needs.
 *
 * The folder handle is kept in the profile (Chromium can restore it after a
 * reload), and the small files themselves are also kept so the OCR runtime
 * still works when the handle cannot be re-granted.
 *
 * @returns {Promise<{name: string, handle: FileSystemDirectoryHandle,
 *          files: Record<string, File>}|null>}
 */
export async function pickSupportFolder() {
    const directory = await pickSupportDirectory();
    if (!directory) return null;
    const files = await readDirectoryFiles(directory);
    return { name: directory.name, handle: directory, files };
}

/**
 * The same files, picked one by one, for a browser without a folder picker.
 */
export function supportFilesFromFileList(fileList) {
    const files = {};
    for (const file of Array.from(fileList || [])) {
        files[file.name] = file;
    }
    return { name: '', handle: null, files };
}
