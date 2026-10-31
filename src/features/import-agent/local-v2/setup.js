// Load a model from a folder on this computer.
//
// The order matters: check the device, then the fit, then mount the folder,
// then load. A clinic on a laptop without WebGPU finds out in a second, and
// one whose build has no float16 shaders is told before shader compilation.
//
// No OCR, no projector — v2 reads text documents only.

import { assessFit, probeWebgpu, readCapacity } from './device.js';
import { createEngine } from './engine.js';
import { v2Error } from './errors.js';
import { mountModel } from './folder.js';
import { createWebLlmProvider } from './provider.js';
import { loadV2Profile, normalizeV2Profile } from './profile.js';

/**
 * What this computer can do with a model (or with none picked yet).
 *
 * Used by the settings card before anything loads, so the refusal is a
 * sentence with numbers instead of an engine error later.
 */
export async function probeV2Device(model = null, options = {}) {
    const device = await probeWebgpu(options.navigator);
    const capacity = await readCapacity(options.navigator);
    const fit = model
        ? assessFit(model, device, capacity)
        : (device.available
            ? { ok: true, code: null, params: {} }
            : { ok: false, code: device.code ?? 'WEBGPU_MISSING', params: {} });
    return { model, device, capacity, fit };
}

/**
 * Mount the folder, load the model, and wrap it in the provider the extractor
 * already talks to.
 *
 * `model` overrides the profile's model so the card can test a folder before
 * saving it; the profile still decides what an import would use.
 *
 * The mount is released on every failure path: a worker holding four
 * gigabytes of File references after a failed load is a leak the clinic
 * cannot see.
 *
 * @param {{ folder?: object, model?: object, profile?: object, onProgress?: Function, loader?: Function, mountOptions?: object }} [input]
 */
export async function setupLocalV2(input = {}) {
    const model = input.model;
    if (!model?.id) throw v2Error('MODEL_UNKNOWN', 'no model folder');
    if (!model.hasLibrary) throw v2Error('MODEL_NOT_LOCAL', 'the folder has no .wasm library');

    const requested = loadV2Profile();
    const profile = normalizeV2Profile(
        { ...(input.profile ?? requested), modelId: model.id },
        model.contextWindow,
    );

    const { device, capacity, fit } = await probeV2Device(model);
    if (!fit.ok) {
        // The code and its values travel with the error: the card renders
        // "about 5.2 GB, this computer reports 4 GB" instead of a bare code.
        throw v2Error(fit.code, fit.code, fit.params);
    }

    input.onProgress?.({ phase: 'mounting', model: model.id });
    const mounted = await mountModel(
        { files: input.folder?.files ?? [], modelLibFile: input.folder?.library ?? null },
        input.mountOptions,
    );
    const mountedModel = {
        ...model,
        baseUrl: mounted.baseUrl,
        modelLib: `${mounted.baseUrl}${encodeURIComponent(model.libName)}`,
    };

    try {
        input.onProgress?.({ phase: 'loading', model: model.id });
        const engine = await createEngine({
            model: mountedModel,
            contextWindow: profile.contextWindow,
            loader: input.loader,
            onProgress: (report) => input.onProgress?.(report),
        });
        const provider = createWebLlmProvider({ engine, model: mountedModel });

        return {
            provider,
            engine,
            model: mountedModel,
            profile,
            device,
            capacity,
            fit,
            unload: async () => {
                await engine.unload();
                mounted.unmount();
            },
        };
    } catch (failure) {
        mounted.unmount();
        throw failure;
    }
}
