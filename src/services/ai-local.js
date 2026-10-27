// Browser side of the local AI engine.
//
// The files stay on the clinic's PC. What the server learns is the name, the
// size and the SHA-256 of each file, so a later import can say which model
// produced a record.
//
// The state here is a draft: the settings card edits it and the admin saves
// it. The models themselves are remembered in IndexedDB, so the clinic picks
// them once.

import {
    emptyProfile,
    loadProfile,
    saveProfile,
    clearProfile,
    pickModelFile,
    pickSupportFolder,
    supportFilesFromFileList,
    profileComplete,
    profileNeedsRepair,
    missingSupportFiles,
    fileKind,
} from '../features/import-agent/local/model-profile.js';
import { probeModelFile, fileKind as sniffFileKind } from '../features/import-agent/local/adapters.js';
import { fileFromHandle, sha256OfFile } from '../features/import-agent/local/model-store.js';
import { probeDevice, OCR_SUPPORT_FILES } from '../features/import-agent/local/manifest.js';
import {
    DEFAULT_LOCAL_CONFIG,
    detectTier,
    resolveLocalConfig,
    validateLocalConfig,
} from '../features/import-agent/local/local-config.js';

/**
 * The `<input type="file">` fallback for browsers without the File System
 * Access API (Firefox, Safari). Resolves with the picked files, or null when
 * the picker is closed. The fallback has no persistent handle: the clinic
 * picks the file again after a reload, which the card says plainly.
 */
function pickWithInput({ accept, multiple = false, directory = false } = {}) {
    if (typeof document === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.multiple = multiple === true;
        if (directory) {
            input.webkitdirectory = true;
            input.setAttribute('webkitdirectory', '');
        }
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        input.setAttribute('aria-hidden', 'true');

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(value);
        };
        input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
        input.addEventListener('cancel', () => finish(null));
        document.body.appendChild(input);
        input.click();
    });
}

