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
    missingSupportFiles,
    fileKind,
} from '../features/import-agent/local/model-profile.js';
import { probeModelFile, fileKind as sniffFileKind } from '../features/import-agent/local/adapters.js';
import { sha256OfFile } from '../features/import-agent/local/model-store.js';
import { probeDevice, OCR_SUPPORT_FILES } from '../features/import-agent/local/manifest.js';
import { DEFAULT_LOCAL_CONFIG, resolveLocalConfig } from '../features/import-agent/local/local-config.js';

/** The state of one model slot in the setup panel. */
export function emptySlot() {
    return {
        // 'none' | 'warn' | 'ok' | 'error'
        status: 'none',
        // The file handle. It never leaves the browser.
        handle: null,
        name: '',
        size: 0,
        sha256: '',
        kind: 'unknown',
        message: '',
        code: null,
    };
}

/** The draft state of the whole local panel. */
export function createLocalState() {
    return {
        mode: 'single',
        multimodal: emptySlot(),
        text: emptySlot(),
        vision: emptySlot(),
        support: {
            status: 'none',
            name: '',
            message: '',
            missing: [...OCR_SUPPORT_FILES],
            files: {},
        },
        config: structuredClone(DEFAULT_LOCAL_CONFIG),
        device: null,
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
    }
    if (state.vision.name) {
        payload.visionName = state.vision.name;
        payload.visionSize = state.vision.size;
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
 */
export async function verifyModelFile(file) {
    const probe = await probeModelFile(file);
    if (!probe.ok) {
        return {
            ok: false,
            code: probe.code,
            message: probe.detail,
            warnings: probe.warnings,
            capabilities: probe.capabilities,
        };
    }
    let sha256 = '';
    try {
        sha256 = await sha256OfFile(file);
    } catch {
        // The hash is a nicety, not a gate: the file is usable without it.
        sha256 = '';
    }
    return {
        ok: true,
        code: null,
        message: probe.detail,
        warnings: probe.warnings,
        sha256,
        capabilities: probe.capabilities,
    };
}

/** The slot a file goes into, given the current layout. */
export function slotForKind(state, kind) {
    if (state.mode === 'single') return 'multimodal';
    return kind === 'onnx' ? 'vision' : 'text';
}

/**
 * Pick a model file and check it.
 *
 * @param {object} state the draft state (mutated)
 * @param {string} slot 'multimodal' | 'text' | 'vision'
 */
export async function pickAndVerify(state, slot) {
    const picked = await pickModelFile();
    if (!picked) return null;
    const file = await picked.handle.getFile();
    const result = await verifyModelFile(file);
    state[slot] = {
        ...emptySlot(),
        // The handle is what lets the model be loaded again after a reload.
        // It never leaves the browser: the server only learns the name, the
        // size and the hash.
        handle: picked.handle,
        name: picked.name,
        size: picked.size ?? file.size,
        kind: picked.kind,
        status: result.ok ? 'ok' : 'error',
        message: result.message,
        code: result.code,
        sha256: result.sha256 ?? '',
    };
    state.warnings = result.warnings ?? [];
    return { file, result };
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
    } else {
        support = await pickSupportFolder();
    }
    if (!support) return false;
    const missing = missingSupportFiles(support);
    state.support = {
        ...state.support,
        status: missing.length === 0 ? 'ok' : 'warn',
        name: support.name || Object.keys(support.files).join(', '),
        message: missing.length === 0 ? '' : missing.join(', '),
        missing,
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
    const slots = { multimodal: stored.multimodal, text: stored.text, vision: stored.vision };
    for (const [slot, entry] of Object.entries(slots)) {
        if (!entry) continue;
        state[slot] = {
            ...emptySlot(),
            // The handle comes back with the profile, so a model the clinic
            // picked earlier can still be loaded.
            handle: entry.handle ?? null,
            name: entry.name ?? '',
            size: entry.size ?? 0,
            sha256: entry.sha256 ?? '',
            kind: entry.kind ?? fileKind(entry.name),
            status: 'warn',
            message: '',
        };
    }
    if (stored.support?.files) {
        const missing = missingSupportFiles(stored.support);
        state.support = {
            ...state.support,
            status: missing.length === 0 ? 'ok' : 'warn',
            name: stored.support.name ?? '',
            message: missing.join(', '),
            missing,
            files: stored.support.files,
        };
    }
    return state;
}

/** Write the draft into the stored profile. */
export async function persistLocalState(state) {
    const profile = emptyProfile();
    profile.mode = state.mode;
    for (const slot of ['multimodal', 'text', 'vision']) {
        const entry = state[slot];
        if (!entry.name) continue;
        profile[slot] = {
            handle: entry.handle ?? null,
            name: entry.name,
            kind: entry.kind,
            size: entry.size,
            sha256: entry.sha256,
        };
    }
    if (state.support.status !== 'none') {
        // The tokenizer and the config files are kept: the OCR model cannot
        // load without them.
        profile.support = { name: state.support.name, files: state.support.files ?? {} };
    }
    await saveProfile(profile);
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
    const tier = state.device?.tier ?? 'mid';
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
};
