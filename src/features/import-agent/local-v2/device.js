// What this computer can do, and whether a model folder will fit.
//
// The card asks these questions before a model is loaded, so a laptop without
// WebGPU, or one whose GPU has no float16 shaders, is told in a second instead
// of after shader compilation.

/** Plain sizes for the card: "4.4 GB". */
export function formatGb(bytes) {
    const gb = Number(bytes) / 1e9;
    if (!Number.isFinite(gb) || gb <= 0) return '0 GB';
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

/** Does this quantisation need the `shader-f16` WebGPU feature? */
export function needsShaderF16(model) {
    if (typeof model?.requiresShaderF16 === 'boolean') return model.requiresShaderF16;
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
 * What the platform will report about this machine.
 *
 * WebGPU has no API for video memory, so this reads reported device memory
 * and the origin's storage figures. Both are best-effort: a browser that
 * reports nothing must not be treated as a machine with nothing.
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
 * Pure, so the card and the tests can ask without a GPU. `model.bytes` is the
 * size of the folder that was picked, which is what the weights cost; the KV
 * cache and the browser's own buffers ride on top, and the estimate in
 * `model.vramEstimateMb` already allows for that.
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
    if (ramGb && neededMb && ramGb * 1024 < neededMb * 1.4) {
        return {
            ok: false,
            code: 'DEVICE_RAM_SHORT',
            params: { needGb: ((neededMb * 1.4) / 1024).toFixed(1), haveGb: String(ramGb) },
        };
    }

    return { ok: true, code: null, params: {} };
}