function hasFilePicker() {
    return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

function hasDirectoryPicker() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** The state of one model slot in the setup panel. */
export function emptySlot() {
    return {
        // 'none' | 'warn' | 'ok' | 'error'
        status: 'none',
        // The file handle. It never leaves the browser. A browser without the
        // File System Access API leaves this null and keeps the File itself
        // (in IndexedDB and in memory as `file`).
        handle: null,
        file: null,
        name: '',
        size: 0,
        sha256: '',
        kind: 'unknown',
        message: '',
        // A translation key when `message` is one, otherwise an empty object.
        params: {},
        code: null,
        // What the probe learned. Kept on the slot so the card can say
        // "this GGUF has no vision tower" without probing again.
        capabilities: null,
        warnings: [],
        runtimeLabel: '',
        bytesConsumed: 0,
        fileSize: 0,
        // The clinic chose to load an architecture that is not on the
        // checked-in support list. The choice follows the file.
        allowUnsupportedArchitecture: false,
    };
}

/** The draft state of the whole local panel. */
export function createLocalState() {
    return {
        mode: 'single',
        multimodal: emptySlot(),
        // The optional `mmproj.gguf` projector for the single layout.
        mmproj: emptySlot(),
        text: emptySlot(),
        vision: emptySlot(),
        support: {
            status: 'none',
            name: '',
            message: '',
            missing: [...OCR_SUPPORT_FILES],
            // The folder handle, when Chromium can restore it after a reload.
            handle: null,
            files: {},
        },
        config: structuredClone(DEFAULT_LOCAL_CONFIG),
        device: null,
        // 'granted' | 'denied' | 'quota' | 'unsupported' | null. Set when the
        // card stores a File in IndexedDB (Firefox/Safari).
        fileStorage: null,
        warnings: [],
    };
}

/** The draft as the server stores it: names, sizes and hashes only. */
export function localProfilePayload(state) {
    const payload = { mode: state.mode };
    if (state.multimodal.name) {
        payload.name = state.multimodal.name;
        payload.size = state.multimodal.size;
        if (state.multimodal.sha256) payload.sha256 = state.multimodal.sha256;
    }
    if (state.text.name) {
        payload.textName = state.text.name;
        payload.textSize = state.text.size;
        if (state.text.sha256) payload.textSha256 = state.text.sha256;
    }
    if (state.mmproj?.name) {
        payload.mmprojName = state.mmproj.name;
        payload.mmprojSize = state.mmproj.size;
        if (state.mmproj.sha256) payload.mmprojSha256 = state.mmproj.sha256;
    }
    if (state.vision.name) {
        payload.visionName = state.vision.name;
        payload.visionSize = state.vision.size;
        if (state.vision.sha256) payload.visionSha256 = state.vision.sha256;
    }
    if (state.support.name) payload.supportName = state.support.name;
    return payload;
}

/**
 * Check a model file and read its hash.
 *
 * The check reads the header only, so a 700 MB file is not loaded into
 * memory to find out that it is the wrong kind of file. The hash is read in
 * pieces, for the same reason.
 *
 * @param {File} file
 * @param {'gguf'|'onnx'|null} expectedKind the kind the slot accepts
 * @param {{ probeOptions?: object, hash?: boolean, expectedSha256?: string }} [options]
 */
export async function verifyModelFile(file, expectedKind = null, options = {}) {
    const probe = await probeModelFile(file, options.probeOptions ?? {});
    const kind = probe.capabilities?.kind ?? fileKind(file?.name);
    if (!probe.ok) {
        return {
            ok: false,
            code: probe.code,
            kind,
            message: probe.detail,
            warnings: probe.warnings ?? [],
            capabilities: probe.capabilities,
            params: probe.params ?? {},
            bytesConsumed: Number(probe.bytesConsumed) || 0,
            fileSize: Number(probe.fileSize) || 0,
            runtimeLabel: probe.runtimeLabel ?? '',
        };
    }
    if (expectedKind && kind !== expectedKind) {
        return {
            ok: false,
            code: 'MODEL_KIND_MISMATCH',
            kind,
            message: expectedKind === 'onnx'
                ? 'this slot needs an ONNX vision model'
                : 'this slot needs a GGUF model',
            warnings: probe.warnings ?? [],
            capabilities: probe.capabilities,
            params: { kind: expectedKind === 'onnx' ? 'ONNX' : 'GGUF' },
        };
    }
    let sha256 = '';
    if (options.hash !== false) {
        try {
            sha256 = await sha256OfFile(file);
        } catch {
            // The hash is a nicety, not a gate: the file is usable without it.
            sha256 = '';
        }
    }
    const expected = String(options.expectedSha256 ?? '').toUpperCase();
    if (expected && sha256 && expected !== sha256) {
        return {
            ok: false,
            code: 'MODEL_HASH_MISMATCH',
            kind,
            message: 'the file is not the one that was verified before',
            warnings: probe.warnings ?? [],
            capabilities: probe.capabilities,
            params: { expected, actual: sha256 },
            sha256,
            hashMatches: false,
        };
    }
    return {
        ok: true,
        code: null,
        kind,
        message: probe.detail,
        warnings: probe.warnings ?? [],
        sha256,
        hashMatches: expected && sha256 ? true : null,
        capabilities: probe.capabilities,
        params: probe.params ?? {},
        runtimeLabel: probe.runtimeLabel ?? '',
    };
}

/** The slot a file goes into, given the current layout. */
export function slotForKind(state, kind) {
    if (state.mode === 'single') return 'multimodal';
    return kind === 'onnx' ? 'vision' : 'text';
}

/**
 * Step one: pick a model file. Nothing is loaded or hashed yet.
 *
 * The card then shows the file as "Not verified". Verification is a separate
 * click because a 700 MB model deserves a deliberate action (and because the
 * clinic may want to pick both models before the slow hash runs).
 *
 * @param {object} state the draft state (mutated)
 * @param {string} slot 'multimodal' | 'mmproj' | 'text' | 'vision'
 */
export async function browseLocalModel(state, slot) {
    const expectedKind = slot === 'vision' ? 'onnx' : 'gguf';
    const accept = expectedKind === 'onnx' ? '.onnx' : '.gguf';

    let picked = null;
    let pickerFailed = false;
    if (hasFilePicker()) {
        try {
            picked = await pickModelFile(expectedKind);
        } catch {
            // A real picker failure falls back to the input below, so the
            // clinic is never stuck without a way to pick the model. A null
            // result means the clinic closed the picker, not a failure.
            pickerFailed = true;
        }
        if (!picked && !pickerFailed) return null;
    }
    if (!picked) {
        const files = await pickWithInput({ accept });
        const file = files?.[0] ?? null;
        if (!file) return null;
        picked = {
            handle: null,
            file,
            name: file.name,
            kind: fileKind(file.name),
            size: file.size,
        };
    }
    state[slot] = {
        ...emptySlot(),
        // The handle is what lets the model be loaded again after a reload.
        // It never leaves the browser: the server only learns the name, the
        // size and the hash. Firefox/Safari have no handle, so the File stays
        // in memory for this session only.
        handle: picked.handle ?? null,
        file: picked.file ?? null,
        name: picked.name,
        size: picked.size ?? picked.file?.size ?? 0,
        kind: picked.kind,
        status: 'warn',
        message: '',
        code: null,
    };
    state.warnings = [];
    return picked;
}

/**
 * Step two: verify the picked file.
 *
 * The probe reads only the header, then the hash is read in chunks. The model
 * itself is not loaded here: loading is the runner's job, and doing it in the
 * settings card would keep hundreds of megabytes resident while the admin
 * edits unrelated settings.
 *
 * `options.hash === false` is the Re-check path: it probes the header again
 * (a truncated download is the usual failure) without reading 700 MB.
 *
 * @param {object} state the draft state (mutated)
 * @param {string} slot 'multimodal' | 'mmproj' | 'text' | 'vision'
 * @param {{ allowUnsupportedArchitecture?: boolean, hash?: boolean }} [options]
 */
export async function verifyLocalModelSlot(state, slot, options = {}) {
    const entry = state[slot] ?? emptySlot();
    const expectedKind = slot === 'vision' ? 'onnx' : 'gguf';

    if (slot === 'vision' && missingSupportFiles(state.support).length > 0) {
        const missing = missingSupportFiles(state.support);
        const result = {
            ok: false,
            code: 'OCR_SUPPORT_FILES_MISSING',
            message: `the vision model still needs: ${missing.join(', ')}`,
            params: { files: missing.join(', ') },
            warnings: [],
        };
        state.vision = {
            ...entry,
            status: 'error',
            message: '',
            params: result.params,
            code: result.code,
        };
        return result;
    }

    // A handle survives a reload in Chromium; the File object is the fallback
    // for Firefox and Safari (restored from IndexedDB by the profile store).
    const file = entry.file ?? await fileFromHandle(entry.handle);
    if (!file) {
        const result = {
            ok: false,
            code: 'MODEL_FILE_UNAVAILABLE',
            message: 'the file has to be picked again in this browser',
            warnings: [],
        };
        state[slot] = {
            ...entry,
            status: 'error',
            message: 'aiSettings.local.handleMissing',
            code: result.code,
        };
        return result;
    }

    const allowUnsupportedArchitecture = options.allowUnsupportedArchitecture === true
        || entry.allowUnsupportedArchitecture === true;
    const probeOptions = {
        mode: state.mode,
        chatTemplate: state.config?.text?.chatTemplate ?? null,
        allowUnsupportedArchitecture,
    };
    if (slot === 'mmproj') probeOptions.role = 'projector';

    const result = await verifyModelFile(file, expectedKind, {
        probeOptions,
        hash: options.hash !== false,
        expectedSha256: options.hash === false ? '' : entry.sha256,
    });

    if (!result.ok) {
        state[slot] = {
            ...entry,
            file,
            name: entry.name || file.name,
            size: entry.size || file.size,
            kind: result.kind ?? entry.kind,
            status: 'error',
            // The card translates the code; the raw English detail is kept
            // for diagnostics and is not the visible message.
            message: '',
            params: result.params ?? {},
            code: result.code,
            sha256: result.sha256 ?? entry.sha256,
            capabilities: result.capabilities ?? entry.capabilities,
            warnings: result.warnings ?? [],
            bytesConsumed: result.bytesConsumed ?? 0,
            fileSize: result.fileSize ?? 0,
            runtimeLabel: result.runtimeLabel ?? entry.runtimeLabel,
            allowUnsupportedArchitecture,
        };
        state.warnings = result.warnings ?? [];
        return result;
    }

    // A successful probe can still deserve an amber note: a text-only GGUF in
    // the one-model layout, a missing projector, or an architecture the clinic
    // explicitly allowed.
    let status = 'ok';
    let message = 'aiSettings.local.modelVerified';
    let params = {};
    if (allowUnsupportedArchitecture
        && (result.warnings ?? []).some((warning) => warning.includes('support list'))) {
        status = 'warn';
        message = 'aiSettings.local.architectureOverride';
        params = { architecture: result.capabilities?.architecture ?? '?' };
    } else if (slot === 'multimodal' && result.capabilities?.multimodal !== true) {
        status = 'warn';
        message = 'aiSettings.local.textOnlyWarning';
    } else if (slot === 'multimodal' && !state.mmproj?.name && result.capabilities?.vision === true) {
        status = 'warn';
        message = 'aiSettings.local.mmprojMissing';
    } else if (slot === 'multimodal') {
        message = '';
    }

    state[slot] = {
        ...entry,
        file,
        name: entry.name || file.name,
        size: entry.size || file.size,
        kind: result.kind ?? entry.kind,
        status,
        message,
        params,
        code: null,
        sha256: result.sha256 ?? entry.sha256,
        capabilities: result.capabilities ?? entry.capabilities,
        warnings: result.warnings ?? [],
        runtimeLabel: result.runtimeLabel ?? entry.runtimeLabel,
        allowUnsupportedArchitecture,
    };
    state.warnings = result.warnings ?? [];
    return { ...result, status };
}

/** Probe the header again, without re-reading a large file's SHA-256. */
export async function recheckLocalModelSlot(state, slot) {
    return verifyLocalModelSlot(state, slot, { hash: false });
}

/**
 * Pick a model file and check it in one call. Kept for callers that do not
 * need the two-step card flow.
 */
export async function pickAndVerify(state, slot) {
    const picked = await browseLocalModel(state, slot);
    if (!picked) return null;
    const result = await verifyLocalModelSlot(state, slot);
    const entry = state[slot];
    return { file: entry.file, result };
}

/**
 * Pick the folder with the tokenizer and the config files.
 *
 * A browser without a folder picker gets a file list instead; the caller
 * passes the files it collected.
 */
export async function pickSupportFiles(state, fileList = null) {
    let support = null;
    if (fileList) {
        support = supportFilesFromFileList(fileList);
    } else if (hasDirectoryPicker()) {
        let pickerFailed = false;
        try {
            support = await pickSupportFolder();
        } catch {
            pickerFailed = true;
        }
        // A null here is a cancelled picker, not an unsupported browser.
        if (!support && !pickerFailed) return false;
    }
    if (!support) {
        // Firefox/Safari: a directory input. The folder itself is not
        // exposed, but the files the OCR model needs are.
        const files = await pickWithInput({ accept: '.json,application/json', multiple: true, directory: true });
        if (!files || files.length === 0) return false;
        support = supportFilesFromFileList(files);
        const relative = String(files[0]?.webkitRelativePath ?? '');
        support.name = relative.includes('/') ? relative.split('/')[0] : 'support-files';
    }
    const missing = missingSupportFiles(support);
    state.support = {
        ...state.support,
        status: missing.length === 0 ? 'ok' : 'warn',
        name: support.name || Object.keys(support.files).join(', '),
        message: missing.length === 0 ? '' : missing.join(', '),
        missing,
        // The folder handle is stored with the profile so Chromium can ask
        // for permission again instead of making the clinic find the folder.
        handle: support.handle ?? state.support.handle ?? null,
        // The files themselves: the tokenizer needs them to load.
        files: support.files,
    };
    return true;
}

/** The stored profile, restored into the draft state. */
export async function restoreLocalState(state) {
    const stored = await loadProfile();
    if (!stored) return state;
    state.mode = stored.mode === 'split' ? 'split' : 'single';
    const slots = {
        multimodal: stored.multimodal,
        mmproj: stored.mmproj,
        text: stored.text,
        vision: stored.vision,
    };
    for (const [slot, entry] of Object.entries(slots)) {
        if (!entry) continue;
        const handle = entry.handle ?? null;
        const file = entry.file ?? null;
        const needsRepair = profileNeedsRepair(entry);
        const usable = Boolean(handle || file);
        state[slot] = {
            ...emptySlot(),
            // The handle (Chromium) or the stored File (Firefox/Safari) comes
            // back with the profile, so a model the clinic picked earlier can
            // still be loaded. A page reload does not restore the browser's
            // permission for a handle, though: the card must show "Not
            // verified" until a click re-grants the permission.
            handle,
            file,
            name: entry.name ?? '',
            size: entry.size ?? 0,
            sha256: entry.sha256 ?? '',
            kind: entry.kind ?? fileKind(entry.name),
            capabilities: entry.capabilities ?? null,
            warnings: entry.warnings ?? [],
            runtimeLabel: entry.runtimeLabel ?? '',
            allowUnsupportedArchitecture: entry.allowUnsupportedArchitecture === true,
            // A profile with a name but no handle and no stored bytes came
            // from another browser (or was saved before either was kept). It
            // cannot load until the clinic picks the file again.
            status: !usable || needsRepair ? 'error' : 'warn',
            message: !usable || needsRepair
                ? 'aiSettings.local.handleMissing'
                : (file && !handle ? 'aiSettings.local.fileRestored' : ''),
            params: {},
            code: !usable || needsRepair ? 'MODEL_FILE_UNAVAILABLE' : null,
        };
    }
    if (stored.support?.files || stored.support?.handle) {
        const missing = missingSupportFiles(stored.support);
        state.support = {
            ...state.support,
            status: 'warn',
            name: stored.support.name ?? '',
            message: missing.length === 0 ? '' : missing.join(', '),
            missing,
            handle: stored.support.handle ?? null,
            files: stored.support.files ?? {},
        };
    }
    return state;
}

/** True when a draft slot still names the file a stored slot points at. */
function sameStoredFile(entry, stored) {
    if (!entry?.name || !stored?.name || entry.name !== stored.name) return false;
    const size = Number(entry.size ?? 0);
    const storedSize = Number(stored.size ?? 0);
    return !size || !storedSize || size === storedSize;
}

/** Ask the browser not to evict the model files when storage runs low. */
async function requestPersistentStorage() {
    try {
        if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
            return 'unsupported';
        }
        return (await navigator.storage.persist()) ? 'granted' : 'denied';
    } catch {
        return 'denied';
    }
}

