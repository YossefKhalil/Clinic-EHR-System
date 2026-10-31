// Pick a model folder from this computer, check it, and serve it to the
// engine.
//
// Nothing is uploaded and nothing is downloaded. The page reads the files the
// clinic already has — an MLC model compiled for WebLLM: the chat config, the
// weight shards, the tokenizer and the wasm library — and a small service
// worker answers the engine's requests for them under a private path on this
// origin. From WebLLM's side it is an ordinary model served over HTTP.
//
// The directory picker (File System Access) is used where it exists and a
// `<input webkitdirectory>` where it does not, which is why this works in
// Firefox as well as Chrome.

export const SW_FILE = 'local-mlc-sw.js';
export const MODEL_PATH = '__local-mlc/';
const CONFIG_FILE = 'mlc-chat-config.json';

/** A folder name turned into a stable, readable id. */
export function slugify(value) {
    const slug = String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'local-model';
}

/** The file name a picked file is known by inside the mount. */
export function fileName(file) {
    const relative = String(file?.webkitRelativePath ?? '');
    return relative ? relative.split('/').pop() : String(file?.name ?? '');
}

function extensionOf(name) {
    return String(name).split('.').pop()?.toLowerCase() ?? '';
}

/** The quant a build folder is named after, when the config does not say. */
export function guessQuant(name) {
    const match = /-(q\d[a-z0-9_]*)-MLC$/i.exec(String(name));
    return match ? match[1] : '';
}

function clampWindow(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return 4096;
    return Math.min(Math.max(512, number), 1_048_576);
}

/**
 * Read a folder and decide what it contains.
 *
 * `entries` is anything array-like with `name`, `size` and (for the config)
 * `text()` — a File from the picker, or a plain object in a test. The result
 * never throws: a folder that is missing a piece comes back with the sentence
 * key that explains which piece.
 *
 * A folder without a `.wasm` library is still usable: the card offers the
 * library picker separately, because MLC ships the model and its wasm library
 * from two different places.
 *
 * @returns {{ ok: boolean, model?: object, errors: string[] }}
 */
export async function readModelFolder(entries, options = {}) {
    const files = (Array.isArray(entries) ? entries : []).filter(Boolean);
    const named = new Map();
    for (const file of files) {
        const name = fileName(file);
        if (name) named.set(name, file);
    }

    const folderName = String(options.folderName ?? '').trim() || 'Local model';
    const errors = [];

    const configFile = named.get(CONFIG_FILE);
    let config = null;
    if (!configFile) {
        errors.push('aiSettings.localV2.folder.error.noConfig');
    } else {
        try {
            const text = typeof configFile.text === 'function'
                ? await configFile.text()
                : String(configFile.text ?? '');
            config = JSON.parse(text);
        } catch {
            errors.push('aiSettings.localV2.folder.error.badConfig');
        }
    }

    const shards = [...named.keys()].filter((name) => /^params_shard_\d+\.bin$/.test(name));
    if (shards.length === 0 && !named.has('tensor-cache.json')) {
        errors.push('aiSettings.localV2.folder.error.noWeights');
    }

    if (!named.has('tokenizer.json') && !named.has('tokenizer.model')) {
        errors.push('aiSettings.localV2.folder.error.noTokenizer');
    }

    const libInFolder = [...named.keys()].find((name) => extensionOf(name) === 'wasm') ?? '';
    const library = options.modelLib ?? (libInFolder ? named.get(libInFolder) : null);
    const libName = fileName(library) || libInFolder;
    if (!libName) {
        // Only the library is missing: keep the model, the card asks for the
        // file instead of making the clinic pick the whole folder again.
        const blocking = errors.filter((key) => key !== 'aiSettings.localV2.folder.error.noWasm');
        if (blocking.length > 0) return { ok: false, errors: blocking };
        return { ok: true, errors: [], model: describe(files, { folderName, config, libName: '', hasLibrary: false }) };
    }

    if (errors.length > 0) return { ok: false, errors };

    return {
        ok: true,
        errors: [],
        model: describe(files, { folderName, config, libName, hasLibrary: true }),
    };
}

function describe(files, input) {
    const bytes = files.reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
    return {
        id: slugify(input.folderName),
        name: String(input.folderName),
        quant: String(input.config?.quantization ?? guessQuant(input.folderName)),
        contextWindow: clampWindow(input.config?.context_window_size ?? 4096),
        bytes,
        fileCount: files.length,
        // Weights, plus room for the KV cache at the build's own window.
        vramEstimateMb: Math.round((bytes / 1e6) * 1.2 + 512),
        libName: String(input.libName ?? ''),
        hasLibrary: Boolean(input.hasLibrary),
        modalities: ['text'],
    };
}

/** Where the worker lives, resolved against however the app is served. */
export function workerUrl(doc = typeof document === 'undefined' ? null : document) {
    const base = new URL('.', doc?.baseURI ?? 'http://localhost/');
    return new URL(SW_FILE, base).href;
}

/** Can this browser run the worker that serves local files? */
export function serviceWorkerSupported(nav = typeof navigator === 'undefined' ? null : navigator) {
    if (!nav?.serviceWorker) return false;
    return typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : true;
}

/**
 * Open the folder picker.
 *
 * Returns `{ ok: true, folderName, files }` or `{ ok: false, code }` where the
 * code is the sentence key to show. A cancel is not an error worth a red box,
 * but it is reported so the card can drop its spinner.
 */
