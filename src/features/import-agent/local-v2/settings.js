// The Settings -> AI card for the v2 engine.
//
// A separate Alpine component on purpose: the v1 card is a large state
// machine and v2 must not inherit it. This one knows what the device can do,
// which models are on offer, which one is saved, and one button.
//
// The list is not fixed: the clinic can pick any of the checked-in builds or
// add an MLC repo of its own (MiniCPM, or whatever is converted next). The
// card never runs an import — it loads a model once to prove it works, frees
// it, and leaves the weights in the browser cache for the run.

import {
    addCustomModel,
    allModels,
    assessFit,
    defaultModel,
    formatGb,
    modelById,
    modelBytes,
    removeCustomModel,
    validateCustomModel,
} from './catalog.js';
import { v2ErrorKey } from './errors.js';
import { v2Enabled } from './flag.js';
import {
    clearV2Profile,
    loadSelectedModelId,
    loadV2Profile,
    saveSelectedModelId,
    saveV2Profile,
} from './profile.js';
import { probeV2Device, setupLocalV2 } from './setup.js';

function translate(key, params) {
    if (!key) return '';
    const t = globalThis.t;
    return typeof t === 'function' ? t(key, params) : key;
}

function blankDraft() {
    return { id: '', name: '', baseUrl: '', modelLib: '', contextWindow: 4096, downloadGb: '' };
}

