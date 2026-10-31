// The Settings -> AI card for the v2 engine.
//
// A separate Alpine component on purpose: the v1 card was a large state
// machine and v2 must not inherit it. This one knows what the GPU can do,
// which folder was picked, which model is saved, and two buttons.
//
// There is no download and no model list: the clinic picks the folder it
// already has. The card checks the folder before loading it, so a folder
// missing its tokenizer is a sentence rather than a failed load, and it loads
// once to prove the model runs before saving it as this computer's model.

import { formatGb } from './device.js';
import { pickLibraryFile, pickModelFolder, readModelFolder } from './folder.js';
import { v2ErrorKey } from './errors.js';
import {
    clearV2Profile,
    loadV2Profile,
    saveV2Profile,
} from './profile.js';
import { probeV2Device, setupLocalV2 } from './setup.js';

function translate(key, params) {
    if (!key) return '';
    const t = globalThis.t;
    return typeof t === 'function' ? t(key, params) : key;
}

export function localAiV2() {
    return {
        profile: null,
        // { files, folderName, library }
        folder: null,
        // what the folder turned out to be: id, name, quant, window, bytes…
        model: null,
        device: null,
        capacity: null,
        // 'idle' | 'checking' | 'loading' | 'ready' | 'blocked' | 'error'
        status: 'idle',
        error: null,
        progress: 0,
        progressText: '',
        advancedOpen: false,
        busy: false,
        contextWindow: 4096,
        sampling: { temperature: 0.3, topP: 0.9, frequencyPenalty: 0.3 },

        async init() {
            this.profile = loadV2Profile();
            this.contextWindow = this.profile.contextWindow;
            this.sampling = { ...this.profile.sampling };
            await this.check();
        },

        get deviceLabel() {
            const gpu = this.device?.description || this.device?.device || '';
            if (!gpu) return '';
            return translate('aiSettings.localV2.device.gpu', { gpu });
        },

        get statusText() {
            return translate(`aiSettings.localV2.status.${this.status}`, { percent: this.progress });
        },

        get errorText() {
            return this.error?.key ? translate(this.error.key, this.error.params) : '';
        },

        get errorDetail() {
            return this.error?.detail ?? '';
        },

        get sizeLabel() {
            return this.model ? formatGb(this.model.bytes) : '';
        },

        get folderSummary() {
            if (!this.model) return '';
            return translate('aiSettings.localV2.folder.summary', {
                count: this.model.fileCount,
                size: formatGb(this.model.bytes),
            });
        },

        get quantLabel() {
            if (!this.model?.quant) return '';
            return translate('aiSettings.localV2.quant', { quant: this.model.quant });
        },

        get contextLabel() {
            return String(this.contextWindow ?? this.model?.contextWindow ?? '');
        },

        /** The folder holds weights but no library: ask for the wasm alone. */
        get needsLibrary() {
            return Boolean(this.model) && !this.model.hasLibrary;
        },

        get canLoad() {
            return Boolean(this.model?.hasLibrary) && !this.busy && this.status !== 'loading';
        },

        get isSaved() {
            return Boolean(this.profile?.savedAt && this.profile.modelId === this.model?.id);
        },

        /** Ask the GPU, then settle on the status the card shows. */
        async check() {
            const probed = await probeV2Device(this.model);
            this.device = probed.device;
            this.capacity = probed.capacity;

            if (!probed.fit.ok) {
                // The refusal is a sentence with numbers, not a code.
                this.status = 'blocked';
                this.error = {
                    key: v2ErrorKey(probed.fit.code),
                    params: probed.fit.params ?? {},
                    detail: probed.fit.code,
                };
                return probed;
            }

            if (this.status !== 'loading' && this.status !== 'error') {
                this.status = this.isSaved ? 'ready' : 'idle';
            }
            if (!this.model || this.status !== 'error') this.error = null;
            return probed;
        },

        /** Pick a folder. Nothing loads until the button is pressed. */
        async choose() {
            if (this.busy) return;
            this.busy = true;
            this.error = null;
            this.progress = 0;
            this.progressText = '';
            try {
                const picked = await pickModelFolder();
                if (!picked.ok) {
                    // A cancel is not a failure: keep whatever was loaded.
                    if (picked.code !== 'aiSettings.localV2.folder.error.cancelled') {
                        this.status = 'error';
                        this.error = { key: picked.code };
                    }
                    return;
                }

                const read = await readModelFolder(picked.files, { folderName: picked.folderName });
                if (!read.ok) {
                    this.folder = null;
                    this.model = null;
                    this.status = 'error';
                    this.error = { key: read.errors[0] };
                    return;
                }

                this.adopt(read.model, { files: picked.files, folderName: picked.folderName, library: null });
                this.status = 'checking';
                await this.check();
            } catch (failure) {
                this.status = 'error';
                this.error = {
                    key: failure?.key ?? 'aiSettings.localV2.error.generic',
                    detail: String(failure?.message ?? ''),
                };
            } finally {
                this.busy = false;
            }
        },

        /** Pick the .wasm library for a folder that does not hold one. */
        async chooseLibrary() {
            if (this.busy || !this.folder) return;
            this.busy = true;
            this.error = null;
            try {
                const picked = await pickLibraryFile();
                if (!picked.ok) {
                    if (picked.code !== 'aiSettings.localV2.folder.error.cancelled') {
                        this.error = { key: picked.code };
                    }
                    return;
                }

                const read = await readModelFolder(this.folder.files, {
                    folderName: this.folder.folderName,
                    modelLib: picked.file,
                });
                if (!read.ok) {
                    this.error = { key: read.errors[0] };
                    return;
                }

                this.folder = { ...this.folder, library: picked.file };
                this.adopt(read.model, this.folder);
                await this.check();
            } finally {
                this.busy = false;
            }
        },

        /** Take a folder's model as the one on screen. */
        adopt(model, folder) {
            this.folder = folder;
            this.model = model;
            const same = this.profile?.modelId === model.id;
            this.contextWindow = same
                ? Math.min(this.profile.contextWindow, model.contextWindow)
                : model.contextWindow;
            if (same) this.sampling = { ...this.profile.sampling };
        },

        /** Load once to prove the folder works, then free the GPU memory. */
        async load() {
            if (!this.canLoad) return;
            this.busy = true;
            this.error = null;
            this.progress = 0;
            this.progressText = '';
            this.status = 'loading';
            try {
                const loaded = await setupLocalV2({
                    folder: this.folder,
                    model: this.model,
                    profile: {
                        modelId: this.model.id,
                        contextWindow: this.contextWindow,
                        sampling: this.sampling,
                    },
                    onProgress: (report) => {
                        this.progressText = String(report?.text ?? '');
                        if (Number.isFinite(Number(report?.progress))) {
                            this.progress = Math.round(Number(report.progress) * 100);
                        }
                    },
                });
                this.profile = saveV2Profile({
                    ...loaded.profile,
                    modelId: this.model.id,
                    savedAt: Date.now(),
                });
                this.contextWindow = this.profile.contextWindow;
                this.sampling = { ...this.profile.sampling };
                this.progress = 100;
                this.status = 'ready';
                await loaded.unload();
            } catch (failure) {
                this.status = 'error';
                this.error = {
                    key: failure?.key ?? v2ErrorKey(failure?.code),
                    params: failure?.params ?? {},
                    detail: String(failure?.message ?? ''),
                };
            } finally {
                this.busy = false;
            }
        },

        async retry() {
            if (this.model) {
                await this.check();
                if (this.canLoad) await this.load();
                return;
            }
            await this.choose();
        },

        /** Forget this computer's model. The folder is untouched. */
        remove() {
            clearV2Profile();
            this.profile = null;
            this.model = null;
            this.folder = null;
            this.error = null;
            this.progress = 0;
            this.status = 'idle';
        },

        toggleAdvanced() {
            this.advancedOpen = !this.advancedOpen;
        },

        /**
         * Sampling is stored against the saved model. Before the first load
         * it stays in the card and travels with the load.
         */
        updateSampling(field, value) {
            this.sampling = { ...this.sampling, [field]: Number(value) };
            if (this.isSaved) {
                this.profile = saveV2Profile({ ...this.profile, sampling: this.sampling });
            }
        },

        updateContext(value) {
            if (!this.model) return;
            const wanted = Math.round(Number(value) || this.model.contextWindow);
            this.contextWindow = Math.min(Math.max(512, wanted), this.model.contextWindow);
            if (this.isSaved) {
                this.profile = saveV2Profile({ ...this.profile, contextWindow: this.contextWindow });
            }
        },

        label(key, params) {
            return translate(key, params);
        },
    };
}
