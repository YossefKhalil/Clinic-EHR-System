// The WebLLM engine seam.
//
// This is the only file in the app that imports `@mlc-ai/web-llm`. It is
// imported lazily (a dynamic import), so a clinic that never turns the local
// engine on never downloads the package.
//
// Everything the rest of v2 uses comes back through this small surface:
// load a model, ask it for one chat completion, unload. Engine failures are
// mapped to codes here — once — so the settings card and the wizard
// translate a sentence instead of pattern-matching error text.

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
 * The app config WebLLM needs for one model.
 *
 * Two sources, in this order:
 *
 *   - the entry carries its own addresses (`link` and `custom` entries), so
 *     they are used as given;
 *   - otherwise the model id is looked up in the installed package's own
 *     prebuilt list, and that entry is copied wholesale — download address,
 *     wasm library, buffer sizes, required features and the overrides the
 *     build needs (stop tokens, history depth). A hand-written copy of those
 *     URLs drifts one release behind the runtime; this cannot.
 *
 * The context window is the one thing the app overrides, because the clinic
 * can lower it in the card.
 *
 * @throws when a built-in id is not in the installed WebLLM release.
 */
export function buildAppConfig(model, prebuiltList = [], contextWindow) {
    const context = Math.round(Number(contextWindow) || Number(model?.contextWindow) || 4096);

    if (model?.baseUrl && model?.modelLib) {
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

    const entry = (prebuiltList ?? []).find((candidate) => candidate?.model_id === model?.id);
    if (!entry) {
        throw engineError('MODEL_NOT_IN_RUNTIME', `${model?.id ?? 'model'} is not in WebLLM ${PACKAGE}`);
    }
    return {
        model_list: [
            {
                ...entry,
                overrides: { ...(entry.overrides ?? {}), context_window_size: context },
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
 * Load a model into a WebLLM engine.
 *
 * `onProgress` receives the engine's own progress reports (download and
 * shader compilation), which is what the card shows while gigabytes arrive.
 *
 * @param {{ model: object, contextWindow?: number, onProgress?: Function, loader?: Function }} input
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

    const prebuilt = module?.prebuiltAppConfig?.model_list
        ?? module?.default?.prebuiltAppConfig?.model_list
        ?? [];

    let appConfig;
    try {
        appConfig = buildAppConfig(model, prebuilt, input.contextWindow);
    } catch (error) {
        // A built-in entry that the pinned release no longer ships is a
        // mismatch, not a download problem: say so before any traffic.
        throw error?.code === 'MODEL_NOT_IN_RUNTIME' ? error : mapEngineError(error);
    }

    let raw;
    try {
        raw = await CreateMLCEngine(model.id, {
            appConfig,
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
