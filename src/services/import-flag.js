// The import agent runs the model on the device's own CPU. This module is the
// single client-side gate with two halves:
//   * can this browser run the pinned model at all (local check: WebAssembly
//     SIMD + OPFS; no request, nothing can change the answer), and
//   * did the admin switch the entry on for this browser (a local preference).
// The entry shows only when both are true.

function simdSupported() {
    try {
        // (func (result v128) (v128.const i32x4 0 0 0 0))
        const bytes = new Uint8Array([
            0, 97, 115, 109, 1, 0, 0, 0,
            1, 5, 1, 96, 0, 1, 123,
            3, 2, 1, 0,
            10, 10, 1, 8, 0, 0xfd, 0x0c, 0, 0, 0, 0, 0, 0x0b,
        ]);
        return WebAssembly.validate(bytes);
    } catch {
        return false;
    }
}

export function importSupported() {
    return typeof WebAssembly !== 'undefined'
        && simdSupported()
        && Boolean(navigator.storage?.getDirectory);
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
        localProfile: null,
        localConfig: null,
    };
}