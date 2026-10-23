// Model setup: load the models the clinic picked.
//
// Layout "single"  one multimodal GGUF in wllama. The images go to the model
//                  as image parts.
// Layout "split"   a text GGUF in wllama plus a vision model. The vision
//                  model reads the photos and the text model extracts the
//                  records.
//
// The vision model is loaded when the first photo needs it and released
// right after, so the two models are never resident at the same time on a
// small PC.

import { fileFromHandle } from './model-store.js';
import { initWllama, createLocalProvider, unloadWllama } from './wllama-provider.js';
import { initFalcon, ocrImageBitmap, unloadFalcon } from './falcon-ocr.js';
import { probeModelFile } from './adapters.js';
import { resolveLocalConfig } from './local-config.js';

function error(code, message) {
    const err = new Error(message || code);
    err.code = code;
    // The wizard translates the chunk errors; a raw setup message ("the file
    // is not reachable") is not shown directly to the clinic.
    err.messageKey = `importAgent.chunkError.${code}`;
    return err;
}

/**
 * Check a model file before it is loaded.
 *
 * The header is read, not the weights: a file that cannot be used is
 * refused here with a code, not after a 686 MB download.
 */
async function probe(file) {
    const result = await probeModelFile(file);
    if (!result.ok) throw error(result.code, result.detail);
    return result;
}

/**
 * Load the models of a profile.
 *
 * @param {{ profile: object, config?: object, tier?: string,
 *           onProgress?: (role: string, loaded: number, total: number) => void,
 *           capabilities?: object }} input
 */
export async function setupLocalModels(input) {
    const { profile, tier = 'mid' } = input;
    if (!profile) throw error('NO_MODEL_PROFILE', 'no model profile');
    const { config } = resolveLocalConfig(tier, input.config || {});

    if (profile.mode === 'single') {
        const file = await fileFromHandle(profile.multimodal?.handle);
        if (!file) throw error('MODEL_FILE_UNAVAILABLE', 'the multimodal model file is not reachable');
        const capabilities = await probe(file);
        await initWllama(
            { file, label: profile.multimodal.name },
            { config, tier, capabilities, onProgress: (loaded, total) => input.onProgress?.('text', loaded, total) },
        );
        return {
            mode: 'single',
            provider: createLocalProvider(),
            ocr: null,
            config,
            unload: async () => { await unloadWllama(); },
        };
    }

    // Layout "split".
    const textFile = await fileFromHandle(profile.text?.handle);
    if (!textFile) throw error('TEXT_MODEL_UNAVAILABLE', 'the text model file is not reachable');
    const textCapabilities = await probe(textFile);

    // Vision is optional in split mode - only needed for images.
    let visionFile = null;
    let visionReady = false;
    if (profile.vision?.handle) {
        visionFile = await fileFromHandle(profile.vision.handle);
        if (visionFile) {
            if (!String(visionFile.name).toLowerCase().endsWith('.onnx')) {
                throw error('VISION_GGUF_UNSUPPORTED', 'the split layout needs an ONNX vision model');
            }
            if (!profile.support?.files) {
                throw error('OCR_SUPPORT_FILES_MISSING', 'the tokenizer and config files are missing for the vision model');
            }
            await probe(visionFile);
        }
    }

    await initWllama(
        { file: textFile, label: profile.text.name },
        { config, tier, capabilities: textCapabilities, onProgress: (loaded, total) => input.onProgress?.('text', loaded, total) },
    );
    const provider = createLocalProvider();

    const ensureVision = async () => {
        if (!visionFile) {
            throw error('VISION_MODEL_MISSING', 'no vision model configured for this import');
        }
        if (visionReady) return;
        await initFalcon(visionFile, profile.support, config, tier, (loaded, total) => {
            input.onProgress?.('vision', loaded, total);
        });
        visionReady = true;
    };

    const ocr = async (chunk, onProgress) => {
        await ensureVision();
        const lines = [];
        const images = Array.isArray(chunk.images) ? chunk.images : [];
        for (let index = 0; index < images.length; index += 1) {
            onProgress?.({ phase: 'ocr_image', index, total: images.length });
            const url = typeof images[index] === 'string' ? images[index] : (images[index].dataUrl || images[index].url);
            const response = await fetch(url);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
            const result = await ocrImageBitmap(bitmap, config.ocr);
            for (const line of result.lines) lines.push(line.text);
            bitmap.close();
        }
        // The vision model is released before the text extraction resumes.
        unloadFalcon();
        visionReady = false;
        return lines;
    };

    return {
        mode: 'split',
        provider,
        ocr,
        config,
        unload: async () => { await unloadWllama(); unloadFalcon(); },
    };
}
