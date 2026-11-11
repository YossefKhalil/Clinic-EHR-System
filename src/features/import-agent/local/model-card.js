// The model card: one pinned model, one status, one action.
//
// It lives where the model belongs — Settings → AI & Import — and the import
// wizard renders the same state and loads the model on demand, so a user never
// has to walk to settings before every import. Both hosts spread this module's
// state and methods into their Alpine component, so there is exactly one
// implementation of "download, verify, load, remove".

import { t } from '../../../services/i18n.js';
import * as api from '../api.js';
import { LIMITS } from '@import-core/limits.js';
import { clampLocalConfig, localModelIdentity } from '@import-core/local-runtime.js';
import { MODEL_MANIFEST, MODEL_URLS } from './manifest.js';

function loadRuntime() {
    return import('./runtime.js');
}

function loadStore() {
    return import('./store.js');
}

/** Advanced knobs the user changed; they apply on the next model load. */
const RUNTIME_KEY = 'clinic.aiImport.runtime';

/** Set after a stored model loads, so a page refresh loads it again. */
const AUTOLOAD_KEY = 'clinic.aiImport.autoload';

let autoReloadStarted = false;

function wantsAutoLoad() {
    try {
        return window.localStorage.getItem(AUTOLOAD_KEY) === '1';
    } catch {
        return false;
    }
}

function setAutoLoad(on) {
    try {
        if (on) window.localStorage.setItem(AUTOLOAD_KEY, '1');
        else window.localStorage.removeItem(AUTOLOAD_KEY);
    } catch {
        // Private mode: no persistence, the model still works in this tab.
    }
}

function readRuntimeOverrides() {
    try {
        const raw = JSON.parse(window.localStorage.getItem(RUNTIME_KEY) ?? '{}');
        return raw && typeof raw === 'object' ? raw : {};
    } catch {
        return {};
    }
}

function writeRuntimeOverrides(value) {
    try {
        window.localStorage.setItem(RUNTIME_KEY, JSON.stringify(value));
    } catch {
        // a browser that refuses storage keeps the in-memory value
    }
}

export function modelCardState() {
    return {
        // unsupported | missing | downloading | verifying | loading | ready | error
        modelState: 'unknown',
        modelError: null,
        modelProgress: null,
        modelInfo: null,
        modelSource: null, // 'stored' | 'disk'
        modelCapabilities: null,
        modelFiles: { model: null, projector: null },
        modelBusy: false,
        localConfig: null,
        // Advanced inputs bind here: they are safe to render before the runtime
        // defaults have loaded (localConfig is filled in asynchronously).
        advanced: { threads: '', context: '', maxOutputTokens: '' },
        downloadController: null,
        // A disk file that already passed verification, kept so a reload can
        // happen without asking for the file again in the same session.
        verifiedFiles: null,
        // The live log of the model and of every extraction chunk. The import
        // wizard shows it while it works; settings shows it while it loads.
        modelLog: [],
        showModelLogs: false,
        showAdvanced: false,
        showDiskFiles: false,
        downloadStarted: false,
        modelLogCopied: false,
    };
}

