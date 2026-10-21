// Local model manifest and device probing.
//
// The manifest is the one place that knows which model files exist, how big
// they are and what their SHA-256 is, so the setup panel, the model store and
// the integrity check never disagree.
//
// The device probe answers the chips the settings card shows (WebGPU, cores,
// RAM, free disk) and suggests a tier. The suggestion is only a suggestion:
// the user always wins, because the only honest answer about a specific PC
// comes from running the model on it.

export const MANIFEST_VERSION = 1;

export const MODEL_FILES = {
    minicpm: {
        id: 'minicpm5-1b-sft-q4km',
        label: 'MiniCPM5-1B-SFT (text extraction)',
        role: 'text',
        // The static Q4_K_M is the deployed default. wllama warns that imatrix
        // ("i1") quants can be slow and lower quality; that file stays
        // selectable as the tested alternative.
        files: [
            {
                name: 'MiniCPM5-1B-SFT.Q4_K_M.gguf',
                url: '/models/MiniCPM5-1B-SFT.Q4_K_M.gguf',
                size: 686149536,
                sha256: '',
                alt: {
                    name: 'MiniCPM5-1B-SFT.i1-Q4_K_M.gguf',
                    url: '/models/MiniCPM5-1B-SFT.i1-Q4_K_M.gguf',
                    size: 686149792,
                    sha256: '2818E3DDA38EFF3495DBB59749A3D626DE76B86BEEBB2415ED8E367BBC3728CE',
                },
            },
        ],
    },
    falcon: {
        id: 'falcon-ocr-q8',
        label: 'Falcon-OCR (image to text)',
        role: 'ocr',
        files: [
            { name: 'falcon_ocr_kv_token_q8.onnx', url: '/models/falcon_ocr_kv_token_q8.onnx', size: 450199845, sha256: '58449918A4313A69A5F5DA7C8001802F308347B23F3E9060786C115CD859F1E7' },
            { name: 'config.json', url: '/models/falcon-ocr/config.json', size: 746, sha256: '' },
            { name: 'tokenizer.json', url: '/models/falcon-ocr/tokenizer.json', size: 5063163, sha256: '' },
            { name: 'tokenizer_config.json', url: '/models/falcon-ocr/tokenizer_config.json', size: 4352, sha256: '' },
            { name: 'special_tokens_map.json', url: '/models/falcon-ocr/special_tokens_map.json', size: 9357, sha256: '' },
        ],
    },
};

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
 * RAM API, so the chips say "8 GB+ (reported)" rather than inventing a number.
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

/** The per-tier runtime defaults. Applied only where the user has no choice. */
export const TIER_CONFIG = {
    low: {
        stripW: 640, stripH: 224, stripOverlap: 48,
        imgLongSide: 896,
        contextTokens: 4096,
        threads: 2,
        batchSize: 256,
        maxNewTokensOcr: 256,
        maxOutputTokens: 2048,
        sheetRows: 4,
        textChunkTarget: 1000,
    },
    mid: {
        stripW: 896, stripH: 256, stripOverlap: 64,
        imgLongSide: 1280,
        contextTokens: 8192,
        threads: 4,
        batchSize: 512,
        maxNewTokensOcr: 512,
        maxOutputTokens: 4096,
        sheetRows: 5,
        textChunkTarget: 1200,
    },
    high: {
        stripW: 1024, stripH: 384, stripOverlap: 80,
        imgLongSide: 1536,
        contextTokens: 16384,
        threads: 6,
        batchSize: 512,
        maxNewTokensOcr: 768,
        maxOutputTokens: 8192,
        sheetRows: 6,
        textChunkTarget: 1500,
    },
};

/** The tier's runtime defaults. */
export function tierConfig(tier = 'mid') {
    return TIER_CONFIG[tier] ?? TIER_CONFIG.mid;
}

export function hasWebGPU() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
}

export async function webGPUAvailable() {
    if (!hasWebGPU()) return false;
    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        return !!adapter;
    } catch {
        return false;
    }
}