export async function pickModelFolder(options = {}) {
    if (typeof options.picker === 'function') return options.picker();

    const win = globalThis;
    if (typeof win.showDirectoryPicker === 'function') {
        try {
            const handle = await win.showDirectoryPicker({ id: 'clinic-model-folder', mode: 'read' });
            const files = [];
            for await (const entry of handle.values()) {
                if (entry.kind === 'file') files.push(await entry.getFile());
            }
            return { ok: true, folderName: String(handle.name ?? ''), files };
        } catch (error) {
            if (error?.name === 'AbortError') return { ok: false, code: 'aiSettings.localV2.folder.error.cancelled' };
            return { ok: false, code: 'aiSettings.localV2.folder.error.picker' };
        }
    }

    return pickFiles({ multiple: true, directory: true, accept: '' });
}

/** Pick the wasm library on its own, for a folder that does not hold one. */
export async function pickLibraryFile(options = {}) {
    if (typeof options.picker === 'function') return options.picker();

    const win = globalThis;
    if (typeof win.showOpenFilePicker === 'function') {
        try {
            const [handle] = await win.showOpenFilePicker({
                id: 'clinic-model-library',
                multiple: false,
                types: [{ description: 'WebGPU model library', accept: { 'application/wasm': ['.wasm'] } }],
            });
            return { ok: true, file: await handle.getFile() };
        } catch (error) {
            if (error?.name === 'AbortError') return { ok: false, code: 'aiSettings.localV2.folder.error.cancelled' };
            return { ok: false, code: 'aiSettings.localV2.folder.error.picker' };
        }
    }

    return pickFiles({ multiple: false, directory: false, accept: '.wasm' });
}

/** The universal fallback: a file input, which also works in Firefox. */
function pickFiles(input, doc = typeof document === 'undefined' ? null : document) {
    if (!doc) return Promise.resolve({ ok: false, code: 'aiSettings.localV2.folder.error.picker' });

    return new Promise((resolve) => {
        const element = doc.createElement('input');
        element.type = 'file';
        element.multiple = Boolean(input.multiple);
        if (input.accept) element.accept = input.accept;
        if (input.directory) {
            element.setAttribute('webkitdirectory', '');
            element.setAttribute('directory', '');
        }
        element.style.display = 'none';

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            element.remove();
            resolve(value);
        };

        element.addEventListener('change', () => {
            const files = Array.from(element.files ?? []);
            if (files.length === 0) {
                finish({ ok: false, code: 'aiSettings.localV2.folder.error.cancelled' });
                return;
            }
            if (input.multiple) {
                const relative = String(files[0].webkitRelativePath ?? '');
                const folderName = relative.includes('/') ? relative.split('/')[0] : '';
                finish({ ok: true, folderName, files });
                return;
            }
            finish({ ok: true, file: files[0] });
        });
        element.addEventListener('cancel', () => {
            finish({ ok: false, code: 'aiSettings.localV2.folder.error.cancelled' });
        });

        doc.body.appendChild(element);
        element.click();
    });
}

function mountError(code) {
    const error = new Error(code);
    error.code = code;
    error.key = code === 'SERVICE_WORKER_MISSING'
        ? 'aiSettings.localV2.folder.error.worker'
        : 'aiSettings.localV2.folder.error.mount';
    return error;
}

function waitForController(nav, timeoutMs) {
    if (nav.serviceWorker.controller) return Promise.resolve();
    return new Promise((resolve) => {
        let timer = null;
        const done = () => {
            if (timer) clearTimeout(timer);
            nav.serviceWorker.removeEventListener?.('controllerchange', done);
            resolve();
        };
        nav.serviceWorker.addEventListener?.('controllerchange', done);
        timer = setTimeout(done, timeoutMs);
    });
}

/**
 * Hand a folder to the worker and get the base address the engine can use.
 *
 * The ack matters: fetching before the worker has the files would race into a
 * 404 that looks like a broken model.
 */
export async function mountModel(input, options = {}) {
    const nav = options.navigator ?? (typeof navigator === 'undefined' ? null : navigator);
    if (!serviceWorkerSupported(nav)) throw mountError('SERVICE_WORKER_MISSING');

    const doc = options.document ?? (typeof document === 'undefined' ? null : document);
    const files = (Array.isArray(input?.files) ? input.files : []).filter(Boolean);
    const entries = files.map((file) => ({ name: fileName(file), file }));
    if (input?.modelLibFile) {
        entries.push({ name: fileName(input.modelLibFile), file: input.modelLibFile });
    }

    if (typeof options.register === 'function') {
        await options.register(workerUrl(doc));
    } else {
        await nav.serviceWorker.register(workerUrl(doc));
    }
    await nav.serviceWorker.ready;
    await waitForController(nav, 5000);

    const worker = nav.serviceWorker.controller;
    if (!worker) throw mountError('SERVICE_WORKER_MISSING');

    const id = String(options.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 16));
    await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(mountError('SERVICE_WORKER_TIMEOUT')), 15000);
        channel.port1.onmessage = () => {
            clearTimeout(timer);
            resolve();
        };
        worker.postMessage({ type: 'mount', id, files: entries }, [channel.port2]);
    });

    const baseUrl = new URL(`${MODEL_PATH}${id}/`, new URL('.', doc?.baseURI ?? 'http://localhost/')).href;
    return {
        id,
        baseUrl,
        unmount() {
            try {
                worker.postMessage({ type: 'unmount', id });
            } catch {
                // The worker is going away with the page; nothing to clean.
            }
        },
    };
}