export function modelCardMethods() {
    let logSeq = 0;

    return {
        // ------------------------------------------------------ log
        pushModelLog(level, message, detail = '') {
            const entry = {
                id: (logSeq += 1),
                at: new Date().toLocaleTimeString(),
                level,
                message: String(message ?? ''),
                detail: detail ? String(detail) : '',
            };
            this.modelLog.push(entry);
            if (this.modelLog.length > 400) this.modelLog.splice(0, this.modelLog.length - 400);
            if (level === 'error') console.warn('[import]', entry.message, entry.detail);
        },

        clearModelLogs() {
            this.modelLog = [];
            this.modelLogCopied = false;
        },

        modelLogText() {
            return (this.modelLog ?? [])
                .map((entry) => `[${entry.at}] ${entry.level.toUpperCase()} ${entry.message}`
                    + (entry.detail ? `\n    ${entry.detail}` : ''))
                .join('\n');
        },

        async copyModelLog() {
            const text = this.modelLogText();
            let ok = false;
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                    ok = true;
                }
            } catch {
                ok = false;
            }
            if (!ok) {
                // Clipboard API can be denied; a hidden textarea still works
                // inside the click handler on every supported browser.
                try {
                    const area = document.createElement('textarea');
                    area.value = text;
                    area.setAttribute('readonly', '');
                    area.style.position = 'fixed';
                    area.style.top = '-1000px';
                    document.body.appendChild(area);
                    area.select();
                    ok = document.execCommand('copy');
                    area.remove();
                } catch {
                    ok = false;
                }
            }
            this.modelLogCopied = ok;
            if (!ok) this.pushModelLog('warn', 'could not copy the log automatically; select the text and copy it manually');
        },

        // ------------------------------------------------------ status
        modelReady() {
            return this.modelState === 'ready';
        },

        modelLoaded() {
            return Boolean(this.modelInfo);
        },

        modelTitle() {
            return MODEL_MANIFEST.title;
        },

        modelBytes() {
            return MODEL_MANIFEST.files.model.bytes + MODEL_MANIFEST.files.projector.bytes;
        },

        modelStatusSentence() {
            if (this.modelLoaded()) return t('importAgent.local.status.loaded');
            const table = {
                unsupported: 'importAgent.local.status.unsupported',
                missing: 'importAgent.local.status.missing',
                downloading: 'importAgent.local.status.downloading',
                verifying: 'importAgent.local.status.verifying',
                loading: 'importAgent.local.status.loading',
                ready: 'importAgent.local.status.ready',
                error: 'importAgent.local.status.error',
                unknown: 'importAgent.local.status.unknown',
            };
            return t(table[this.modelState] ?? table.unknown);
        },

        modelProgressPercent() {
            return Math.max(0, Math.min(100, Math.round(this.modelProgress?.percent ?? 0)));
        },

        /** "45% · 540 MB / 1.2 GB" while a download, verify or load runs. */
        modelProgressLabel() {
            const progress = this.modelProgress ?? {};
            const parts = [`${this.modelProgressPercent()}%`];
            if (Number.isFinite(progress.loaded) && Number.isFinite(progress.total) && progress.total > 0) {
                parts.push(`${api.formatBytes(progress.loaded)} / ${api.formatBytes(progress.total)}`);
            }
            return parts.join(' · ');
        },

        formatBytes(n) {
            return api.formatBytes(n);
        },

        // ------------------------------------------------------ config
        /** One canonical shape for the server: text + runtime, clamped. */
        localConfigPayload() {
            const config = this.localConfig ?? {};
            return clampLocalConfig({
                text: {
                    contextTokens: config.context,
                    batchSize: config.batch,
                    ubatchSize: config.ubatch,
                    threads: config.threads,
                    gpuLayers: 0,
                    maxOutputTokens: config.maxOutputTokens,
                    temperature: config.temperature,
                    topK: config.topK,
                    topP: config.topP,
                    repeatPenalty: config.repeatPenalty,
                    sheetRowsPerChunk: this.localSheetRows(),
                    textCharsPerChunk: this.localTextChars(),
                },
                runtime: {
                    leaseSeconds: 900,
                    heartbeatSeconds: 60,
                    maxAttempts: 5,
                    parallel: 1,
                },
            });
        },

        localProfilePayload() {
            return {
                mode: 'single',
                name: MODEL_MANIFEST.files.model.name,
                size: MODEL_MANIFEST.files.model.bytes,
                sha256: MODEL_MANIFEST.files.model.sha256,
                mmprojName: MODEL_MANIFEST.files.projector.name,
                mmprojSize: MODEL_MANIFEST.files.projector.bytes,
                mmprojSha256: MODEL_MANIFEST.files.projector.sha256,
            };
        },

        /**
         * A small model writes far fewer tokens per second than a cloud one, and
         * a chunk that needs more output than the context allows comes back
         * truncated and has to be split. Keeping chunks small is the cheapest
         * quality fix there is.
         */
        localTextChars() {
            return Number(this.localConfig?.textCharsPerChunk ?? 400);
        },

        localSheetRows() {
            return Number(this.localConfig?.sheetRowsPerChunk ?? 5);
        },

        /**
         * The shared LIMITS with local chunk sizes. `TEXT_CHUNK_TARGET` is the
         * point where the chunker starts a new chunk, so a small target keeps
         * one patient note per chunk; `TEXT_CHUNK_MAX` stays generous so a
         * long note is only cut when it truly cannot fit a single pass.
         */
        localLimits() {
            return {
                ...LIMITS,
                TEXT_CHUNK_TARGET: this.localTextChars(),
                TEXT_CHUNK_MAX: Math.max(1_800, this.localTextChars()),
                SHEET_CHUNK_ROWS: this.localSheetRows(),
            };
        },

        /** Keep the advanced knobs for the next visit. */
        saveAdvancedConfig() {
            const config = this.localConfig ?? {};
            const threads = Number(this.advanced?.threads);
            const context = Number(this.advanced?.context);
            const maxOutputTokens = Number(this.advanced?.maxOutputTokens);
            if (this.localConfig) {
                if (Number.isFinite(threads) && threads > 0) this.localConfig.threads = threads;
                if (Number.isFinite(context) && context > 0) this.localConfig.context = context;
                if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) this.localConfig.maxOutputTokens = maxOutputTokens;
            }
            writeRuntimeOverrides({
                threads: Number.isFinite(threads) && threads > 0 ? threads : Number(config.threads),
                context: Number.isFinite(context) && context > 0 ? context : Number(config.context),
                maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : Number(config.maxOutputTokens),
            });
            this.pushModelLog('info', 'model settings saved; they apply on the next load');
        },

        // ------------------------------------------------------ lifecycle
        /** Probe the browser and see whether a model is already stored. */
        async initLocal() {
            if (!this.localConfig) {
                const { defaultConfig } = await loadRuntime();
                this.localConfig = { ...defaultConfig(), ...readRuntimeOverrides() };
            }
            this.advanced = {
                threads: this.localConfig.threads,
                context: this.localConfig.context,
                maxOutputTokens: this.localConfig.maxOutputTokens,
            };
            const { probeRuntime } = await loadRuntime();
            this.modelCapabilities = probeRuntime();
            if (!this.modelCapabilities.usable) {
                this.modelState = 'unsupported';
                return;
            }
            // The engine is a module singleton: another page (settings or the
            // wizard) may already have loaded it in this tab.
            const { localEngine } = await loadRuntime();
            if (localEngine.ready) {
                this.modelInfo = localEngine.info();
                this.modelState = 'ready';
                this.modelSource ??= 'stored';
                return;
            }
            if (this.modelState === 'ready' || this.modelState === 'loading') return;
            const store = await loadStore();
            const stored = await store.storedModel();
            this.modelState = stored.ready ? 'ready' : 'missing';
            this.modelSource = stored.ready ? 'stored' : null;
            // A refresh drops the in-memory engine, but the model files are
            // still in OPFS. Load them again automatically when the model was
            // loaded before, so the import keeps working after F5.
            if (stored.ready && wantsAutoLoad() && !autoReloadStarted) {
                autoReloadStarted = true;
                await this.loadStoredModel();
            }
        },

        async refreshStoredModel() {
            const store = await loadStore();
            const stored = await store.storedModel();
            if (!stored.ready) {
                this.modelState = 'missing';
                this.modelSource = null;
            }
        },

        onDiskModelPicked(event) {
            const files = [...(event.target?.files ?? [])];
            this.modelFiles = { model: null, projector: null };
            for (const file of files) {
                if (/^mmproj/i.test(file.name)) this.modelFiles.projector = file;
                else if (/\.gguf$/i.test(file.name)) this.modelFiles.model = file;
            }
        },

        diskFilesReady() {
            return Boolean(this.modelFiles.model && this.modelFiles.projector);
        },

        async useDiskModel() {
            if (!this.diskFilesReady() || this.modelBusy) return;
            this.modelBusy = true;
            this.modelError = null;
            this.modelState = 'verifying';
            try {
                const store = await loadStore();
                const verified = await store.verifyLocalFiles(
                    this.modelFiles.model,
                    this.modelFiles.projector,
                    (progress) => {
                        this.modelProgress = { percent: progress.percent ?? 0 };
                    },
                );
                this.pushModelLog('info', 'disk files verified against the pinned hashes');
                await this.loadModelFiles(verified, 'disk');
                // Keep a copy in OPFS so a refresh can load the same model
                // without asking for the two files again.
                try {
                    this.pushModelLog('info', 'copying the model files into this browser for next time');
                    const stored = await store.persistFiles(verified.model, verified.projector, {
                        onProgress: (progress) => { this.modelProgress = progress; },
                    });
                    this.verifiedFiles = stored;
                    this.modelSource = 'stored';
                    setAutoLoad(true);
                    this.modelProgress = null;
                    this.pushModelLog('info', 'model files saved in this browser; they load automatically next visit');
                } catch (persistError) {
                    this.modelProgress = null;
                    this.pushModelLog('warn', 'could not keep a copy in this browser; choose the files again next visit',
                        persistError?.message || '');
                }
            } catch (error) {
                this.localModelFailure(error);
            } finally {
                this.modelBusy = false;
            }
        },

        /**
         * Send both GGUF files to the browser's own download manager.
         * The user then picks the two files with "Use GGUF files"; nothing
         * is fetched into OPFS and no upload happens.
         */
        startBrowserDownload() {
            if (this.modelBusy) return;
            this.downloadStarted = true;
            this.showDiskFiles = true;
            this.modelError = null;
            this.pushModelLog('info', 'browser downloads started: model and vision projector');
            const files = ['model', 'projector'];
            const clickOne = (index) => {
                if (index >= files.length) return;
                const key = files[index];
                const file = MODEL_MANIFEST.files[key];
                const link = document.createElement('a');
                link.href = MODEL_URLS[key];
                link.download = file.name;
                link.rel = 'noopener';
                document.body.appendChild(link);
                link.click();
                link.remove();
                // Browsers block a second automatic download fired in the same
                // tick. Space them out so both files reach the download list.
                if (index + 1 < files.length) window.setTimeout(() => clickOne(index + 1), 1500);
            };
            clickOne(0);
        },

        async downloadModel() {
            if (this.modelBusy) return;
            this.modelBusy = true;
            this.modelError = null;
            this.modelState = 'downloading';
            this.downloadController = new AbortController();
            this.pushModelLog('info', 'starting the model download from Hugging Face');
            try {
                const store = await loadStore();
                const files = await store.downloadModel({
                    signal: this.downloadController.signal,
                    onProgress: (progress) => {
                        this.modelProgress = progress;
                        if (progress.phase === 'model' || progress.phase === 'projector') {
                            this.modelState = 'downloading';
                        }
                    },
                });
                this.pushModelLog('info', 'download complete, size and SHA-256 verified');
                await this.loadModelFiles(files, 'stored');
            } catch (error) {
                if (error?.code === 'ABORTED') {
                    await this.refreshStoredModel();
                } else {
                    this.localModelFailure(error);
                }
            } finally {
                this.modelBusy = false;
                this.downloadController = null;
            }
        },

        cancelDownload() {
            this.downloadController?.abort();
        },

        async loadStoredModel() {
            if (this.modelBusy) return false;
            const store = await loadStore();
            const stored = await store.storedModel();
            if (!stored.ready) {
                this.modelState = 'missing';
                return false;
            }
            this.modelBusy = true;
            this.modelError = null;
            try {
                await this.loadModelFiles(stored, 'stored');
                return true;
            } catch (error) {
                this.localModelFailure(error);
                return false;
            } finally {
                this.modelBusy = false;
            }
        },

        async loadModelFiles(files, source) {
            this.modelState = 'loading';
            this.modelProgress = { percent: 0 };
            this.pushModelLog('info', `loading the model (${source === 'disk' ? 'from disk' : 'from this browser'}), `
                + `context ${this.localConfig?.context}, threads ${this.localConfig?.threads}`);
            const engine = await loadRuntime().then((mod) => mod.localEngine);
            const info = await engine.load({
                model: files.model,
                projector: files.projector,
                config: this.localConfig,
                onProgress: (progress) => {
                    const percent = progress?.total ? (progress.loaded / progress.total) * 100 : 0;
                    this.modelProgress = { percent };
                },
            });
            this.modelInfo = info;
            this.modelSource = source;
            this.verifiedFiles = files;
            this.modelState = 'ready';
            this.pushModelLog('info', `model ready: ${info.mode} build, ${info.threads} thread(s)`
                + (info.vision ? ', vision' : ''));
            // Only a model that lives in OPFS can come back after a refresh.
            setAutoLoad(source === 'stored');
        },

        async unloadModel() {
            setAutoLoad(false);
            const engine = await loadRuntime().then((mod) => mod.localEngine);
            await engine.unload();
            this.modelInfo = null;
            if (this.modelState === 'ready') {
                this.modelState = this.modelSource === 'stored' ? 'ready' : 'missing';
            }
            await this.refreshStoredModel();
            this.pushModelLog('info', 'model unloaded and its memory released');
        },

        async removeModel() {
            await this.unloadModel();
            const store = await loadStore();
            await store.removeStoredModel();
            this.modelState = 'missing';
            this.modelSource = null;
            this.modelInfo = null;
            this.modelProgress = null;
            this.verifiedFiles = null;
            this.pushModelLog('info', 'the downloaded model was removed from this browser');
        },

        /**
         * Make sure a model is in memory before an extraction starts. Returns
         * false when nothing is available, so the caller can send the user to
         * settings instead of failing in the middle of an import.
         */
        async ensureEngine() {
            const engine = await loadRuntime().then((mod) => mod.localEngine);
            if (engine.ready) return true;
            if (this.verifiedFiles) {
                try {
                    await this.loadModelFiles(this.verifiedFiles, this.modelSource ?? 'disk');
                    return true;
                } catch (error) {
                    this.localModelFailure(error);
                    return false;
                }
            }
            return this.loadStoredModel();
        },

        localModelFailure(error) {
            this.modelState = 'error';
            this.modelError = {
                code: error?.code || 'INTERNAL',
                messageKey: `importAgent.local.error.${error?.code || 'INTERNAL'}`,
                detail: error?.detail || error?.message || '',
            };
            this.pushModelLog('error', `model error: ${error?.code || 'INTERNAL'}`, error?.detail || error?.message || '');
        },

        localModelIdentity() {
            return localModelIdentity(this.localProfilePayload());
        },
    };
}
