// The v2 profile: which folder this computer uses, and the sampling / context
// the clinic chose.
//
// It is deliberately plain JSON — no file handles, no File objects, no
// absolute paths. The folder is picked again each session (a browser may not
// keep permission to it), so a profile that remembered a path would only ever
// be wrong. What is kept is the model's name, its id and the numbers a load
// needs.
//
// A profile carrying a non-cloneable value would throw DataCloneError when it
// crossed a worker boundary (fixed in 1704bd8); strings and numbers cannot.

export const PROFILE_KEY = 'clinic.localAi.v2.profile';

function storage() {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch {
        // A browser with storage disabled throws on access, not on use.
        return null;
    }
}

/** A profile for a model that has not been chosen yet. */
export function emptyV2Profile() {
    return {
        modelId: null,
        contextWindow: 4096,
        sampling: { temperature: 0.3, topP: 0.9, frequencyPenalty: 0.3 },
        savedAt: null,
    };
}

function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

/**
 * Clamp a stored or edited profile.
 *
 * `maxContext` is the window the compiled model was built for, when the card
 * knows it. Without it the profile is only clamped to what WebLLM accepts.
 */
export function normalizeV2Profile(profile, maxContext = 1_048_576) {
    const base = emptyV2Profile();
    const ceiling = Math.max(512, Math.round(Number(maxContext) || 1_048_576));
    return {
        modelId: profile?.modelId ? String(profile.modelId) : null,
        contextWindow: Math.min(
            Math.max(512, Math.round(Number(profile?.contextWindow) || base.contextWindow)),
            ceiling,
        ),
        sampling: {
            temperature: clamp(profile?.sampling?.temperature, 0, 2, base.sampling.temperature),
            topP: clamp(profile?.sampling?.topP, 0.05, 1, base.sampling.topP),
            frequencyPenalty: clamp(profile?.sampling?.frequencyPenalty, -2, 2, base.sampling.frequencyPenalty),
        },
        savedAt: profile?.savedAt ?? null,
    };
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
 * actually loaded, so a profile cannot claim a model this computer never ran.
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
 * The identity a job is started with.
 *
 * The server compares it on every claim, the way v1 compares the file name,
 * the hash and the layout. Kept here (not in the pump) so the wizard and the
 * settings card cannot disagree about what "the same model" means.
 */
export function profileIdentity(profile) {
    const normalized = normalizeV2Profile(profile);
    if (!normalized.modelId) return null;
    return {
        modelId: normalized.modelId,
        contextWindow: normalized.contextWindow,
    };
}
