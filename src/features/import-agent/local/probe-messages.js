// Probe messages.
//
// Every refusal the capability probe can return has a locale key, so the
// settings card can say what is wrong in the language of the clinic instead
// of printing the code and an English sentence. The raw `detail` stays on the
// result for diagnostics; it is never the message the card shows.
//
// This module is intentionally dependency-free: the i18n checker imports it
// from Node, so it must not touch the DOM or Vite-only modules.

/** The locale key of every probe code the settings card can display. */
export const PROBE_MESSAGE_KEYS = Object.freeze({
    GGUF_ARCH_UNSUPPORTED: 'aiSettings.local.probe.GGUF_ARCH_UNSUPPORTED',
    GGUF_TEMPLATE_MISSING: 'aiSettings.local.probe.GGUF_TEMPLATE_MISSING',
    GGUF_MAGIC_INVALID: 'aiSettings.local.probe.GGUF_MAGIC_INVALID',
    GGUF_TRUNCATED: 'aiSettings.local.probe.GGUF_TRUNCATED',
    VISION_GGUF_UNSUPPORTED: 'aiSettings.local.probe.VISION_GGUF_UNSUPPORTED',
    MMPROJ_INVALID: 'aiSettings.local.probe.MMPROJ_INVALID',
    ONNX_IO_UNMATCHED: 'aiSettings.local.probe.ONNX_IO_UNMATCHED',
    ONNX_OP_UNAVAILABLE: 'aiSettings.local.probe.ONNX_OP_UNAVAILABLE',
    ONNX_EXTERNAL_DATA_UNSUPPORTED: 'aiSettings.local.probe.ONNX_EXTERNAL_DATA_UNSUPPORTED',
    ONNX_MAGIC_INVALID: 'aiSettings.local.probe.ONNX_MAGIC_INVALID',
    ONNX_TRUNCATED: 'aiSettings.local.probe.ONNX_TRUNCATED',
    FILE_TYPE_UNKNOWN: 'aiSettings.local.probe.FILE_TYPE_UNKNOWN',
    FILE_MISMATCH: 'aiSettings.local.probe.FILE_MISMATCH',
    FILE_UNREADABLE: 'aiSettings.local.probe.FILE_UNREADABLE',
    ADAPTER_UNKNOWN: 'aiSettings.local.probe.ADAPTER_UNKNOWN',
    PROBE_FAILED: 'aiSettings.local.probe.PROBE_FAILED',
    MODEL_KIND_MISMATCH: 'aiSettings.local.probe.MODEL_KIND_MISMATCH',
    MODEL_HASH_MISMATCH: 'aiSettings.local.probe.MODEL_HASH_MISMATCH',
    MODEL_FILE_UNAVAILABLE: 'aiSettings.local.probe.MODEL_FILE_UNAVAILABLE',
    MODEL_FILE_MISSING: 'aiSettings.local.probe.MODEL_FILE_MISSING',
    MODEL_PROFILE_HANDLE_MISSING: 'aiSettings.local.probe.MODEL_PROFILE_HANDLE_MISSING',
    MODEL_FILE_UNREACHABLE: 'aiSettings.local.probe.MODEL_FILE_UNREACHABLE',
    OCR_SUPPORT_FILES_MISSING: 'aiSettings.local.probe.OCR_SUPPORT_FILES_MISSING',
    NO_MODEL_PROFILE: 'aiSettings.local.probe.NO_MODEL_PROFILE',
});

/** The key for a code, or null when the code has no dedicated message. */
export function probeMessageKey(code) {
    const value = String(code ?? '');
    return PROBE_MESSAGE_KEYS[value] ?? null;
}

/** Human-readable size, stable across browsers and Node. */
export function formatBytes(bytes) {
    const number = Number(bytes);
    if (!Number.isFinite(number) || number <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = number;
    let index = 0;
    while (value >= 1000 && index < units.length - 1) {
        value /= 1000;
        index += 1;
    }
    return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/**
 * The parameters a probe message needs.
 *
 * A refusal carries the values it already knows (`params`); the generic
 * fields (`architecture`, the read/total size) fill any gap so a caller that
 * only kept the code can still render a useful sentence.
 */
export function probeMessageParams(result) {
    const params = { ...(result?.params ?? {}) };
    const architecture = result?.capabilities?.architecture ?? result?.architecture;
    if (architecture && params.architecture === undefined) params.architecture = architecture;
    if (params.architecture === undefined) params.architecture = '?';
    if (params.read === undefined) {
        params.read = result?.bytesConsumed ? formatBytes(result.bytesConsumed) : '?';
    }
    if (params.total === undefined) {
        params.total = result?.fileSize ? formatBytes(result.fileSize) : '?';
    }
    return params;
}

/**
 * Render a probe result in the caller's language.
 *
 * `t` is the app's translation function. An unknown code falls back to the
 * code and the raw detail, because a diagnostic is better than a blank line.
 */
export function formatProbeMessage(t, result) {
    const key = probeMessageKey(result?.code);
    if (key) return t(key, probeMessageParams(result));
    const code = String(result?.code ?? '');
    const detail = String(result?.message ?? result?.detail ?? '');
    if (code && detail) return `${code}: ${detail}`;
    return code || detail || '';
}
