// The inference worker.
//
// It hosts the model runtime so the interface stays responsive while a chunk
// is processed. The main thread sends { type, payload } and receives
// { type, result }.

import { initWllama, unloadWllama, isLoaded } from './wllama-provider.js';
import { initFalcon, ocrImageBitmap, unloadFalcon, isReady } from './falcon-ocr.js';

self.onmessage = async (event) => {
    const { id, type, payload } = event.data || {};
    const reply = (result, error) => self.postMessage({
        id, type, result, error: error ? String(error) : null,
    });
    try {
        switch (type) {
            case 'init-wllama':
                reply(await initWllama(payload.source, payload.options));
                break;
            case 'init-falcon':
                reply(await initFalcon(payload.blob, payload.support, payload.config, payload.tier));
                break;
            case 'ocr':
                reply(await ocrImageBitmap(payload.bitmap, payload.ocrConfig));
                break;
            case 'unload-wllama':
                await unloadWllama();
                reply({ ok: true });
                break;
            case 'unload-falcon':
                unloadFalcon();
                reply({ ok: true });
                break;
            case 'status':
                reply({ wllama: isLoaded(), falcon: isReady() });
                break;
            default:
                reply(null, `unknown message type: ${type}`);
        }
    } catch (error) {
        reply(null, error);
    }
};
