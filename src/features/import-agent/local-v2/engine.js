// The WebLLM engine seam.
//
// This is the only file in the app that imports `@mlc-ai/web-llm`. It is
// imported lazily (a dynamic import), so a clinic that never turns the local
// engine on never downloads the package.
//
// Everything the rest of v2 uses comes back through this small surface:
// load a catalog model, ask it for one chat completion, unload. Engine
// failures are mapped to codes here — once — so the settings card and the
// wizard translate a sentence instead of pattern-matching error text.

const PACKAGE = '@mlc-ai/web-llm';

/**
 * The default loader, replaceable in tests.
 *
 * The specifier is written out rather than stored in a variable so the
 * bundler can see it: a package name built at runtime would be left as a bare
 * import and fail in the browser. Being dynamic, it is still a separate chunk
 * — a clinic that never turns v2 on never downloads it.
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
 * The app config WebLLM needs for one catalog entry.
 *
 * The addresses come from the catalog, never from the user: a model build
 * only loads on the runtime it was compiled for, so this mapping is a
 * reviewed decision, not a setting.
 */
export function buildAppConfig(model) {
    return {
        model_list: [
            {
                model: model.baseUrl,
                model_id: model.id,
                model_lib: model.modelLib,
                overrides: { context_window_size: model.contextWindow },
            },
        ],
    };
}

/**
 * Map an engine failure onto a code the UI can translate.
 *
 * WebLLM surfaces device loss, allocation failures, download failures and
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
        { code: 'MODEL_DOWNLOAD_FAILED', test: /fetch|network|download|HTTP\s*(?:4\d\d|5\d\d)|CORS/i },
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
 * Load a catalog model into a WebLLM engine.
 *
 * `onProgress` receives the engine's own progress reports (download and
 * shader compilation), which is what the card shows while 4 GB arrive.
 *
 * @param {{ model: object, onProgress?: Function, loader?: Function }} input
 */
export async function createEngine(input) {
    const { model, onProgress } = input;
    if (!model?.id) throw engineError('MODEL_UNKNOWN', 'no catalog model');

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

    let raw;
    try {
        raw = await CreateMLCEngine(model.id, {
            appConfig: buildAppConfig(model),
            initProgressCallback: (report) => {
                onProgress?.({
                    phase: 'download',
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
