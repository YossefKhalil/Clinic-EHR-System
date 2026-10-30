// The local AI v2 model catalog.
//
// v2 runs models on WebGPU through MLC/WebLLM. Unlike the v1 engine (which
// loads GGUF files the clinic picked), v2 downloads a build that was compiled
// for WebLLM, so the app has to know what exists before it offers anything:
// the size, the context window and the licence all live here.
//
// Two kinds of entry:
//
//   1. `webllm` — a build that ships inside the pinned WebLLM release. Only
//      the id and the human metadata are stored; the download address, the
//      wasm library and the exact overrides are read from the installed
//      package at load time (see engine.js). That is what makes them safe:
//      a hand-copied `model_lib` URL is one release behind the runtime, and
//      the pair has to match.
//   2. `link` — a build the project links to directly, with its own two
//      addresses (the reference model is one).
//
// Anything else the clinic wants to try is a *custom* entry: it is not
// checked in, it lives in this browser's storage, and it carries its own two
// addresses. That is how a MiniCPM conversion — or any future MLC repo — is
// used without waiting for an app release.

import catalog from './catalog.json';

export const CATALOG_VERSION = catalog.catalogVersion;
export const WEBLLM_VERSION = catalog.webllmVersion;

/** Where the clinic's own entries are kept (this browser only). */
export const CUSTOM_KEY = 'clinic.localAi.v2.customModels';

function storage(store) {
    if (store) return store;
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch {
        // A browser with storage disabled throws on access, not on use.
        return null;
    }
}

/** Every model the app ships with, in the order the card offers them. */
export function models() {
    return catalog.models.slice();
}

/** The clinic's own entries, as saved (never throws on a bad value). */
export function loadCustomModels(store) {
    const raw = storage(store)?.getItem?.(CUSTOM_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((model) => model && typeof model.id === 'string');
    } catch {
        return [];
    }
}

function writeCustomModels(list, store) {
    storage(store)?.setItem?.(CUSTOM_KEY, JSON.stringify(list));
    return list;
}

/** Built-in entries first, then the clinic's own. */
export function allModels(store) {
    return models().concat(loadCustomModels(store));
}

/** One model by its MLC model id, or null. Built-in, then custom. */
export function modelById(id, store) {
    if (!id) return null;
    return models().find((model) => model.id === id)
        ?? loadCustomModels(store).find((model) => model.id === id)
        ?? null;
}

/** The entry the card offers first. */
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
 * The catalog can pin the answer (`requiresShaderF16`) for entries whose
 * runtime entry says so; otherwise the quant name decides.
 */
export function needsShaderF16(model) {
    if (typeof model?.requiresShaderF16 === 'boolean') return model.requiresShaderF16;
    return /f16/i.test(String(model?.quant ?? ''));
}

/**
 * Check and normalise an entry the clinic typed in.
 *
 * The two addresses are the whole contract: WebLLM appends
 * `/resolve/main/...` to the model address and fetches the wasm library
 * verbatim, so both have to be real URLs the browser may fetch. A value that
 * fails here is never stored, which keeps the engine from meeting a typo as
 * a 4 GB download that dies at the end.
 *
 * @returns {{ ok: boolean, model?: object, errors?: object }}
 */
export function validateCustomModel(input, store) {
    const errors = {};
    const id = String(input?.id ?? '').trim();
    const baseUrl = String(input?.baseUrl ?? '').trim().replace(/\/+$/, '');
    const modelLib = String(input?.modelLib ?? '').trim();
    const contextWindow = Number(input?.contextWindow);
    const downloadGb = input?.downloadGb === '' || input?.downloadGb == null ? 0 : Number(input.downloadGb);

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(id)) {
        errors.id = 'aiSettings.localV2.custom.error.id';
    } else if (models().some((model) => model.id === id)) {
        errors.id = 'aiSettings.localV2.custom.error.duplicate';
    }

    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
        errors.baseUrl = 'aiSettings.localV2.custom.error.repo';
    }
    if (!/^https?:\/\/[^\s]+\.wasm(\?.*)?$/.test(modelLib)) {
        errors.modelLib = 'aiSettings.localV2.custom.error.lib';
    }
    if (!Number.isFinite(contextWindow) || contextWindow < 512 || contextWindow > 1_048_576) {
        errors.contextWindow = 'aiSettings.localV2.custom.error.context';
    }
    if (!Number.isFinite(downloadGb) || downloadGb < 0) {
        errors.downloadGb = 'aiSettings.localV2.custom.error.size';
    }

    if (Object.keys(errors).length > 0) return { ok: false, errors };

    const name = String(input?.name ?? '').trim() || id;
    return {
        ok: true,
        model: {
            id,
            name,
            publisher: String(input?.publisher ?? '').trim() || 'Custom',
            license: 'Check the model card',
            source: 'custom',
            custom: true,
            baseUrl,
            modelLib,
            quant: String(input?.quant ?? '').trim() || guessQuant(id),
            contextWindow: Math.round(contextWindow),
            downloadGb: Number(downloadGb.toFixed(2)),
            vramEstimateMb: Math.round(Number(input?.vramEstimateMb) || 0),
            modalities: ['text'],
            reasoning: false,
            tier: 'custom',
            sampling: { temperature: 0.3, topP: 0.9, frequencyPenalty: 0.3 },
            notes: '',
        },
    };
}

function guessQuant(id) {
    const match = /-(q\d[a-z0-9_]*)-MLC$/i.exec(id);
    return match ? match[1] : 'q4f16_1';
}

/** Save a validated entry, replacing one with the same id. */
export function addCustomModel(model, store) {
    const list = loadCustomModels(store).filter((entry) => entry.id !== model.id);
    list.push(model);
    writeCustomModels(list, store);
    return model;
}

/** Forget one of the clinic's entries. */
export function removeCustomModel(id, store) {
    const list = loadCustomModels(store).filter((entry) => entry.id !== id);
    writeCustomModels(list, store);
    return list;
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
        if (needed > 0 && freeBytes < needed) {
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
