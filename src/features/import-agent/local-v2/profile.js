// The v2 profile: which catalog model this device uses, and the sampling /
// context the clinic chose.
//
// It is deliberately plain JSON — no file handles, no File objects. v1 had to
// keep handles and blobs, and a profile carrying a non-cloneable value threw
// DataCloneError when it crossed a worker boundary (fixed in 1704bd8). v2
// downloads its weights into the browser cache, so the settings are a few
// strings and numbers and can be stored the same way anywhere.

import { defaultModel, modelById } from './catalog.js';

export const PROFILE_KEY = 'clinic.localAi.v2.profile';

/** The model the card last picked, which is not necessarily the proven one. */
export const SELECTED_KEY = 'clinic.localAi.v2.selectedModel';

function storage() {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch {
        // A browser with storage disabled throws on access, not on use.
        return null;
    }
}

/** A fresh profile for the catalog's first model. */
export function emptyV2Profile(model = defaultModel()) {
    return {
        modelId: model?.id ?? null,
        contextWindow: Number(model?.contextWindow) || 4096,
        sampling: {
            temperature: Number(model?.sampling?.temperature ?? 0.7),
            topP: Number(model?.sampling?.topP ?? 0.95),
            frequencyPenalty: Number(model?.sampling?.frequencyPenalty ?? 0.5),
        },
        savedAt: null,
    };
}

/** Clamp a stored or edited profile onto the model it names. */
export function normalizeV2Profile(profile) {
    const model = modelById(profile?.modelId) ?? defaultModel();
    const base = emptyV2Profile(model);
    if (!model) return base;
    const window = Math.min(
        Math.max(512, Number(profile?.contextWindow) || base.contextWindow),
        Number(model.contextWindow) || base.contextWindow,
    );
    return {
        modelId: model.id,
        contextWindow: window,
        sampling: {
            temperature: clamp(profile?.sampling?.temperature, 0, 2, base.sampling.temperature),
            topP: clamp(profile?.sampling?.topP, 0.05, 1, base.sampling.topP),
            frequencyPenalty: clamp(profile?.sampling?.frequencyPenalty, -2, 2, base.sampling.frequencyPenalty),
        },
        savedAt: profile?.savedAt ?? null,
    };
}

function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

/** The stored profile, or a fresh one when nothing is saved. */
export function loadV2Profile(store = storage()) {
    const raw = store?.getItem?.(PROFILE_KEY);
    if (!raw) return emptyV2Profile();
    try {
        return normalizeV2Profile(JSON.parse(raw));
    } catch {
        // A corrupt value is not worth an error dialog: start over.
        return emptyV2Profile();
    }
}

/**
 * Save the profile.
 *
 * `savedAt` is what makes the card say "Ready": it is set only after a model
 * actually loaded, so a profile cannot claim a model this browser never had.
 */
export function saveV2Profile(profile, store = storage()) {
    const normalized = normalizeV2Profile({ ...profile, savedAt: profile?.savedAt ?? Date.now() });
    // A JSON round-trip proves the value is cloneable before it is stored.
    const json = JSON.stringify(normalized);
    store?.setItem?.(PROFILE_KEY, json);
    return normalized;
}

export function clearV2Profile(store = storage()) {
    store?.removeItem?.(PROFILE_KEY);
}

/**
 * The picked model id.
 *
 * Kept apart from the profile because picking a model must not claim it has
 * been tested: the profile's `savedAt` is the proof, and only a load sets it.
 */
export function loadSelectedModelId(store = storage()) {
    return store?.getItem?.(SELECTED_KEY) || null;
}

export function saveSelectedModelId(id, store = storage()) {
    if (id) store?.setItem?.(SELECTED_KEY, String(id));
    else store?.removeItem?.(SELECTED_KEY);
    return id ?? null;
}

/**
 * The identity a job is started with.
 *
 * The server compares it on every claim, the way v1 compares the file name,
 * the hash and the layout. Kept here (not in the pump) so the wizard and the
 * settings card cannot disagree about what "the same model" means.
 */
export function profileIdentity(profile) {
    const model = modelById(profile?.modelId) ?? defaultModel();
    if (!model) return null;
    return {
        modelId: model.id,
        quant: model.quant,
        contextWindow: Number(profile?.contextWindow) || model.contextWindow,
    };
}
