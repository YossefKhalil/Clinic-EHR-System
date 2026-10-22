// Device probing for the local engine.
//
// The settings card shows what the device can do, and the probe suggests a
// tier. The suggestion is only a suggestion: the user always wins, because
// the only honest answer about a specific PC comes from running the model
// on it.

/** The files a vision model needs beside the graph itself. */
export const OCR_SUPPORT_FILES = Object.freeze([
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'config.json',
]);

/**
 * The tier is a *suggestion* derived from what the browser exposes.
 *
 * `navigator.deviceMemory` is capped at 8 by every browser, so "8 GB" means
 * "8 GB or more" and nothing finer. The WebGPU adapter limits are the more
 * useful signal: they say how much a single buffer may be, which is what
 * decides whether a model fits.
 */
export function deviceTier(info = {}) {
    const cores = Number(info.threads ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0)) || 0;
    const memory = Number(info.memory ?? (typeof navigator !== 'undefined' ? navigator.deviceMemory : 0)) || 0;
    const webgpu = info.webgpu === true;
    const maxBuffer = Number(info.maxBufferSize ?? 0) || 0;

    if (!webgpu || cores < 4) return 'low';
    if (cores >= 8 && memory >= 8 && maxBuffer >= 256 * 1024 * 1024) return 'high';
    return 'mid';
}

/**
 * Read what the device can tell us and suggest a tier.
 *
 * Only measurable signals are used: there is no AC-power API and no exact
 * RAM API, so the chips say "8 GB+ (reported)" rather than inventing a
 * number.
 */
export async function probeDevice() {
    const info = {
        webgpu: false,
        adapter: null,
        maxBufferSize: 0,
        maxStorageBufferBindingSize: 0,
        threads: Number((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0) || 0,
        memory: Number((typeof navigator !== 'undefined' && navigator.deviceMemory) || 0) || 0,
        storageFree: 0,
        storageQuota: 0,
        tier: 'low',
        warnings: [],
    };

    if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (adapter) {
                info.webgpu = true;
                info.adapter = adapter.info?.vendor || adapter.info?.architecture || null;
                info.maxBufferSize = Number(adapter.limits?.maxBufferSize ?? 0) || 0;
                info.maxStorageBufferBindingSize = Number(adapter.limits?.maxStorageBufferBindingSize ?? 0) || 0;
            }
        } catch {
            info.webgpu = false;
        }
    } else {
        info.warnings.push('this browser has no WebGPU; local inference will be slow or unavailable');
    }

    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        try {
            const estimate = await navigator.storage.estimate();
            info.storageFree = Number(estimate.quota ?? 0) - Number(estimate.usage ?? 0);
            info.storageQuota = Number(estimate.quota ?? 0) || 0;
        } catch {
            info.storageFree = 0;
        }
    }

    info.tier = deviceTier(info);
    return info;
}
