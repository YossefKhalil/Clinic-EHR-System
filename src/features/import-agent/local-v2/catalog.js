// The local AI v2 model catalog.
//
// v2 runs models on WebGPU through MLC/WebLLM. Unlike the v1 engine (which
// loads GGUF files the clinic picked), v2 downloads a build that was compiled
// for WebLLM, so the app has to know what exists before it offers anything:
// the address, the size, the context window and the licence all live here.
//
// This file is the checked-in list (like `local/architectures.json`), not a
// live query. Upgrading the WebLLM package is a reviewed diff of this JSON
// plus the dependency, because a model build only loads on a runtime whose
// tvmjs release matches the one it was compiled with.

import catalog from './catalog.json';

export const CATALOG_VERSION = catalog.catalogVersion;
export const WEBLLM_VERSION = catalog.webllmVersion;

/** Every model the app knows about. */
export function models() {
    return catalog.models.slice();
}

/** One model by its MLC model id, or null. */
export function modelById(id) {
    return catalog.models.find((model) => model.id === id) ?? null;
}

/** The entry the download card offers first. */
export function defaultModel() {
    return catalog.models[0] ?? null;
}

/** Approximate download size in bytes (the catalog stores gigabytes). */
export function modelBytes(model) {
    return Math.round(Number(model?.downloadGb || 0) * 1e9);
}

/** Plain sizes for the card: "4.4 GB". */
export function formatGb(bytes) {
    const gb = Number(bytes) / 1e9;
    if (!Number.isFinite(gb) || gb <= 0) return '0 GB';
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

/**
 * Does this quantisation need the `shader-f16` WebGPU feature?
 *
 * A q4f16_1 build stores weights in float16 and refuses to load without it.
 * The catalog can carry a q4f32_1 alternative later; until then the refusal
 * has to be honest and early.
 */
export function needsShaderF16(model) {
    return /f16/i.test(String(model?.quant ?? ''));
}

/**
 * Ask the browser what its GPU can do.
 *
 * `adapter.info` is optional in the WebGPU spec (it was `requestAdapterInfo`
 * before), so every field here is best-effort. Both a missing `navigator.gpu`
 * and a null adapter are refusals: the engine cannot run either way.
 */
export async function probeWebgpu(nav = typeof navigator === 'undefined' ? null : navigator) {
    const gpu = nav?.gpu;
    if (!gpu) return { available: false, code: 'WEBGPU_MISSING' };

    let adapter = null;
    try {
        adapter = await gpu.requestAdapter();
    } catch {
        adapter = null;
    }
    if (!adapter) return { available: false, code: 'WEBGPU_ADAPTER_MISSING' };

    const features = Array.from(adapter.features ?? []);
    const info = adapter.info ?? {};
    return {
        available: true,
        code: null,
        vendor: String(info.vendor ?? ''),
        architecture: String(info.architecture ?? ''),
        device: String(info.device ?? ''),
        description: String(info.description ?? ''),
        features,
        shaderF16: features.includes('shader-f16'),
        maxBufferSize: Number(adapter.limits?.maxBufferSize) || 0,
        maxStorageBufferBindingSize: Number(adapter.limits?.maxStorageBufferBindingSize) || 0,
    };
}

/**
 * What the device can spare.
 *
 * WebGPU has no API for video memory, so this reads the two numbers the
 * platform does expose — reported device memory and the origin's storage
 * quota — and leaves the VRAM estimate to `assessFit`.
 */
export async function readCapacity(nav = typeof navigator === 'undefined' ? null : navigator) {
    const deviceMemoryGb = Number(nav?.deviceMemory) || 0;
    let quotaBytes = null;
    let usageBytes = null;
    try {
        const estimate = await nav?.storage?.estimate?.();
        if (estimate && Number.isFinite(estimate.quota)) {
            quotaBytes = Number(estimate.quota);
            usageBytes = Number(estimate.usage) || 0;
        }
    } catch {
        quotaBytes = null;
    }
    return {
        deviceMemoryGb,
        quotaBytes,
        usageBytes,
        freeBytes: quotaBytes === null ? null : Math.max(0, quotaBytes - usageBytes),
    };
}

/**
 * Can this device run this model?
 *
 * Pure so the card (and the tests) can ask without a GPU. The result is the
 * refusal the clinic sees, not an exception.
 *
 * @returns {{ ok: boolean, code: string|null, params: object }}
 */
export function assessFit(model, device, capacity = null) {
    if (!model) return { ok: false, code: 'MODEL_UNKNOWN', params: {} };
    if (!device?.available) {
        return { ok: false, code: device?.code ?? 'WEBGPU_MISSING', params: {} };
    }
    if (needsShaderF16(model) && !device.shaderF16) {
        return { ok: false, code: 'WEBGPU_SHADER_F16_MISSING', params: { quant: model.quant } };
    }

    const neededMb = Number(model.vramEstimateMb) || 0;
    const ramGb = Number(capacity?.deviceMemoryGb) || 0;
    // The weights are not the whole cost: the KV cache and the browser's own
    // buffers ride on top. 1.4x is the headroom the plan asks for.
    if (ramGb && neededMb && ramGb * 1024 < neededMb * 1.4) {
        return {
            ok: false,
            code: 'DEVICE_RAM_SHORT',
            params: { needGb: ((neededMb * 1.4) / 1024).toFixed(1), haveGb: String(ramGb) },
        };
    }

    // A browser that will not report a quota must not be treated as a device
    // with zero free space.
    const freeBytes = capacity?.freeBytes;
    if (typeof freeBytes === 'number' && Number.isFinite(freeBytes)) {
        const needed = modelBytes(model) * 1.2;
        if (freeBytes < needed) {
            return {
                ok: false,
                code: 'STORAGE_SHORT',
                params: {
                    needGb: formatGb(needed).replace(' GB', ''),
                    freeGb: formatGb(freeBytes).replace(' GB', ''),
                },
            };
        }
    }

    return { ok: true, code: null, params: {} };
}