/**
 * Write the draft into the stored profile.
 *
 * The draft is rebuilt from the server response when the card reloads, and
 * the server never holds the handles. A settings save made after that reload
 * therefore carries `handle: null` for every model. The stored profile is
 * read first so an existing handle (or a stored File), the capabilities and
 * the support files are carried forward when the slot still names the same
 * file. Without this, changing only a runtime value silently made a "Ready"
 * model unusable for import.
 */
export async function persistLocalState(state) {
    let stored = null;
    try {
        stored = await loadProfile();
    } catch {
        // A broken read must not stop a save: the new profile is still the
        // best information we have.
        stored = null;
    }

    state.fileStorage = null;
    const profile = emptyProfile();
    profile.mode = state.mode;
    for (const slot of ['multimodal', 'mmproj', 'text', 'vision']) {
        const entry = state[slot];
        if (!entry?.name) continue;
        const previous = stored?.[slot];
        const sameFile = sameStoredFile(entry, previous);
        const handle = entry.handle
            ?? (sameFile ? previous.handle ?? null : null);
        const file = entry.file
            ?? (sameFile ? previous.file ?? null : null);
        profile[slot] = {
            handle,
            // A handle is the better storage on Chromium; the File is only
            // kept when there is no handle.
            file: handle ? null : file,
            name: entry.name,
            kind: entry.kind,
            size: entry.size,
            sha256: entry.sha256,
            capabilities: entry.capabilities ?? previous?.capabilities ?? null,
            warnings: entry.warnings ?? [],
            runtimeLabel: entry.runtimeLabel ?? '',
            allowUnsupportedArchitecture: entry.allowUnsupportedArchitecture === true,
        };
    }
    if (state.support.status !== 'none') {
        // The tokenizer and the config files are kept: the OCR model cannot
        // load without them. The folder handle is kept too where the browser
        // supports restoring it; the files are the fallback.
        const previous = stored?.support;
        const sameSupport = Boolean(previous && previous.name === state.support.name);
        const files = Object.keys(state.support.files ?? {}).length > 0
            ? state.support.files
            : (sameSupport ? previous.files ?? {} : {});
        profile.support = {
            name: state.support.name,
            handle: state.support.handle
                ?? (sameSupport ? previous.handle ?? null : null),
            files,
        };
    }

    const storesFiles = Object.values(profile).some(
        (slot) => slot && !slot.handle && slot.file,
    );
    if (storesFiles) {
        state.fileStorage = await requestPersistentStorage();
    }

    try {
        await saveProfile(profile);
    } catch (error) {
        // A 700 MB model may exceed the origin's quota. Keep the in-memory
        // File for this session and tell the card that the copy is only
        // temporary; the settings themselves are still saved.
        if (error?.name === 'QuotaExceededError' || /quota/i.test(String(error?.message ?? ''))) {
            state.fileStorage = 'quota';
            return profile;
        }
        throw error;
    }
    return profile;
}

export async function forgetLocalState() {
    await clearProfile();
}

/** Read what the device can do and suggest a tier. */
export async function readDevice() {
    return probeDevice();
}

/** The resolved config for the device tier, with the user's choices on top. */
export function resolveConfig(state) {
    const memory = Number(state.config?.runtime?.systemMemoryGb) || 0;
    // The entered System RAM wins over the browser-reported value, so a
    // Firefox/Safari user can earn the `high` tier instead of staying on
    // `mid` forever.
    const tier = state.device
        ? detectTier({ ...state.device, systemMemoryGb: memory })
        : 'mid';
    return resolveLocalConfig(tier, state.config ?? {});
}

export {
    emptyProfile,
    loadProfile,
    saveProfile,
    clearProfile,
    profileComplete,
    missingSupportFiles,
    fileKind,
    sniffFileKind,
    OCR_SUPPORT_FILES,
    DEFAULT_LOCAL_CONFIG,
    validateLocalConfig,
};
