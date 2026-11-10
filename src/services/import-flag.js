// The import agent runs the model on the device's own CPU. This module is the
// single client-side gate: it reports whether this browser can run the pinned
// model at all. The check is local (WebAssembly SIMD + OPFS); no request is
// made and no setting can change the answer.

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

export async function loadImportEnabled() {
    return importSupported();
}

/** The engine is always the device's own CPU; only availability varies. */
export async function loadImportState() {
    const ok = importSupported();
    return {
        enabled: ok,
        engine: ok ? 'local' : 'off',
        localEnabled: ok,
        localProfile: null,
        localConfig: null,
    };
}