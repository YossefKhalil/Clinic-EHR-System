// The v2 feature flag.
//
// The current engine keeps working exactly as it does today; v2 sits beside
// it until it passes its gates (a real chunk, 20 records, both browsers).
// Three ways to turn it on, in this order:
//
//   1. the build environment: VITE_LOCAL_AI_V2=1
//   2. this device:         localStorage['clinic.localAi.v2.enabled'] = '1'
//   3. the URL once:        ?localV2=1  (written to localStorage)
//
// Nothing is on by default.

export const FLAG_KEY = 'clinic.localAi.v2.enabled';

function storage() {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch {
        return null;
    }
}

function envFlag() {
    try {
        return String(import.meta?.env?.VITE_LOCAL_AI_V2 ?? '') === '1';
    } catch {
        return false;
    }
}

function queryFlag() {
    try {
        const search = String(globalThis.location?.search ?? '');
        if (!search) return null;
        const value = new URLSearchParams(search).get('localV2');
        if (value === null) return null;
        return value === '1' || value === 'true';
    } catch {
        return null;
    }
}

/** Read the URL switch once and remember it on this device. */
function adoptQueryFlag() {
    const fromQuery = queryFlag();
    if (fromQuery === null) return null;
    storage()?.setItem?.(FLAG_KEY, fromQuery ? '1' : '0');
    return fromQuery;
}

/** Is the v2 engine enabled on this device? */
export function v2Enabled() {
    if (envFlag()) return true;
    const adopted = adoptQueryFlag();
    if (adopted !== null) return adopted;
    return storage()?.getItem?.(FLAG_KEY) === '1';
}

/** Turn it on or off for this device (no server round trip). */
export function setV2Enabled(enabled) {
    storage()?.setItem?.(FLAG_KEY, enabled ? '1' : '0');
    return v2Enabled();
}

/**
 * v2 reads text documents only.
 *
 * The wizard uses this to refuse a photo before a job is created, instead of
 * failing mid-extraction. It is exported here so the sentence and the rule
 * live in one place.
 */
export function v2RefusesImages() {
    return v2Enabled();
}
