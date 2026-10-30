// Load a v2 model.
//
// The order matters: check the device, then the fit, then download. A clinic
// on a laptop without WebGPU finds out in a second, and one without the disk
// space is told the two numbers before 4 GB start moving.
//
// No OCR, no projector, no file picking — v2 reads text documents only.

import { assessFit, defaultModel, modelById, probeWebgpu, readCapacity } from './catalog.js';
import { createEngine } from './engine.js';
import { v2Error } from './errors.js';
import { createWebLlmProvider } from './provider.js';
import { loadV2Profile, normalizeV2Profile } from './profile.js';

/**
 * What this device can do with the catalog.
 *
 * Used by the settings card before anything is downloaded, so the refusal is
 * a sentence with numbers instead of an engine error later.
 */
export async function probeV2Device(model = defaultModel(), options = {}) {
    const device = await probeWebgpu(options.navigator);
    const capacity = await readCapacity(options.navigator);
    return { model, device, capacity, fit: assessFit(model, device, capacity) };
}

/**
 * Load the model the profile names and wrap it in the provider the extractor
 * already talks to.
 *
 * @param {{ profile?: object, onProgress?: Function, loader?: Function }} [input]
 */
export async function setupLocalV2(input = {}) {
    const profile = normalizeV2Profile(input.profile ?? loadV2Profile());
    const model = modelById(profile.modelId) ?? defaultModel();
    if (!model) throw v2Error('MODEL_UNKNOWN', 'the catalog is empty');

    const { device, capacity, fit } = await probeV2Device(model);
    if (!fit.ok) {
        // The code and its values travel with the error: the card renders
        // "about 5.2 GB, this device reports 4 GB" instead of a bare code.
        throw v2Error(fit.code, fit.code, fit.params);
    }

    input.onProgress?.({ phase: 'loading', model: model.id });
    const engine = await createEngine({
        model,
        loader: input.loader,
        onProgress: (report) => input.onProgress?.(report),
    });
    const provider = createWebLlmProvider({ engine, model });

    return {
        provider,
        engine,
        model,
        profile,
        device,
        capacity,
        fit,
        unload: async () => { await engine.unload(); },
    };
}
