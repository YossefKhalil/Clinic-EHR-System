// The Settings -> AI card for the v2 engine.
//
// A separate Alpine component on purpose: the v1 card is a large state
// machine and v2 must not inherit it. This one knows three things — what the
// device can do, which model is saved, and one button. Everything else is
// behind the Advanced drawer.
//
// The card never runs an import: it loads the model once to prove it works,
// frees it, and leaves the weights in the browser cache for the run.

import { defaultModel, formatGb, modelById, modelBytes } from './catalog.js';
import { v2ErrorKey } from './errors.js';
import { v2Enabled } from './flag.js';
import { clearV2Profile, loadV2Profile, saveV2Profile } from './profile.js';
import { probeV2Device, setupLocalV2 } from './setup.js';

function translate(key, params) {
    if (!key) return '';
    const t = globalThis.t;
    return typeof t === 'function' ? t(key, params) : key;
}

export function localAiV2() {
    return {
        enabled: false,
        model: null,
        profile: null,
        device: null,
        capacity: null,
        fit: null,
        // 'idle' | 'checking' | 'blocked' | 'downloading' | 'ready' | 'error'
        status: 'idle',
        error: null,
        progress: 0,
        progressText: '',
        advancedOpen: false,
        busy: false,

        async init() {
            this.enabled = v2Enabled();
            if (!this.enabled) return;
            this.profile = loadV2Profile();
            this.model = modelById(this.profile.modelId) ?? defaultModel();
            await this.check();
        },

        /** Ask the device, then settle on the status the card shows. */
        async check() {
            if (!this.model) return;
            this.busy = true;
            try {
                const probed = await probeV2Device(this.model);
                this.device = probed.device;
                this.capacity = probed.capacity;
                this.fit = probed.fit;
                if (!probed.fit.ok) {
                    // The refusal is a sentence with numbers, not a code.
                    this.status = 'blocked';
                    this.error = {
                        key: v2ErrorKey(probed.fit.code),
                        params: probed.fit.params,
                        detail: probed.fit.code,
                    };
                } else {
                    this.error = null;
                    if (this.status !== 'error') {
                        this.status = this.profile?.savedAt ? 'ready' : 'idle';
                    }
                }
            } finally {
                this.busy = false;
            }
        },

        get sizeLabel() {
            return formatGb(modelBytes(this.model));
        },

        get storageLabel() {
            const free = Number(this.capacity?.freeBytes);
            return Number.isFinite(free) ? formatGb(free) : '';
        },

        get contextLabel() {
            return String(this.profile?.contextWindow ?? this.model?.contextWindow ?? '');
        },

        get statusKey() {
            return `aiSettings.localV2.status.${this.status}`;
        },

        get statusText() {
            return translate(this.statusKey, { percent: this.progress });
        },

        get errorText() {
            if (!this.error) return '';
            return translate(this.error.key, this.error.params);
        },

        get errorDetailKey() {
            return 'aiSettings.localV2.error.details';
        },

        /** Download and load once, then free the GPU memory. */
        async download() {
            if (this.busy || !this.model) return;
            this.busy = true;
            this.error = null;
            this.progress = 0;
            this.progressText = '';
            this.status = 'downloading';
            try {
                const loaded = await setupLocalV2({
                    profile: this.profile,
                    onProgress: (report) => {
                        if (report?.phase !== 'download') return;
                        this.progress = Math.round((Number(report.progress) || 0) * 100);
                        this.progressText = String(report.text ?? '');
                    },
                });
                this.profile = saveV2Profile({
                    ...this.profile,
                    modelId: loaded.model.id,
                    contextWindow: loaded.profile.contextWindow,
                    sampling: loaded.profile.sampling,
                    savedAt: Date.now(),
                });
                this.status = 'ready';
                await loaded.unload();
            } catch (error) {
                this.status = 'error';
                this.error = {
                    key: error?.key ?? v2ErrorKey(error?.code),
                    params: error?.params ?? {},
                    detail: String(error?.message ?? ''),
                };
            } finally {
                this.busy = false;
            }
        },

        /** Forget the model on this device (the browser cache stays). */
        remove() {
            clearV2Profile();
            this.profile = loadV2Profile();
            this.error = null;
            this.status = this.fit?.ok === false ? 'blocked' : 'idle';
        },

        async retry() {
            await this.check();
            if (this.fit?.ok !== false) await this.download();
        },

        toggleAdvanced() {
            this.advancedOpen = !this.advancedOpen;
        },

        /** Advanced edits are saved only for a model that already loaded. */
        updateSampling(field, value) {
            if (!this.profile) return;
            const sampling = { ...this.profile.sampling, [field]: Number(value) };
            this.profile = this.profile.savedAt
                ? saveV2Profile({ ...this.profile, sampling })
                : { ...this.profile, sampling };
        },

        updateContext(value) {
            if (!this.profile) return;
            const contextWindow = Number(value) || this.profile.contextWindow;
            this.profile = this.profile.savedAt
                ? saveV2Profile({ ...this.profile, contextWindow })
                : { ...this.profile, contextWindow };
        },

        label(key, params) {
            return translate(key, params);
        },
    };
}
