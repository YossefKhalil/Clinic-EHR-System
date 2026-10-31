// Every failure v2 can report, and the sentence key that explains it.
//
// One table, used by the engine wrapper, the setup path and the settings
// card. A code that is not here falls back to a generic sentence, and the raw
// message stays in `error.message` for the "technical details" disclosure.
//
// The sentences live in src/locales/{en,ar}.json under aiSettings.localV2.

export const V2_ERROR_KEYS = Object.freeze({
    WEBGPU_MISSING: 'aiSettings.localV2.error.webgpuMissing',
    WEBGPU_ADAPTER_MISSING: 'aiSettings.localV2.error.webgpuAdapterMissing',
    WEBGPU_SHADER_F16_MISSING: 'aiSettings.localV2.error.webgpuShaderF16',
    WEBGPU_DEVICE_LOST: 'aiSettings.localV2.error.deviceLost',
    GPU_OUT_OF_MEMORY: 'aiSettings.localV2.error.outOfMemory',
    DEVICE_RAM_SHORT: 'aiSettings.localV2.error.ramShort',
    CONTEXT_TOO_SMALL: 'aiSettings.localV2.error.contextTooSmall',
    MODEL_DOWNLOAD_FAILED: 'aiSettings.localV2.error.downloadFailed',
    MODEL_LIBRARY_MISMATCH: 'aiSettings.localV2.error.libraryMismatch',
    MODEL_NOT_MULTIMODAL: 'aiSettings.localV2.error.textOnly',
    MODEL_UNKNOWN: 'aiSettings.localV2.error.modelUnknown',
    MODEL_NOT_LOCAL: 'aiSettings.localV2.folder.error.noWasm',
    SERVICE_WORKER_MISSING: 'aiSettings.localV2.folder.error.worker',
    SERVICE_WORKER_TIMEOUT: 'aiSettings.localV2.folder.error.mount',
    WEBLLM_PACKAGE_MISSING: 'aiSettings.localV2.error.packageMissing',
    LOCAL_ENGINE_ERROR: 'aiSettings.localV2.error.generic',
});

export const V2_ERROR_CODES = Object.freeze(Object.keys(V2_ERROR_KEYS));

/** The translation key for a code. */
export function v2ErrorKey(code) {
    return V2_ERROR_KEYS[code] ?? V2_ERROR_KEYS.LOCAL_ENGINE_ERROR;
}

/**
 * Build an error that carries its code and the values a sentence needs.
 *
 * @param {string} code one of V2_ERROR_CODES
 * @param {string} [message] the technical detail (never the visible text)
 * @param {object} [params] values interpolated into the sentence
 */
export function v2Error(code, message = '', params = {}) {
    const error = new Error(message || code);
    error.code = code;
    error.params = params;
    error.key = v2ErrorKey(code);
    return error;
}
