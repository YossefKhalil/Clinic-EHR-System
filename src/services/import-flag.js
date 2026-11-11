// The import agent runs the model on the device's own CPU. This module is the
// single client-side gate with two halves:
//   * can this browser run the pinned model at all (local check: WebAssembly
//     SIMD; no request, nothing can change the answer), and
//   * did the admin switch the entry on for this browser (a local preference).
// The entry shows only when both are true. OPFS is reported separately because
// it is only needed to download and keep the model, not to run it.

function simdSupported() {
    try {
        // (func (result v128) (i32x4.splat (i32.const 0)) ...)
        // A v128.const needs a 16-byte immediate; this module is the tiny
        // validation module from the wasm-feature-detect suite, which is
        // known-good, so a false answer means the browser really lacks SIMD.
        const bytes = new Uint8Array([
            0, 97, 115, 109, 1, 0, 0, 0,
            1, 5, 1, 96, 0, 1, 123,
            3, 2, 1, 0,
            10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
        ]);
        return WebAssembly.validate(bytes);
    } catch {
        return false;
    }
}

export function importSupported() {
    return typeof WebAssembly !== 'undefined' && simdSupported();
}

/** OPFS keeps the model; Cache Storage is the fallback on older Chromium. */
export function importStorageSupported() {
    return Boolean(navigator.storage?.getDirectory || globalThis.caches?.open);
}

export function clearImportFlagCache() {}

// The on/off switch in Settings -> AI & Import. It is a per-browser preference
// (no server row), so it is stored locally. It defaults to on: a capable
// browser shows the entry until someone turns it off.
const TOGGLE_KEY = 'clinic.aiImport.enabled';

export function readImportToggle() {
    try {
        const raw = localStorage.getItem(TOGGLE_KEY);
        return raw === null ? true : raw === '1';
    } catch {
        return true;
    }
}

export function writeImportToggle(on) {
    try {
        localStorage.setItem(TOGGLE_KEY, on ? '1' : '0');
    } catch {
        // A browser that blocks storage keeps the default (on).
    }
}

export async function loadImportEnabled() {
    return importSupported() && readImportToggle();
}

/** The engine is always the device's own CPU; only availability varies. */
export async function loadImportState() {
    const supported = importSupported();
    const on = readImportToggle();
    return {
        enabled: supported && on,
        engine: supported ? 'local' : 'off',
        localEnabled: supported,
        storage: importStorageSupported(),
        localProfile: null,
        localConfig: null,
    };
}