export function localAiV2() {
    return {
        enabled: false,
        profile: null,
        device: null,
        capacity: null,
        // 'idle' | 'checking' | 'blocked' | 'downloading' | 'ready' | 'error'
        status: 'idle',
        error: null,
        progress: 0,
        progressText: '',
        advancedOpen: false,
        customOpen: false,
        customError: null,
        busy: false,
        models: [],
        selectedId: null,
        contextWindow: 4096,
        sampling: { temperature: 0.3, topP: 0.9, frequencyPenalty: 0.3 },
        draft: blankDraft(),

        async init() {
            this.enabled = v2Enabled();
            if (!this.enabled) return;
            this.refresh();
            this.profile = loadV2Profile();
            this.selectedId = loadSelectedModelId() ?? this.profile?.modelId ?? this.models[0]?.id ?? null;
            this.seedFromProfile();
            await this.check();
        },

        /** Built-ins plus whatever the clinic added on this device. */
        refresh() {
            this.models = allModels();
        },

        /**
         * Seed the drawer from the profile only when the profile belongs to
         * the model on screen: a candidate model starts from its own numbers.
         */
        seedFromProfile() {
            const model = this.model;
            if (!model) return;
            const proven = this.isVerified;
            this.contextWindow = proven ? this.profile.contextWindow : model.contextWindow;
            this.sampling = proven
                ? { ...this.profile.sampling }
                : { ...model.sampling };
        },

        get model() {
            return modelById(this.selectedId);
        },

        get isVerified() {
            return Boolean(this.profile?.savedAt && this.profile.modelId === this.selectedId);
        },

        get fit() {
            return assessFit(this.model, this.device, this.capacity);
        },

        /** One row per model: what it costs, whether it fits, whether it is picked. */
        get rows() {
            return this.models.map((model) => {
                const fit = assessFit(model, this.device, this.capacity);
                return {
                    id: model.id,
                    name: model.name,
                    custom: Boolean(model.custom),
                    tier: model.tier,
                    tierLabel: model.tier && model.tier !== 'custom'
                        ? translate(`aiSettings.localV2.tier.${model.tier}`)
                        : '',
                    sizeLabel: formatGb(modelBytes(model)),
                    meta: this.modelMeta(model),
                    active: model.id === this.selectedId,
                    ok: fit.ok,
                    fitText: fit.ok ? '' : translate(v2ErrorKey(fit.code), fit.params),
                };
            });
        },

        modelMeta(model) {
            const context = translate('aiSettings.localV2.context', { count: model.contextWindow });
            return [model.publisher, model.quant, context].filter(Boolean).join(' · ');
        },

        get deviceLabel() {
            const gpu = this.device?.description || this.device?.device || '';
            if (!gpu) return '';
            return translate('aiSettings.localV2.device.gpu', { gpu });
        },

        get sizeLabel() {
            return formatGb(modelBytes(this.model));
        },

        get storageLabel() {
            const free = Number(this.capacity?.freeBytes);
            return Number.isFinite(free) ? formatGb(free) : '';
        },

        get contextLabel() {
            return String(this.contextWindow ?? this.model?.contextWindow ?? '');
        },

        get licenseText() {
            if (!this.model) return '';
            return translate('aiSettings.localV2.license', {
                name: this.model.name,
                publisher: this.model.publisher,
                license: this.model.license,
            });
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

        get customErrorText() {
            return this.customError ? translate(this.customError) : '';
        },

        get showDownload() {
            return this.status === 'idle' && this.fit.ok;
        },

        get showRetry() {
            return this.status === 'error';
        },

        get showRemove() {
            return this.status === 'ready';
        },

        /** Ask the device, then settle on the status the card shows. */
        async check() {
            if (!this.model) return;
            this.busy = true;
            try {
                const probed = await probeV2Device(this.model);
                this.device = probed.device;
                this.capacity = probed.capacity;
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
                        this.status = this.isVerified ? 'ready' : 'idle';
                    }
                }
            } finally {
                this.busy = false;
            }
        },

        /** Pick a model. Nothing downloads until the button is pressed. */
        async select(id) {
            if (this.busy || id === this.selectedId) return;
            this.selectedId = id;
            saveSelectedModelId(id);
            this.error = null;
            this.progress = 0;
            this.progressText = '';
            this.seedFromProfile();
            await this.check();
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
                    model: this.model,
                    profile: {
                        modelId: this.model.id,
                        contextWindow: this.contextWindow,
                        sampling: this.sampling,
                    },
                    onProgress: (report) => {
                        if (report?.phase !== 'download') return;
                        this.progress = Math.round((Number(report.progress) || 0) * 100);
                        this.progressText = String(report.text ?? '');
                    },
                });
                this.profile = saveV2Profile({
                    ...loaded.profile,
                    modelId: loaded.model.id,
                    savedAt: Date.now(),
                });
                this.contextWindow = this.profile.contextWindow;
                this.sampling = { ...this.profile.sampling };
                this.progress = 100;
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
            this.profile = null;
            this.error = null;
            this.progress = 0;
            this.status = this.fit.ok ? 'idle' : 'blocked';
        },

        async retry() {
            await this.check();
            if (this.fit?.ok) await this.download();
        },

        toggleAdvanced() {
            this.advancedOpen = !this.advancedOpen;
        },

        toggleCustom() {
            this.customOpen = !this.customOpen;
            this.customError = null;
        },

        /**
         * Sampling is stored against the saved model. Before the first load
         * it stays in the card and travels with the download.
         */
        updateSampling(field, value) {
            this.sampling = { ...this.sampling, [field]: Number(value) };
            if (this.isVerified) {
                this.profile = saveV2Profile({
                    ...this.profile,
                    sampling: this.sampling,
                });
            }
        },

        updateContext(value) {
            if (!this.model) return;
            const wanted = Math.round(Number(value) || this.model.contextWindow);
            const clamped = Math.min(Math.max(512, wanted), this.model.contextWindow);
            this.contextWindow = clamped;
            if (this.isVerified) {
                this.profile = saveV2Profile({
                    ...this.profile,
                    contextWindow: clamped,
                });
            }
        },

        /** Store a model the clinic pasted in, then select it. */
        async saveCustom() {
            const result = validateCustomModel(this.draft);
            if (!result.ok) {
                this.customError = Object.values(result.errors)[0];
                return;
            }
            addCustomModel(result.model);
            this.refresh();
            this.draft = blankDraft();
            this.customError = null;
            this.customOpen = false;
            await this.select(result.model.id);
        },

        removeCustom(id) {
            removeCustomModel(id);
            this.refresh();
            if (this.selectedId !== id) return;
            this.selectedId = this.models[0]?.id ?? defaultModel()?.id ?? null;
            saveSelectedModelId(this.selectedId);
            this.seedFromProfile();
            this.check();
        },

        label(key, params) {
            return translate(key, params);
        },
    };
}
