// The WebLLM engine seam.
//
// This is the only file in the app that imports `@mlc-ai/web-llm`. It is
// imported lazily (a dynamic import), so a clinic that never opens the local
// card never downloads the package.
//
// The engine loads a model from an address, exactly as it would load a hosted
// one. Here that address points at the folder the clinic picked: the service
// worker in `public/local-mlc-sw.js` answers it from disk.
//
// Everything the rest of v2 uses comes back through this small surface: load
// a model, ask it for one chat completion, unload. Engine failures are mapped
// to codes here — once — so the settings card and the wizard translate a
// sentence instead of pattern-matching error text.

const PACKAGE = '@mlc-ai/web-llm';

/**
 * The default loader, replaceable in tests.
 *
 * The specifier is written out rather than stored in a variable so the
 * bundler can see it: a package name built at runtime would be left as a bare
 * import and fail in the browser. Being dynamic, it is still a separate chunk
 * — a clinic that never opens the card never downloads it.
 */
export function defaultLoader() {
    return import('@mlc-ai/web-llm');
}

function engineError(code, message, cause) {
    const error = new Error(message || code);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
}

/**
 * The app config WebLLM needs for the picked folder.
 *
 * Both addresses come from the worker mount, so they point at this computer:
 * the base for the config, the shards and the tokenizer, and the `.wasm`
 * library inside the same mount. The clinic's context window is the one
 * override, because the folder's own window is the maximum, not the choice.
 *
 * @throws when the folder was not mounted or has no library.
 */
export function buildAppConfig(model, contextWindow) {
    if (!model?.baseUrl || !model?.modelLib) {
        throw engineError('MODEL_NOT_LOCAL', 'a local model needs a mounted folder and a .wasm library');
    }
    const context = Math.round(Number(contextWindow) || Number(model.contextWindow) || 4096);
    return {
        model_list: [
            {
                model: model.baseUrl,
                model_id: model.id,
                model_lib: model.modelLib,
                overrides: { context_window_size: context },
            },
        ],
    };
}

/**
 * Map an engine failure onto a code the UI can translate.
 *
 * WebLLM surfaces device loss, allocation failures, a missing file and
 * runtime/model mismatches as plain Error messages with no code, so the
 * mapping is by text — kept in one place (see #53 for why: an opaque engine
 * error used to reach the review screen as "PROVIDER_ERROR").
 */
export function mapEngineError(error) {
    if (error?.code && String(error.code).startsWith('WEBGPU_')) return error;
    const message = String(error?.message ?? error ?? '');

    const table = [
        { code: 'WEBGPU_DEVICE_LOST', test: /device\s+(?:is\s+)?lost|lost\s+device|GPUDevice.*destroyed/i },
        { code: 'GPU_OUT_OF_MEMORY', test: /out of memory|OOM|insufficient (?:GPU )?memory|failed to allocate|allocation failed/i },
        { code: 'CONTEXT_TOO_SMALL', test: /context (?:window|length|size).*(?:exceed|too small|overflow)|exceeds? the context|prompt is too long/i },
        { code: 'MODEL_LIBRARY_MISMATCH', test: /tensor-cache|ndarray-cache|model_lib|record.*not found|cannot find.*(?:model|library)/i },
        { code: 'MODEL_DOWNLOAD_FAILED', test: /fetch|network|download|HTTP\s*(?:4\d\d|5\d\d)|CORS|not mounted/i },
        { code: 'WEBGPU_MISSING', test: /webgpu|navigator\.gpu|no adapter|requestAdapter/i },
    ];

    for (const entry of table) {
        if (entry.test.test(message)) {
            return engineError(entry.code, message, error);
        }
    }
    return engineError('LOCAL_ENGINE_ERROR', message, error);
}

/**
 * Load a model into a WebLLM engine.
 *
 * `onProgress` receives the engine's own progress reports (reading the files,
 * compiling shaders), which is what the card shows while a model loads.
 *
 * @param {{ model: object, contextWindow?: number, onProgress?: Function, loader?: Function }} input
 */
export async function createEngine(input) {
    const { model, onProgress } = input;
    if (!model?.id) throw engineError('MODEL_UNKNOWN', 'no model folder');

    const load = input.loader ?? defaultLoader;
    let module;
    try {
        module = await load();
    } catch (error) {
        throw engineError('WEBLLM_PACKAGE_MISSING', `could not load ${PACKAGE}`, error);
    }
    const CreateMLCEngine = module?.CreateMLCEngine ?? module?.default?.CreateMLCEngine;
    if (typeof CreateMLCEngine !== 'function') {
        throw engineError('WEBLLM_PACKAGE_MISSING', `${PACKAGE} does not export CreateMLCEngine`);
    }

    let appConfig;
    try {
        appConfig = buildAppConfig(model, input.contextWindow);
    } catch (error) {
        throw error?.code === 'MODEL_NOT_LOCAL' ? error : mapEngineError(error);
    }

    let raw;
    try {
        raw = await CreateMLCEngine(model.id, {
            appConfig,
            initProgressCallback: (report) => {
                onProgress?.({
                    phase: 'loading',
                    text: String(report?.text ?? ''),
                    progress: Number(report?.progress) || 0,
                });
            },
        });
    } catch (error) {
        throw mapEngineError(error);
    }

    return {
        model,
        raw,
        /**
         * One chat completion. The messages are already OpenAI-shaped, which
         * is what both engines accept; it keeps the provider honest.
         */
        async chat(request) {
            if (!raw?.chat?.completions?.create) {
                throw engineError('LOCAL_ENGINE_ERROR', 'the engine has no chat API');
            }
            try {
                return await raw.chat.completions.create({ ...request, stream: false });
            } catch (error) {
                throw mapEngineError(error);
            }
        },
        async unload() {
            try {
                await raw?.unload?.();
            } catch {
                // The engine is going away anyway; a failed unload must not
                // turn into a failed settings save.
            }
        },
    };
}
