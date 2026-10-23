// Alpine component for the AI Import wizard (spec 10): add data → extract →
// review → (commit, next milestone).
//
// The component holds only reactive state and glue. Every review rule —
// filters, edits, revalidation, statuses, counts — lives in the pure model
// `review.js` (unit-tested without the DOM), and every network touch lives in
// `api.js`. `t()` reads the locale from the shared Alpine-reactive i18n
// state, so a language switch re-renders this page like the rest of the app.
//
// The mount point lives inside the main app's `x-data` (sidebar, toasts,
// locale). `main.js` calls `importAgentEnter()` when the user navigates to
// this page, which is the only trigger for the resumable-job lookup — no
// network happens at app boot.

import { readFile } from './readers/index.js';
import { analyzeFile } from './intake.js';
import { prepareSources, shiftSourceIds } from '@import-core/chunker.js';
import { FIELDS, BULK_FILL_FIELDS, fieldByKey } from '@import-core/field-registry.js';
import { LIMITS } from '@import-core/limits.js';
import * as review from './review.js';
import * as api from './api.js';
import { t, getLocale } from '../../services/i18n.js';
import { supabase, getCurrentUser } from '../../services/supabase.js';
import { activeOptions, loadOptions } from '../../services/options.js';
import { loadImportState } from '../../services/import-flag.js';

const PUMP_DELAY = 800;
const PUMP_RETRIES = 3;
const PUMP_RETRY_DELAY = 2_000;
const UNDO_LIMIT = 100;

/** The review page, like the pump, needs "today": caller-side clock only. */
function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split a list into groups of `size` (the saves go out in parallel). */
function chunksOf(list, size) {
    const groups = [];
    for (let i = 0; i < list.length; i += size) groups.push(list.slice(i, i + size));
    return groups;
}

function isPlainDateValue(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Grid display for a date cell: the reviewer's own text wins over formatting. */
function dateDisplayValue(cell) {
    const raw = cell?.raw;
    if (typeof raw === 'string' && raw.trim()) return raw;
    if (isPlainDateValue(cell?.value)) {
        const [year, month, day] = cell.value.split('-');
        return `${day}/${month}/${year}`;
    }
    return typeof raw === 'string' ? raw : '';
}

/** Merge reader warnings with (client) chunker warnings, deduped by code. */
function mergeWarnings(...groups) {
    const seen = new Set();
    const out = [];
    for (const group of groups) {
        for (const warning of group ?? []) {
            if (warning?.code && seen.has(warning.code)) continue;
            if (warning?.code) seen.add(warning.code);
            out.push(warning);
        }
    }
    return out;
}

function dedupeIssues(issues) {
    const seen = new Set();
    return issues.filter((issue) => {
        const key = `${issue.code}\u0000${issue.field ?? ''}\u0000${issue.severity}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** The intake registry order, exactly as the record panel should read it. */
const RECORD_SECTIONS = Object.freeze([
    {
        titleKey: '1. Personal Identification',
        icon: 'bi-person-vcard',
        keys: ['name', 'national_id'],
    },
    {
        titleKey: '2. Demographics & Contact Info',
        icon: 'bi-telephone-inbound',
        keys: ['mobile', 'date_of_birth', 'age', 'marital_status', 'children_count', 'governorate'],
    },
    {
        titleKey: '3. Full Residential Address',
        icon: 'bi-geo-alt',
        keys: ['address'],
    },
    {
        titleKey: '4. Consultation / Visit Data',
        icon: 'bi-clipboard2-pulse',
        keys: ['problem', 'solution', 'visit_date', 'price', 'follower', 'section', 'source_of_money', 'notes'],
    },
    {
        titleKey: '5. Attachments',
        icon: 'bi-paperclip',
        keys: [],
    },
]);

const LONG_FIELDS = new Set(['address', 'problem', 'solution']);

export function importAgentWizard() {
    return {
        // ------------------------------------------------------ lifecycle
        init() {
            window.__iaWizard = this;
            // Visual preview route: `?mock=review` renders the review screen
            // with mock data so a UI change can be checked without running a
            // real extraction. No network, no auth, no patient data.
            if (new URLSearchParams(window.location.search).get('mock') === 'review') {
                this.$nextTick(() => this.seedMockPreview());
            }
        },

        /** Seed the mock review state (see `mock-preview.js`). */
        async seedMockPreview() {
            const { seedMockReview } = await import('./mock-preview.js');
            seedMockReview(this);
        },

        /** Page-entry hook, driven by main.js on navigate('import'). */
        async onEnter() {
            if (!getCurrentUser() || this.busy) return;
            this.errorBanner = null;
            if (!this.reviewState) {
                try {
                    await loadOptions();
                } catch {
                    // The section select degrades to empty; the job still works.
                }
            }
            await this.loadEngine();
            if (this.step === 'add') {
                await this.loadOpenJobs();
            }
        },

        /**
         * Which engine the import runs on.
         *
         * The clinic chooses the engine in the settings; the wizard only
         * shows which one is in use, so a job never runs on an engine the
         * clinic did not pick.
         */
        async loadEngine() {
            const state = await loadImportState();
            if (!state) return;
            this.engine = state.engine;
            this.localAvailable = state.localEnabled === true;
            // The runtime settings the clinic saved in the settings card.
            this.localConfig = state.localConfig ?? null;
            this.localModelReady = this.engine !== 'local' ? true : await this.hasLocalModel();
        },

        /** True when a usable local model is set up on this computer. */
        async hasLocalModel() {
            try {
                const { loadProfile, profileComplete, profileNeedsRepair } = await import('./local/model-profile.js');
                const profile = await loadProfile();
                if (!profile || !profileComplete(profile)) return false;
                const slot = profile.mode === 'single' ? profile.multimodal : profile.text;
                // A name without a handle is a profile copied from another
                // browser (or one saved before handles were kept). It cannot
                // be loaded until the clinic picks the file again.
                return Boolean(slot?.handle) && !profileNeedsRepair(slot);
            } catch {
                return false;
            }
        },

        t(key, params) {
            return t(key, params);
        },

        // ------------------------------------------------------ step state
        step: 'add', // add | extracting | review
        busy: false,
        busyLabel: '',

        // add step
        files: [],
        pastedText: '',
        hints: '',
        section: '',
        showMore: false,
        resumable: null,
        // Every import of this account that is still open.
        openJobs: [],
        // Which engine the import runs on: 'cloud' sends the data to a
        // provider, 'local' runs the model in this browser. The engine the
        // clinic selected in the settings wins; the wizard only shows which
        // one is in use.
        engine: 'cloud',
        localAvailable: false,
        localModelReady: true,
        localPhase: '',
        // The runtime settings the clinic saved in the settings card.
        localConfig: null,

        // extraction
        job: null,
        jobStatus: '',
        banners: [],
        progress: { done: 0, total: 0, failed: 0, truncated: 0, nextLabel: '', tokens: null },
        cancelRequested: false,
        pumpActive: false,
        // A pump that died (the worker hit its own limit): the import is
        // still there and can be resumed.
        pumpFailed: false,
        pumpAttempts: 0,
        pumpError: null,
        // The local run's abort handle and the phase it is in.
        localAbort: null,

        // review
        reviewState: null,
        filter: 'all',
        reviewMode: 'simple',
        expandedRowId: null,
        nextIssueIndex: 0,
        strip: null,
        sectionPicker: '',
        fillField: '',
        fillValue: '',
        fillOnlyEmpty: true,
        confirmStripOpen: false,
        selected: [],
        drawerOpen: false,
        drawerRowId: null,
        drawerField: null,
        sourceOpen: false,
        tray: null, // 'rejected' | 'removed' | null
        showDefaults: false,
        defaultsDraft: {},
        bulkOpen: false,
        bulkCount: 0,
        bulkField: '',
        bulkValue: '',
        bulkMode: 'blanks',
        confirmOpen: false,
        confirmNote: '',
        // The number of the newest review load (an older one must stay quiet).
        loadId: 0,
        // The save queue: one batch at a time.
        saveQueue: null,
        // The commit: the key makes a retry idempotent.
        commitKey: null,
        committing: false,
        commitResult: null,
        undoStack: [],
        redoStack: [],
        saveState: 'saved',
        errorBanner: null,
        loadError: null,
        cardLimit: 30,
        grid: { scrollTop: 0, viewport: 560, rowHeight: 52 },

        // cell editor internals
        drafts: {},
        editTimers: {},
        focusRowId: null,
        focusField: null,

        get fields() {
            return FIELDS;
        },

        get bulkFields() {
            return BULK_FILL_FIELDS;
        },

        get locale() {
            return getLocale();
        },

        get maxFiles() {
            return LIMITS.MAX_FILES;
        },

        get maxMb() {
            return Math.round(LIMITS.MAX_FILE_BYTES / (1000 * 1024));
        },

        get maxRows() {
            return LIMITS.MAX_ROWS;
        },

        get sectionOptions() {
            return activeOptions('section');
        },

        optionDisplay(option) {
            if (!option) return '';
            const locale = getLocale();
            return (locale === 'ar' ? option.label_ar : option.label_en) || option.key || '';
        },

        formatBytes(n) {
            return api.formatBytes(n);
        },

        get hasFailedChunks() {
            if (this.progress.failed > 0) return true;
            return (this.banners ?? []).some((banner) => banner.code === 'CHUNKS_FAILED');
        },

        chunkRef(chunkId) {
            const chunk = this.reviewState?.chunksById.get(chunkId)
                ?? (this.chunks ?? []).find((entry) => entry.id === chunkId);
            return chunk ? `#${chunk.idx}` : '';
        },

        highlightSegments(text, needle) {
            return review.highlightLine(text, needle);
        },

        /** Text-ish editors keep the document direction; digits stay LTR. */
        editorDir(fieldKey) {
            const field = fieldByKey(fieldKey);
            if (!field) return null;
            if (['national_id', 'mobile', 'date_of_birth', 'visit_date', 'age',
                'children_count', 'price'].includes(fieldKey)) return 'ltr';
            return null;
        },

        // ------------------------------------------------------ errors
        showFailure(error) {
            this.errorBanner = {
                messageKey: error?.messageKey || error?.message || 'importAgent.error.INTERNAL',
                params: error?.params ?? error?.details?.params ?? {},
            };
        },

        /**
         * The text of a failure. An unknown code (a platform error the
         * function never saw) must not show a raw translation key.
         */
        errorMessage(error) {
            const key = error?.messageKey || 'importAgent.error.INTERNAL';
            const text = this.t(key, error?.params ?? error?.details?.params ?? {});
            if (text !== key) return text;
            const fallback = this.t('importAgent.error.INTERNAL');
            const code = error?.code ? ` (${error.code})` : '';
            return fallback === 'importAgent.error.INTERNAL' ? `${fallback}${code}` : fallback;
        },

        bannerText(banner) {
            return this.t(`importAgent.warn.${banner?.code ?? 'UNKNOWN'}`, banner?.params ?? {});
        },

        bannerRetryText(banner) {
            if (!banner?.retryAfterMs) return '';
            return this.t('importAgent.warn.retryAfter', {
                seconds: Math.ceil(Number(banner.retryAfterMs) / 1000),
            });
        },

        bannerQuotaText(banner) {
            const quota = banner?.freeDaily;
            const limit = typeof quota?.limit === 'number' ? quota.limit : null;
            const remaining = typeof quota?.remaining === 'number' ? quota.remaining : null;
            const used = typeof quota?.used === 'number' ? quota.used : null;
            if (!limit || remaining === null) return '';
            if (remaining > 0) {
                return this.t('importAgent.warn.freeQuota', { remaining, limit });
            }
            return this.t('importAgent.warn.freeQuotaExhausted', {
                used: used ?? Math.max(0, limit - remaining),
                limit,
            });
        },

        // ------------------------------------------------------ add step
        get usableFiles() {
            return this.files.filter((file) => file.sources !== null && !file.error);
        },

        get addBlocked() {
            if (this.busy) return true;
            if (this.usableFiles.length === 0 && !this.pastedText.trim()) return true;
            return false;
        },

        fileIcon(file) {
            if (file.error) return 'bi-exclamation-circle text-danger';
            if (file.kind === 'image') return 'bi-image text-primary';
            if (file.kind === 'pdf') return 'bi-file-earmark-pdf text-danger';
            if (['xlsx', 'xls', 'sheet', 'csv'].includes(file.kind)) return 'bi-file-earmark-spreadsheet text-success';
            if (['docx', 'doc', 'text'].includes(file.kind)) return 'bi-file-earmark-text text-secondary';
            return 'bi-file-earmark text-secondary';
        },

        async analyze() {
            if (this.addBlocked) return;
            await this.extract();
        },

        async onFilesPicked(event) {
            const picked = [...(event.target?.files ?? [])];
            if (event.target) event.target.value = '';
            for (const file of picked) {
                if (this.files.length >= LIMITS.MAX_FILES) break;
                await this.addOneFile(file);
            }
        },

        async addOneFile(file) {
            const entry = {
                id: `file-${Date.now()}-${this.files.length}`,
                file,
                name: file.name,
                size: file.size,
                kind: null,
                sha256: null,
                sources: null,
                warnings: [],
                error: null,
            };
            this.files.push(entry);
            // Mutate the reactive copy, not the raw object: Alpine's proxy wraps
            // the entry on push, and raw writes would leave the row and the
            // Analyze button stuck at their initial state.
            const stored = this.files[this.files.length - 1];
            try {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const verdict = await analyzeFile({ bytes, name: file.name });
                if (!verdict.ok) {
                    stored.error = { code: verdict.code, params: verdict.params ?? {} };
                    return;
                }
                const read = await readFile({ bytes, name: file.name, kind: verdict.kind });
                if (!read.ok) {
                    stored.error = { code: read.code, params: read.params ?? {} };
                    return;
                }
                stored.kind = read.kind ?? verdict.kind;
                stored.sha256 = verdict.sha256 ?? null;
                stored.sources = read.sources;
                stored.warnings = read.warnings ?? [];
            } catch (error) {
                stored.error = { code: 'PARSE_FAILED', params: { name: file.name } };
                console.error('import agent: file read failed', error);
            }
        },

        removeFile(id) {
            this.files = this.files.filter((file) => file.id !== id);
        },

        /**
         * What the local engine needs before the job starts.
         *
         * The models are the ones the clinic picked in the settings; they
         * live in this browser. The job carries the names and the hashes, so
         * a resume knows which model produced the records.
         */
        async localSetup() {
            const [
                { loadProfile, profileComplete, profileNeedsRepair },
                { probeDevice },
                { resolveLocalConfig },
                { localProfileSummary },
                { fileFromHandle },
            ] = await Promise.all([
                import('./local/model-profile.js'),
                import('./local/manifest.js'),
                import('./local/local-config.js'),
                import('@import-core/local-runtime.js'),
                import('./local/model-store.js'),
            ]);
            const profile = await loadProfile();
            if (!profile || !profileComplete(profile)) {
                throw new api.ImportApiError('NO_MODEL_PROFILE');
            }
            // The runner reads the handle, not the name. A profile copied from
            // another browser has the name but no handle, and asking here gives
            // the clinic a specific repair message before a job is created.
            const slot = profile.mode === 'single' ? profile.multimodal : profile.text;
            if (!slot?.handle || profileNeedsRepair(slot)) {
                throw new api.ImportApiError('MODEL_PROFILE_HANDLE_MISSING');
            }
            const file = await fileFromHandle(slot.handle);
            if (!file) {
                throw new api.ImportApiError('MODEL_FILE_UNREACHABLE');
            }
            const device = await probeDevice();
            // The clinic's own settings come first; the device tier fills
            // the gaps.
            const { config } = resolveLocalConfig(device.tier, this.localConfig ?? {});
            return { profile: localProfileSummary(profile), config, tier: device.tier };
        },

        // ------------------------------------------------------ extract
        async extract() {
            if (this.busy) return;
            this.busy = true;
            this.busyLabel = t('importAgent.wizard.sending');
            const isLocal = this.engine === 'local';
            let localProfile = null;
            let localConfig = null;
            let chunkLimits = LIMITS;
            try {
                if (isLocal) {
                    // The local engine runs the model in this browser, so the
                    // models and the runtime settings travel with the job.
                    const local = await this.localSetup();
                    localProfile = local.profile;
                    localConfig = local.config;
                    // The chunks are shaped so they fit the model's context.
                    const { localLimits } = await import('./local/runner.js');
                    chunkLimits = localLimits(local.config);
                }
                const sourcesMeta = this.usableFiles.map((file) => ({ name: file.name }));
                if (this.pastedText.trim()) sourcesMeta.push({ name: 'Typed text' });
                if (sourcesMeta.length === 0) throw new api.ImportApiError('BAD_REQUEST');
                const created = await api.callJob('create', {
                    hints: this.hints.trim().slice(0, LIMITS.MAX_HINT_CHARS),
                    sources_meta: sourcesMeta,
                    section: this.section || null,
                    defaults: {},
                    inference_mode: isLocal ? 'local' : 'cloud',
                    local_profile: localProfile,
                    local_config: localConfig,
                });
                const jobId = created.job_id;
                this.job = await api.fetchJob(jobId);

                // Files first: one upload + one add_source per file, in the
                // same order as `upload_urls`, so the client-side source
                // numbering (shiftSourceIds) matches the server's idx.
                let index = 0;
                for (const file of this.usableFiles) {
                    const upload = created.upload_urls?.[index];
                    if (!upload?.path || !upload?.token) throw new api.ImportApiError('UPLOAD_FAILED');
                    await api.uploadToSignedCell(upload.path, upload.token, file.file);

                    const prepared = prepareSources(file.sources, chunkLimits);
                    // The server numbers sources by add order (its `idx` runs
                    // 1, 2, 3…), so pre-shift the client-chunked pool ids to
                    // match (spec 6.2); the shift is a no-op for the first one.
                    const chunks = shiftSourceIds(prepared.chunks, index + 1);
                    await api.callJob('add_source', {
                        job_id: jobId,
                        kind: prepared.pooled[0]?.kind ?? 'text',
                        name: file.name,
                        mime: file.file?.type ?? null,
                        bytes: file.size,
                        sha256: file.sha256,
                        storage_path: upload.path,
                        warnings: mergeWarnings(file.warnings, prepared.warnings),
                        chunks,
                    });
                    index += 1;
                }
                if (this.pastedText.trim()) {
                    // Pasted text is chunked server-side so client and function
                    // produce identical payloads (spec 6.2).
                    await api.callJob('add_source', {
                        job_id: jobId,
                        kind: 'text',
                        name: 'Typed text',
                        text: this.pastedText.trim(),
                    });
                }

                await api.callJob('start', { job_id: jobId });
                this.step = 'extracting';
                this.jobStatus = 'extracting';
                this.pumpLoop();
            } catch (error) {
                this.showFailure(error);
            } finally {
                this.busy = false;
                this.busyLabel = '';
            }
        },

        async pumpLoop() {
            if (this.pumpActive) return;
            this.pumpActive = true;
            this.cancelRequested = false;
            this.pumpFailed = false;
            try {
                // The local engine does the extraction in this browser; the
                // cloud engine keeps it on the server.
                if (this.job?.config?.inference_mode === 'local') {
                    await this.localPumpLoop();
                    return;
                }
                while (!this.cancelRequested && this.step === 'extracting') {
                    let response;
                    try {
                        response = await api.callJob('pump', { job_id: this.job.id });
                    } catch (error) {
                        // The worker can die (its own resource limit, a gateway
                        // timeout). The job is still there: retry a few times,
                        // then let the user resume instead of leaving a
                        // "Working..." that never ends.
                        this.pumpAttempts += 1;
                        if (this.pumpAttempts <= PUMP_RETRIES) {
                            this.pumpError = error;
                            await sleep(PUMP_RETRY_DELAY * this.pumpAttempts);
                            continue;
                        }
                        this.pumpError = error;
                        this.pumpFailed = true;
                        this.showFailure(error);
                        break;
                    }
                    this.pumpAttempts = 0;
                    this.pumpError = null;
                    this.jobStatus = response.status;
                    this.banners = response.banners ?? [];
                    this.progress = {
                        done: response.done ?? 0,
                        total: response.total ?? 0,
                        failed: response.failed ?? 0,
                        truncated: response.truncated ?? 0,
                        nextLabel: response.next_label ?? '',
                        tokens: response.tokens ?? null,
                    };
                    if (response.status !== 'extracting') break;
                    if ((response.banners ?? []).some((banner) => banner.code === 'USER_DAILY_TOKEN_CAP')) break;
                    // The provider's per-minute budget decides how fast we
                    // may go: a big import on Groq has to wait between chunks.
                    const pace = Math.max(PUMP_DELAY, Number(response.pace_ms ?? 0) || 0);
                    await sleep(pace);
                }
                if (this.cancelRequested) return;
                if (this.jobStatus === 'review') {
                    await this.enterReview();
                } else if (this.jobStatus === 'cancelled') {
                    this.step = 'add';
                    this.job = null;
                }
            } catch (error) {
                this.showFailure(error);
            } finally {
                this.pumpActive = false;
            }
        },

        /**
         * The local pump: the browser claims the chunks and runs the model.
         *
         * The server only keeps the bookkeeping. The progress labels say
         * what the machine is doing, because a local run is slower and the
         * user needs to see that it is working.
         */
        async localPumpLoop() {
            const controller = new AbortController();
            this.localAbort = controller;
            try {
                const { runLocalImport } = await import('./local/runner.js');
                const localResult = await runLocalImport({
                    api,
                    jobId: this.job.id,
                    hints: this.hints?.trim() ?? '',
                    config: this.localConfig ?? {},
                    signal: controller.signal,
                    onProgress: (event) => {
                        if (event?.phase === 'ocr') this.localPhase = 'reading_photos';
                        else if (event?.phase === 'extract') this.localPhase = 'extracting';
                        else if (event?.phase === 'loading_models' || event?.phase === 'loading_model') this.localPhase = 'loading_model';
                        else if (event?.phase === 'done') this.localPhase = '';
                        if (event?.progress) this.progress = { ...this.progress, ...event.progress };
                    },
                });
                // A drift found after the chunk ran is returned rather than
                // thrown (the other parallel chunks have to settle first).
                if (localResult?.error) throw localResult.error;
                this.localPhase = '';
                const overview = await this.loadJobOverview();
                this.jobStatus = overview?.status ?? this.jobStatus;
                if (this.jobStatus === 'review') {
                    await this.enterReview();
                } else if (this.jobStatus === 'cancelled') {
                    this.step = 'add';
                    this.job = null;
                }
            } catch (error) {
                if (error?.code === 'CANCELLED' || this.cancelRequested) {
                    this.step = 'add';
                    this.job = null;
                    return;
                }
                this.pumpError = error;
                this.pumpFailed = true;
                this.showFailure(error);
            } finally {
                this.localAbort = null;
                this.localPhase = '';
                this.pumpActive = false;
            }
        },

        /** Continue an import that stopped (the worker died, the user paused). */
        async resumeImport() {
            if (!this.job || this.busy) return;
            this.pumpFailed = false;
            this.errorBanner = null;
            this.jobStatus = 'extracting';
            this.step = 'extracting';
            this.pumpLoop();
        },

        async retryChunk(jobId, chunkId) {
            try {
                await api.callJob('retry_chunk', { job_id: jobId, chunk_id: chunkId });
                if (this.step === 'extracting') this.pumpLoop();
            } catch (error) {
                this.showFailure(error);
            }
        },

        async cancelJob() {
            if (!this.job) return;
            this.cancelRequested = true;
            // The local run stops in the browser: the model call is aborted
            // and the chunk goes back to the queue.
            this.localAbort?.abort();
            try {
                await api.callJob('cancel', { job_id: this.job.id });
            } catch (error) {
                this.showFailure(error);
                return;
            }
            this.jobStatus = 'cancelled';
            this.step = 'add';
            this.job = null;
            this.banners = [];
        },

        // ------------------------------------------------------ resume
        /**
         * Start a NEW import: everything of the previous one is dropped, so
         * "Import from file or paste" never continues an old job.
         */
        async startNewImport() {
            this.step = 'add';
            this.job = null;
            this.jobStatus = '';
            this.reviewState = null;
            this.files = [];
            this.pastedText = '';
            this.hints = '';
            this.section = '';
            this.showMore = false;
            this.banners = [];
            this.errorBanner = null;
            this.progress = { done: 0, total: 0, failed: 0, truncated: 0, nextLabel: '', tokens: null };
            this.selected = [];
            this.expandedRowId = null;
            this.strip = null;
            this.confirmStripOpen = false;
            this.pumpFailed = false;
            this.pumpError = null;
            this.cancelRequested = true;
            await this.loadOpenJobs();
        },

        /** The imports of this account that are still open, newest first. */
        async loadOpenJobs() {
            try {
                this.openJobs = await api.listOpenJobs();
            } catch {
                this.openJobs = [];
            }
        },

        /** Cancel one open import and drop it from the list. */
        async cancelOpenJob(job) {
            if (!job?.id) return;
            try {
                await api.callJob('cancel', { job_id: job.id });
            } catch (error) {
                this.showFailure(error);
            }
            await this.loadOpenJobs();
        },

        /** A short label for an open import: when it started. */
        openJobLabel(job) {
            if (!job?.created_at) return '';
            const when = new Date(job.created_at);
            if (Number.isNaN(when.getTime())) return '';
            return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        },

        async resume() {
            if (!this.resumable) return;
            const jobId = this.resumable.id;
            this.resumable = null;
            await this.resumeJob(jobId);
        },

        async resumeJob(jobId) {
            this.busy = true;
            this.busyLabel = t('importAgent.review.loading');
            try {
                this.job = await api.fetchJob(jobId);
                if (!this.job) throw new api.ImportApiError('NOT_FOUND');
                if (this.job.status === 'review') {
                    await this.enterReview();
                } else if (this.job.status === 'extracting') {
                    this.step = 'extracting';
                    this.jobStatus = 'extracting';
                    await this.loadJobOverview();
                    this.pumpLoop();
                } else {
                    // 'uploaded': sources are already attached; the add step's
                    // file list cannot be rebuilt, so offer extraction directly.
                    this.step = 'extracting';
                    this.jobStatus = this.job.status;
                    await this.loadJobOverview();
                }
            } catch (error) {
                this.showFailure(error);
            } finally {
                this.busy = false;
                this.busyLabel = '';
            }
        },

        async loadJobOverview() {
            const response = await api.callJob('status', { job_id: this.job.id });
            this.jobStatus = response.status ?? this.job.status;
            this.banners = response.banners ?? [];
            this.progress = {
                done: response.done ?? 0,
                total: response.total ?? 0,
                failed: response.failed ?? 0,
                truncated: response.truncated ?? 0,
                nextLabel: response.next_label ?? '',
                tokens: response.tokens ?? null,
            };
            return response;
        },

        async startSavedExtraction() {
            if (!this.job || this.busy) return;
            try {
                await api.callJob('start', { job_id: this.job.id });
                this.jobStatus = 'extracting';
                this.pumpLoop();
            } catch (error) {
                this.showFailure(error);
            }
        },

        // ------------------------------------------------------ review load
        async enterReview() {
            this.loadError = null;
            this.busy = true;
            this.busyLabel = t('importAgent.review.loading');
            // Every load gets a number; only the newest one may touch the
            // screen. Leaving the page and coming back starts a second load -
            // the first one must not report an error for a screen that is
            // gone.
            const loadId = (this.loadId ?? 0) + 1;
            this.loadId = loadId;
            try {
                const [job, sources, chunks, rows, rejects] = await Promise.all([
                    api.fetchJob(this.job.id),
                    api.fetchSources(this.job.id),
                    api.fetchChunks(this.job.id),
                    api.fetchRows(this.job.id),
                    api.fetchRejects(this.job.id),
                ]);
                if (!job) throw new api.ImportApiError('NOT_FOUND');
                this.job = job;
                this.sources = sources;
                this.chunks = chunks;
                this.rejects = rejects;

                const context = await api.loadExistingContext(rows);
                const defaults = review.defaultsFromRows(
                    rows,
                    job.config?.defaults ?? {},
                );
                this.reviewState = review.createReviewState({
                    rows,
                    chunks,
                    config: job.config ?? {},
                    defaults,
                    today: todayIso(),
                    existing: context.existing,
                    nameDobMatches: context.nameDobMatches,
                });
                this.defaultsDraft = { ...this.reviewState.defaults };

                // Rows saved by the pump can drift from the current rules —
                // re-run everything once and persist the diffs (spec 10.2).
                const changes = review.revalidate(this.reviewState);
                this.selected = [];
                this.bulkOpen = false;
                this.errorBanner = null;
                this.loadError = null;
                this.step = 'review';
                this.$nextTick(() => this.measureGrid());

                if (changes.length > 0) {
                    await this.saveChanges(changes);
                    this.undoStack = [];
                    this.redoStack = [];
                }
            } catch (error) {
                if (loadId !== this.loadId) return; // a newer load took over
                // The screen stays where it is: the user can reload the import
                // instead of losing their place.
                this.loadError = error?.messageKey || 'importAgent.error.LOAD_FAILED';
                this.errorBanner = {
                    messageKey: this.loadError,
                    params: error?.params ?? {},
                };
            } finally {
                if (loadId === this.loadId) {
                    this.busy = false;
                    this.busyLabel = '';
                }
            }
        },

        /** Load the review again (the banner's "Reload"). */
        async reloadReview() {
            if (!this.job) return;
            this.errorBanner = null;
            this.loadError = null;
            await this.enterReview();
        },

        measureGrid() {
            const scroll = this.$refs.gridScroll;
            if (scroll) this.grid.viewport = Math.max(240, scroll.clientHeight);
        },

        // ------------------------------------------------------ derived
        /**
         * Rows in the order they were extracted: chunk order first, then the
         * order inside the chunk. `import_rows.seq` is unique per chunk only,
         * so ordering by `seq` alone interleaves the files.
         */
        orderedRows() {
            if (!this.reviewState) return [];
            const chunkIdx = new Map();
            for (const chunk of this.reviewState.chunksById.values()) {
                chunkIdx.set(chunk.id, chunk.idx ?? 0);
            }
            return [...this.reviewState.rows].sort((a, b) => {
                const chunkDiff = (chunkIdx.get(a.chunk_id) ?? 0) - (chunkIdx.get(b.chunk_id) ?? 0);
                if (chunkDiff !== 0) return chunkDiff;
                return (a.seq ?? 0) - (b.seq ?? 0);
            });
        },

        get visibleRows() {
            if (!this.reviewState) return [];
            return review.riskSort(review.filterRows(this.orderedRows(), this.filter));
        },

        /** Simple mode keeps the extracted order; removed rows are hidden. */
        get simpleRows() {
            if (!this.reviewState) return [];
            return review.filterRows(this.orderedRows(), 'all');
        },

        get recordSections() {
            return RECORD_SECTIONS.map((section) => ({
                ...section,
                fields: section.keys.map((key) => fieldByKey(key)).filter(Boolean),
            }));
        },

        get attentionRows() {
            if (!this.reviewState) return [];
            return review.riskSort(review.filterRows(this.reviewState.rows, 'attention'));
        },

        get nextIssueCount() {
            return this.attentionRows.length;
        },

        get filterChips() {
            const counts = this.counts;
            return [
                { id: 'all', labelKey: 'importAgent.review.pill.all', count: counts.all },
                { id: 'attention', labelKey: 'importAgent.review.pill.attention', count: counts.attention },
                { id: 'duplicates', labelKey: 'importAgent.review.pill.duplicates', count: counts.duplicates },
                { id: 'ready', labelKey: 'importAgent.review.pill.ready', count: counts.ready },
                { id: 'removed', labelKey: 'importAgent.review.pill.removed', count: counts.removed },
            ];
        },

        get gridWindow() {
            return review.virtualWindow({
                scrollTop: this.grid.scrollTop,
                rowHeight: this.grid.rowHeight,
                viewportHeight: this.grid.viewport,
                total: this.visibleRows.length,
            });
        },

        get windowRows() {
            const rows = this.visibleRows;
            return rows.slice(this.gridWindow.start, this.gridWindow.end);
        },

        get cardRows() {
            return this.visibleRows.slice(0, this.cardLimit);
        },

        get counts() {
            if (!this.reviewState) {
                return { all: 0, attention: 0, errors: 0, duplicates: 0, ready: 0, edited: 0, removed: 0 };
            }
            return review.filterCounts(this.reviewState.rows);
        },

        get confirmCounts() {
            if (!this.reviewState) return null;
            return review.confirmationCounts(this.reviewState.rows);
        },

        get rejectedItems() {
            return this.rejects ?? [];
        },

        /** Chunks that failed, with the reason the provider gave. */
        get failedChunks() {
            return (this.chunks ?? []).filter((chunk) => chunk.status === 'failed');
        },

        /** The provider failure behind the failed chunks (model + reason). */
        get providerFailure() {
            const banners = this.banners ?? [];
            return banners.find((banner) => banner.code === 'CHUNKS_RATE_LIMITED')
                ?? banners.find((banner) => banner.code === 'CHUNKS_FAILED')
                ?? null;
        },

        /** The chunk's failure reason, translated (the raw code as fallback). */
        chunkErrorLabel(code) {
            if (!code) return this.t('importAgent.chunkError.PROVIDER_ERROR');
            const key = `importAgent.chunkError.${code}`;
            const value = this.t(key);
            return value === key ? code : value;
        },

        /**
         * The reason a file was rejected. The reader codes live under
         * `importAgent.reject.*`; showing `importAgent.error.*` put a raw
         * translation key in front of the user.
         */
        fileErrorLabel(file) {
            const code = file?.error?.code;
            if (!code) return '';
            const rejectKey = `importAgent.reject.${code}`;
            const rejectValue = this.t(rejectKey);
            if (rejectValue !== rejectKey) return rejectValue;
            const errorKey = `importAgent.error.${code}`;
            const errorValue = this.t(errorKey);
            return errorValue === errorKey ? code : errorValue;
        },

        get rejectedCount() {
            return (this.rejects ?? []).length;
        },

        get removedCount() {
            return (this.reviewState?.rows ?? []).filter((row) => row.removed).length;
        },

        get selectedCount() {
            return this.selected.length;
        },

        get allVisibleSelected() {
            const rows = this.visibleRows;
            return rows.length > 0 && rows.every((row) => this.selected.includes(row.id));
        },

        get enumSnapshot() {
            return this.reviewState?.config?.enum_snapshot ?? {};
        },

        get sourceModel() {
            if (!this.sourceOpen || !this.drawerRowId) return null;
            const row = review.rowById(this.reviewState, this.drawerRowId);
            if (!row) return null;
            return review.sourceModel(this.reviewState, row, this.drawerField);
        },

        get drawerRow() {
            return this.drawerRowId ? review.rowById(this.reviewState, this.drawerRowId) : null;
        },

        get partnerRow() {
            const row = this.drawerRow;
            if (!row) return null;
            return review.duplicatePartner(this.reviewState.rows, row);
        },

        // ------------------------------------------------------ review surface
        setReviewMode(mode) {
            this.reviewMode = mode === 'advanced' ? 'advanced' : 'simple';
            this.expandedRowId = null;
            this.selected = [];
            this.strip = null;
        },

        isExpanded(row) {
            return this.expandedRowId === row?.id;
        },

        toggleRecord(row) {
            this.expandedRowId = this.isExpanded(row) ? null : row.id;
        },

        recordFieldValue(row, fieldKey) {
            return this.drawerFieldValue(row, fieldKey);
        },

        isLongField(fieldKey) {
            return LONG_FIELDS.has(fieldKey);
        },

        isNotesField(fieldKey) {
            return this.editorType(fieldKey) === 'notes';
        },

        isRequiredField(fieldKey) {
            return fieldByKey(fieldKey)?.required === true;
        },

        displayCell(row, fieldKey) {
            const value = review.cellValues(row)[fieldKey];
            if (fieldKey === 'notes') {
                const count = Array.isArray(value) ? value.length : value ? 1 : 0;
                return count > 0 ? this.t('importAgent.review.cell.notesCount', { count }) : '';
            }
            if (fieldKey === 'governorate' || fieldKey === 'follower' || fieldKey === 'section'
                || fieldKey === 'source_of_money' || fieldKey === 'marital_status') {
                const option = this.editorOptions(fieldKey).find(
                    (entry) => String(entry.value) === String(value ?? ''),
                );
                return option?.label ?? (value === null || value === undefined ? '' : String(value));
            }
            if (fieldKey === 'date_of_birth' || fieldKey === 'visit_date') {
                return this.editorValue(row, fieldKey);
            }
            if (value === null || value === undefined) return '';
            if (Array.isArray(value)) return value.join(', ');
            return String(value);
        },

        rowTint(row) {
            if (row?.dup?.kind && !row.removed) return 'ia-row-dup';
            const status = review.effectiveStatus(row);
            if (status === 'error') return 'ia-row-bad';
            if (status === 'review') return 'ia-row-check';
            return '';
        },

        /** The row's number in the extracted order (1-based, whole job). */
        rowNumber(row) {
            if (!row) return '';
            const index = this.orderedRows().findIndex((entry) => entry.id === row.id);
            return index >= 0 ? index + 1 : (row.seq ?? '');
        },

        /**
         * True when the row still needs the reviewer's attention: an error or
         * an unacknowledged warning - field-level warnings included. The
         * "Row looks good" button is the only way to acknowledge a warning,
         * so it must appear for every row that blocks the import.
         */
        hasRowIssues(row) {
            if (!row) return false;
            if (review.unackWarnCount(row) > 0) return true;
            return (row.issues ?? []).some((entry) => entry.severity === 'error');
        },

        markerIcon(row) {
            if (row?.removed) return 'bi-arrow-counterclockwise text-secondary';
            if (row?.dup && !row.collapsed) return 'bi-files text-info';
            const status = review.effectiveStatus(row);
            if (status === 'error') return 'bi-x-octagon-fill text-danger';
            if (status === 'review') return 'bi-exclamation-triangle-fill text-warning';
            return 'bi-check-circle text-success opacity-50';
        },

        rowIssueSummary(row) {
            const list = dedupeIssues(row?.issues ?? []).map((issue) => {
                const message = this.issueMessage(issue);
                return issue.field ? `${this.fieldLabel(issue.field)}: ${message}` : message;
            });
            if (list.length > 0) return list[0];
            if (row?.dup?.kind) return this.dupKindLabel(row.dup.kind);
            return '';
        },

        sourceForRow(row) {
            if (!this.reviewState || !row) return null;
            return review.sourceModel(this.reviewState, row, null);
        },

        duplicatePartnerFor(row) {
            if (!this.reviewState || !row) return null;
            return review.duplicatePartner(this.reviewState.rows, row);
        },

        sourceSnippet(row) {
            const model = this.sourceForRow(row);
            if (!model) return '';
            const line = model.lines.find((entry) => entry.cited) ?? model.lines[0];
            return line?.text ?? '';
        },

        /** The file the row came from, with its kind. */
        sourceFor(row) {
            if (!row || !this.reviewState) return null;
            const chunk = row.chunk_id ? this.reviewState.chunksById.get(row.chunk_id) : null;
            const sourceId = chunk?.source_id ?? row.source_id ?? null;
            return this.sources?.find((source) => source.id === sourceId) ?? null;
        },

        /**
         * True when the row came from an image: only images are attached to
         * the patient, a spreadsheet stays a spreadsheet.
         */
        isImageSource(row) {
            return this.sourceFor(row)?.kind === 'image';
        },

        /** The photos of a note, when the row came from an image. */
        sourceImages(row) {
            const model = this.sourceForRow(row);
            return model?.kind === 'image' ? (model.images ?? []) : [];
        },

        sourceLabel(row) {
            const name = this.sourceName(row);
            if (!name) return this.t('importAgent.review.source.manual');
            return `${name}${this.chunkLabel(row) ? ` · ${this.chunkLabel(row)}` : ''}`;
        },

        nextIssue() {
            const rows = this.attentionRows;
            if (rows.length === 0) return;
            const row = rows[this.nextIssueIndex % rows.length];
            this.nextIssueIndex = (this.nextIssueIndex + 1) % rows.length;
            this.reviewMode = 'advanced';
            this.filter = 'all';
            this.expandedRowId = row.id;
            // The advanced table is created by x-if, so it only exists after
            // the next render.
            this.$nextTick(() => {
                this.$nextTick(() => {
                    document.getElementById(`review-row-advanced-${row.id}`)?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center',
                    });
                });
            });
        },

        toggleStrip(name) {
            this.strip = this.strip === name ? null : name;
        },

        applySectionPicker() {
            if (!this.sectionPicker || !this.reviewState) return;
            const ids = this.reviewState.rows
                .filter((row) => !row.removed && !review.cellValues(row).section)
                .map((row) => row.id);
            if (ids.length === 0) return;
            const changes = review.setValueForRows(this.reviewState, {
                ids,
                fieldKey: 'section',
                raw: this.sectionPicker,
                mode: 'blanks',
            });
            this.commit('section', changes);
        },

        applyFill() {
            if (!this.fillField || !this.reviewState) return;
            const ids = this.reviewState.rows.filter((row) => !row.removed).map((row) => row.id);
            const changes = review.setValueForRows(this.reviewState, {
                ids,
                fieldKey: this.fillField,
                raw: this.fillValue,
                mode: this.fillOnlyEmpty ? 'blanks' : 'overwrite',
            });
            this.commit('fill', changes);
        },

        openConfirmStrip() {
            this.confirmStripOpen = true;
            this.confirmNote = '';
        },

        closeConfirmStrip() {
            this.confirmStripOpen = false;
        },

        confirmFromBar() {
            this.confirmOpen = true;
            this.confirmNote = '';
        },

        // ------------------------------------------------------ labels
        fieldLabel(fieldKey) {
            const field = fieldByKey(fieldKey);
            if (!field) return fieldKey;
            const locale = getLocale();
            return field.label?.[locale] ?? field.label?.en ?? fieldKey;
        },

        issueMessage(issue) {
            const code = issue?.code ?? '';
            const reason = issue?.detail?.reason;
            if (code === 'DATE_RANGE' && reason && typeof reason === 'string') {
                const variant = `importAgent.issue.DATE_RANGE_${reason}`;
                if (t(variant) !== variant) return this.t(variant, issue.detail ?? {});
            }
            return this.t(`importAgent.issue.${code}`, issue?.detail ?? {});
        },

        statusChip(row) {
            if (row.removed) return { label: this.t('importAgent.review.chip.removed'), cls: 'text-bg-secondary' };
            if (row.dup?.kind) return { label: this.t('importAgent.review.chip.duplicate'), cls: 'text-bg-info' };
            const status = review.effectiveStatus(row);
            if (status === 'error') return { label: this.t('importAgent.review.chip.error'), cls: 'text-bg-danger' };
            if (status === 'review') return { label: this.t('importAgent.review.chip.review'), cls: 'text-bg-warning' };
            return { label: this.t('importAgent.review.chip.ready'), cls: 'text-bg-success' };
        },

        dupKindLabel(kind) {
            const map = {
                in_batch: 'importAgent.review.dup.inBatch',
                existing_visible: 'importAgent.review.dup.existing',
                existing_hidden: 'importAgent.review.dup.hidden',
                possible: 'importAgent.review.dup.possible',
                name_dob: 'importAgent.review.dup.nameDob',
            };
            return map[kind] ? this.t(map[kind]) : '';
        },

        /** Variant chips under the status chip (duplicates, edited, removed). */
        rowBadges(row) {
            const badges = [];
            if (row.dup?.kind) {
                const label = this.dupKindLabel(row.dup.kind);
                if (label) badges.push(label);
            }
            if (row.collapsed) badges.push(this.t('importAgent.review.dup.collapsed'));
            if (review.isEdited(row)) badges.push(this.t('importAgent.review.cell.edited'));
            return badges;
        },

        cellIssueList(row, fieldKey) {
            return dedupeIssues(review.cellIssues(row, fieldKey)).map((issue) => this.issueMessage(issue));
        },

        /**
         * The colour of a cell's issues: an error is red, a warning amber and
         * an information quiet. Everything red made a note like "the date of
         * birth was taken from the national ID" look like a failure.
         */
        cellIssueClass(row, fieldKey) {
            const state = review.cellState(row, fieldKey);
            if (state.severity === 'error') return 'text-danger';
            if (state.severity === 'warn') return 'text-warning-emphasis';
            return 'text-muted';
        },

        /** Where a cell's value comes from: extracted, derived, default, user. */
        cellOrigin(row, fieldKey) {
            return row?.cells?.[fieldKey]?.origin ?? null;
        },

        /** The age is only read-only while it is the derived one. */
        isDerivedAge(row) {
            return this.cellOrigin(row, 'age') === 'derived';
        },

        cellStateClass(row, fieldKey) {
            const state = review.cellState(row, fieldKey);
            const classes = [];
            if (state.severity === 'error') classes.push('ia-cell-error');
            else if (state.severity === 'warn') classes.push('ia-cell-warn');
            else if (state.icon === 'question' || state.icon === 'snap' || state.icon === 'derived'
                || state.icon === 'default' || state.icon === 'edited') classes.push('ia-cell-source');
            if (state.issues.some((issue) => issue.severity === 'info') && !state.severity) classes.push('ia-cell-info');
            return classes.join(' ');
        },

        cellIconClass(row, fieldKey) {
            const state = review.cellState(row, fieldKey);
            const icons = {
                error: 'bi-x-octagon-fill',
                warn: 'bi-exclamation-triangle-fill',
                question: 'bi-question-circle',
                snap: 'bi-arrow-left-right',
                derived: 'bi-calculator',
                default: 'bi-inboxes-fill',
                edited: 'bi-pencil',
            };
            return state.icon ? (icons[state.icon] ?? '') : '';
        },

        cellTitle(row, fieldKey) {
            if (!row || row.removed) return '';
            const list = this.cellIssueList(row, fieldKey);
            if (list.length > 0) return list.join('\n');
            const state = review.cellState(row, fieldKey);
            const map = {
                snap: 'importAgent.review.cell.snapped',
                derived: 'importAgent.review.cell.derived',
                default: 'importAgent.review.cell.default',
                question: 'importAgent.review.cell.uncertain',
            };
            return map[state.icon] ? this.t(map[state.icon]) : '';
        },

        // ------------------------------------------------------ editors
        editorType(fieldKey) {
            const field = fieldByKey(fieldKey);
            if (!field) return 'text';
            if (field.type === 'date') return 'date';
            if (field.type === 'integer' || field.type === 'number') return 'number';
            if (field.type === 'enum') return 'select';
            if (field.type === 'list') return 'notes';
            return 'text';
        },

        editorOptions(fieldKey) {
            return review.enumOptions(fieldKey, this.enumSnapshot, getLocale());
        },

        /** Text shown for an editor while the cell holds no user draft. */
        editorValue(row, fieldKey) {
            const key = `${row.id}:${fieldKey}`;
            if (key in this.drafts) return this.drafts[key];
            const cell = row.cells?.[fieldKey];
            if (this.editorType(fieldKey) === 'date') return dateDisplayValue(cell);
            if (this.editorType(fieldKey) === 'select') return cell?.value ?? '';
            if (this.editorType(fieldKey) === 'notes') return '';
            const value = cell?.value;
            if (value === null || value === undefined || Array.isArray(value)) return '';
            return String(value);
        },

        editorPlaceholder(row, fieldKey) {
            const type = this.editorType(fieldKey);
            if (type === 'date') return 'dd/mm/yyyy';
            if (type === 'notes') {
                const values = review.cellValues(row);
                const notes = values.notes;
                const count = Array.isArray(notes) ? notes.length : notes ? 1 : 0;
                return count > 0 ? this.t('importAgent.review.cell.notesCount', { count }) : '';
            }
            return '';
        },

        onEditorFocus(row, fieldKey) {
            this.focusRowId = row.id;
            this.focusField = fieldKey;
            if (this.editorType(fieldKey) !== 'date') return;
            // While focused, a text date shows the reviewer's own spelling.
            const cell = row.cells?.[fieldKey];
            const raw = typeof cell?.raw === 'string' && cell.raw.trim() ? cell.raw : '';
            if (raw) this.drafts[`${row.id}:${fieldKey}`] = raw;
        },

        onEditorInput(row, fieldKey, value) {
            const key = `${row.id}:${fieldKey}`;
            this.drafts[key] = value;
            clearTimeout(this.editTimers[key]);
            this.editTimers[key] = setTimeout(() => this.flushCell(row, fieldKey), 400);
        },

        onEditorBlur(row, fieldKey) {
            if (this.focusRowId === row.id && this.focusField === fieldKey) {
                this.focusRowId = null;
                this.focusField = null;
            }
            if (this.editorType(fieldKey) === 'date') {
                // Text dates may not parse; the raw text is kept for the rules
                // engine to judge. Only clear the draft when nothing was typed.
                const key = `${row.id}:${fieldKey}`;
                const value = this.drafts[key];
                if (value === undefined || value === '') this.clearDraft(key);
            }
        },

        clearDraft(key) {
            delete this.drafts[key];
            clearTimeout(this.editTimers[key]);
            delete this.editTimers[key];
        },

        onDatePicked(row, fieldKey, event) {
            const value = event.target?.value ?? '';
            const key = `${row.id}:${fieldKey}`;
            if (!value) return;
            const [year, month, day] = value.split('-');
            this.drafts[key] = `${day}/${month}/${year}`;
            this.flushCell(row, fieldKey);
            event.target.value = '';
        },

        async flushCell(row, fieldKey) {
            const key = `${row.id}:${fieldKey}`;
            const value = this.drafts[key];
            if (value === undefined) return;
            this.clearDraft(key);
            const typed = typeof value === 'string' ? value : String(value ?? '');
            const current = row.cells?.[fieldKey]?.raw;
            if (this.editorType(fieldKey) === 'date' || typeof current === 'string') {
                if (String(current ?? '') === typed) return;
            }
            await this.commit(`edit ${fieldKey}`, review.editCell(this.reviewState, row.id, fieldKey, typed));
        },

        onEnumChange(row, fieldKey, value) {
            const raw = value === '' ? '' : value;
            this.commit(`set ${fieldKey}`, review.editCell(this.reviewState, row.id, fieldKey, raw));
        },

        revertCell(row, fieldKey) {
            this.commit(`revert ${fieldKey}`, review.revertCell(this.reviewState, row.id, fieldKey));
        },

        // ------------------------------------------------------ selection
        rowSelected(row) {
            return this.selected.includes(row.id);
        },

        toggleSelect(row) {
            this.selected = this.rowSelected(row)
                ? this.selected.filter((id) => id !== row.id)
                : [...this.selected, row.id];
        },

        toggleSelectAll() {
            const ids = this.visibleRows.map((row) => row.id);
            this.selected = this.allVisibleSelected ? [] : ids;
        },

        clearSelection() {
            this.selected = [];
        },

        // ------------------------------------------------------ history
        async commit(label, changes) {
            if (!changes || changes.length === 0) return;
            this.undoStack.push({ label, changes });
            if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
            this.redoStack = [];
            await this.saveChanges(changes);
        },

        /**
         * Save the changed rows.
         *
         * The saves run one after the other (never two at the same time):
         * two loops that read the same row version would make the second one
         * fail with "this row changed elsewhere" - which is what happened
         * when the review was opened, left and opened again while the first
         * save was still running. The rows of one batch go out in small
         * parallel groups, so a 50-row re-validation is not 50 round-trips.
         */
        async saveChanges(changes) {
            if (!this.reviewState || !changes || changes.length === 0) {
                this.saveState = 'saved';
                return;
            }
            const run = async () => {
                this.saveState = 'saving';
                let failed = false;
                for (const group of chunksOf(changes, 8)) {
                    const results = await Promise.all(group.map(async (change) => {
                        const row = review.rowById(this.reviewState, change.id);
                        if (!row) return null;
                        try {
                            // The snapshot's stored version can go stale
                            // (undo/redo restore, or a snapshot taken before
                            // an earlier save in the same batch lands). The
                            // guard always wants the row's CURRENT version:
                            // match on it, increment from it.
                            const payload = { ...change.after, version: row.version ?? change.after.version ?? 1 };
                            const saved = await api.saveRow(row, payload);
                            row.version = saved?.version ?? row.version;
                            return null;
                        } catch (error) {
                            return error;
                        }
                    }));
                    const error = results.find((entry) => entry);
                    if (error) {
                        failed = true;
                        if (error.code === 'SAVE_CONFLICT') {
                            this.errorBanner = { messageKey: 'importAgent.error.SAVE_CONFLICT' };
                        } else {
                            this.errorBanner = {
                                messageKey: error.messageKey || 'importAgent.error.SAVE_FAILED',
                                params: error.params ?? {},
                            };
                        }
                        break;
                    }
                }
                this.saveState = failed ? 'failed' : 'saved';
            };
            // Chain onto the queue: the next batch starts when this one is done.
            this.saveQueue = (this.saveQueue ?? Promise.resolve()).then(run, run);
            return this.saveQueue;
        },

        async undo() {
            const entry = this.undoStack.pop();
            if (!entry) return;
            const changes = [];
            for (const change of [...entry.changes].reverse()) {
                const row = review.rowById(this.reviewState, change.id);
                if (!row) continue;
                review.applySnapshot(row, change.before);
                changes.push({ id: change.id, before: change.after, after: change.before });
            }
            this.redoStack.push(entry);
            await this.saveChanges(changes);
        },

        async redo() {
            const entry = this.redoStack.pop();
            if (!entry) return;
            const changes = [];
            for (const change of [...entry.changes].reverse()) {
                const row = review.rowById(this.reviewState, change.id);
                if (!row) continue;
                review.applySnapshot(row, change.after);
                changes.push({ id: change.id, before: change.before, after: change.after });
            }
            this.undoStack.push(entry);
            if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
            await this.saveChanges(changes);
        },

        // ------------------------------------------------------ operations
        async applyDefaults() {
            if (!this.reviewState) return;
            const cleaned = {};
            for (const [key, value] of Object.entries(this.defaultsDraft ?? {})) {
                if (value !== null && value !== undefined && value !== '') cleaned[key] = value;
            }
            await this.commit('defaults', review.setDefaults(this.reviewState, cleaned));
        },

        openBulk() {
            if (this.selected.length === 0) return;
            this.bulkCount = this.selected.length;
            this.bulkField = '';
            this.bulkValue = '';
            this.bulkMode = 'blanks';
            this.bulkOpen = true;
        },

        /** Filter chips reset the selection; the bulk modal must close with it. */
        changeFilter(pill) {
            this.filter = pill;
            this.selected = [];
            this.bulkOpen = false;
        },

        async applyBulk() {
            if (!this.bulkField || this.selected.length === 0) {
                this.bulkOpen = false;
                return;
            }
            const raw = this.bulkValue;
            const changes = review.setValueForRows(this.reviewState, {
                ids: this.selected,
                fieldKey: this.bulkField,
                raw,
                mode: this.bulkMode,
            });
            this.bulkOpen = false;
            await this.commit(`bulk ${this.bulkField}`, changes);
        },

        async deleteSelected() {
            if (this.selected.length === 0) return;
            const changes = review.setRemoved(this.reviewState, this.selected, true);
            await this.commit('remove', changes);
            this.selected = [];
        },

        async restoreSelected() {
            if (this.selected.length === 0) return;
            const changes = review.setRemoved(this.reviewState, this.selected, false);
            await this.commit('restore', changes);
            this.selected = [];
        },

        async markReviewedSelected() {
            if (this.selected.length === 0) return;
            const changes = review.markReviewed(this.reviewState, this.selected);
            await this.commit('review', changes);
            this.selected = [];
        },

        async markRow(row) {
            await this.commit('review', review.markReviewed(this.reviewState, [row.id]));
        },

        /** Requeue every failed chunk; works from extracting AND review. */
        async retryFailed() {
            if (!this.job || this.busy) return;
            this.busy = true;
            this.busyLabel = t('importAgent.review.retryChunk');
            try {
                const chunks = await api.fetchChunks(this.job.id);
                this.chunks = chunks;
                const failed = chunks.filter((chunk) => chunk.status === 'failed');
                for (const chunk of failed) {
                    await api.callJob('retry_chunk', { job_id: this.job.id, chunk_id: chunk.id });
                }
                if (failed.length > 0) {
                    if (this.step === 'extracting') {
                        this.pumpLoop();
                    } else {
                        await this.pumpAndReload();
                    }
                }
            } catch (error) {
                this.showFailure(error);
            } finally {
                this.busy = false;
                this.busyLabel = '';
            }
        },

        /** Pump a job that left the extracting state, then re-enter review. */
        async pumpAndReload() {
            try {
                this.step = 'extracting';
                this.jobStatus = 'extracting';
                for (;;) {
                    const response = await api.callJob('pump', { job_id: this.job.id });
                    this.jobStatus = response.status;
                    this.banners = response.banners ?? [];
                    this.progress = {
                        done: response.done ?? 0,
                        total: response.total ?? 0,
                        failed: response.failed ?? 0,
                        truncated: response.truncated ?? 0,
                        nextLabel: response.next_label ?? '',
                        tokens: response.tokens ?? null,
                    };
                    if (response.status !== 'extracting') break;
                    if ((response.banners ?? []).some((banner) => banner.code === 'USER_DAILY_TOKEN_CAP')) break;
                    await sleep(PUMP_DELAY);
                }
                if (this.jobStatus === 'review') await this.enterReview();
            } catch (error) {
                this.showFailure(error);
            }
        },

        async removeRow(row) {
            await this.commit('remove', review.setRemoved(this.reviewState, [row.id], true));
        },

        async restoreRow(row) {
            await this.commit('restore', review.setRemoved(this.reviewState, [row.id], false));
        },

        async setDupAction(row, action) {
            await this.commit('dup', review.setDupAction(this.reviewState, row.id, action));
        },

        async keepDupRow(row) {
            // Keeping this row = skipping the partner's copy.
            const partner = review.duplicatePartner(this.reviewState.rows, row);
            const changes = review.setDupAction(this.reviewState, row.id, 'keep');
            let partnerChanges = [];
            if (partner && partner.dup && !partner.collapsed) {
                partnerChanges = review.setDupAction(this.reviewState, partner.id, 'skip');
            }
            await this.commit('dup keep', [...partnerChanges, ...changes]);
        },

        async addRowAction() {
            if (!this.job) return;
            try {
                this.busy = true;
                this.busyLabel = t('importAgent.review.addRow');
                const created = await api.callJob('add_row', { job_id: this.job.id });
                const row = {
                    ...created.row,
                    src: created.row?.src ?? [],
                    collapsed: false,
                };
                this.reviewState.rows.push(row);
                const changes = review.revalidate(this.reviewState, {
                    touched: new Set([row.id]),
                });
                await this.commit('add row', changes);
                this.drawerRowId = row.id;
                this.drawerField = null;
                this.drawerOpen = true;
            } catch (error) {
                this.showFailure(error);
            } finally {
                this.busy = false;
                this.busyLabel = '';
            }
        },

        // ------------------------------------------------------ drawer
        openDrawer(row, fieldKey = null) {
            this.drawerRowId = row.id;
            this.drawerField = fieldKey;
            this.drawerOpen = true;
            if (fieldKey) this.showSource(row, fieldKey);
        },

        closeDrawer() {
            this.drawerOpen = false;
            this.drawerRowId = null;
            this.drawerField = null;
            this.sourceOpen = false;
        },

        showSource(row, fieldKey = null) {
            this.drawerRowId = row?.id ?? this.drawerRowId;
            this.drawerField = fieldKey;
            this.sourceOpen = true;
        },

        drawerFieldValue(row, fieldKey) {
            const cell = row.cells?.[fieldKey];
            const type = this.editorType(fieldKey);
            if (type === 'date') {
                const raw = typeof cell?.raw === 'string' && cell.raw.trim() ? cell.raw : '';
                return raw || dateDisplayValue(cell);
            }
            if (type === 'notes') return '';
            if (cell?.value === null || cell?.value === undefined) return '';
            if (Array.isArray(cell.value)) return '';
            return String(cell.value);
        },

        async drawerFieldChange(row, fieldKey, value) {
            const type = this.editorType(fieldKey);
            if (type === 'date' && value) {
                const [year, month, day] = String(value).split('-');
                const typed = `${day}/${month}/${year}`;
                await this.commit(`edit ${fieldKey}`, review.editCell(this.reviewState, row.id, fieldKey, typed));
                return;
            }
            if (type === 'notes') return;
            await this.commit(`edit ${fieldKey}`, review.editCell(this.reviewState, row.id, fieldKey, value));
        },

        noteList(row) {
            const raw = row.cells?.notes?.raw;
            if (Array.isArray(raw)) return raw;
            const value = review.cellValues(row).notes;
            if (Array.isArray(value)) return value;
            if (typeof value === 'string' && value.trim()) return [value];
            return [];
        },

        async noteChange(row, index, value) {
            const list = [...this.noteList(row)];
            if (index < 0 || index >= list.length) return;
            list[index] = value;
            await this.commit('notes', review.editCell(this.reviewState, row.id, 'notes', list));
        },

        async noteAdd(row) {
            const list = [...this.noteList(row), ''];
            await this.commit('notes', review.editCell(this.reviewState, row.id, 'notes', list));
        },

        async noteRemove(row, index) {
            const list = [...this.noteList(row)];
            if (index < 0 || index >= list.length) return;
            list.splice(index, 1);
            await this.commit('notes', review.editCell(this.reviewState, row.id, 'notes', list));
        },

        async noteMove(row, index, direction) {
            const list = [...this.noteList(row)];
            const target = index + direction;
            if (target < 0 || target >= list.length) return;
            [list[index], list[target]] = [list[target], list[index]];
            await this.commit('notes', review.editCell(this.reviewState, row.id, 'notes', list));
        },

        // ------------------------------------------------------ trays
        selectTray(which) {
            this.tray = this.tray === which ? null : which;
        },

        trayReasonLabel(reason) {
            const key = `importAgent.review.tray.reason.${reason ?? 'REJECTED'}`;
            const label = this.t(key);
            return label === key ? (reason ?? 'REJECTED') : label;
        },

        trayRow(item) {
            if (!this.reviewState || !item?.chunk_id) return null;
            const seq = item.src?.seq;
            return this.reviewState.rows.find(
                (row) => row.chunk_id === item.chunk_id && (seq === undefined || row.seq === seq),
            ) ?? null;
        },

        /** Append tray text into a row cell — the reviewed version wins. */
        async moveUnmapped(item, fieldKey) {
            const row = this.trayRow(item);
            if (!row) return;
            const cell = row.cells?.[fieldKey];
            const type = this.editorType(fieldKey);
            let raw;
            if (type === 'notes') raw = [...this.noteList(row), item.raw ?? ''];
            else {
                const previous = typeof cell?.raw === 'string' ? cell.raw : String(cell?.value ?? '');
                raw = previous.trim() ? `${previous}\n${item.raw ?? ''}` : item.raw ?? '';
            }
            await this.commit('tray', review.editCell(this.reviewState, row.id, fieldKey, raw));
            await this.deleteReject(item);
        },

        async deleteReject(item) {
            if (!item?.id) return;
            const client = supabase();
            if (!client) return;
            const { error } = await client.from('import_rejects').delete().eq('id', item.id);
            if (error) {
                this.errorBanner = { messageKey: 'importAgent.error.SAVE_FAILED' };
                return;
            }
            this.rejects = (this.rejects ?? []).filter((reject) => reject.id !== item.id);
        },

        async restoreRemovedRow(row) {
            await this.restoreRow(row);
        },

        // ------------------------------------------------------ confirm
        openConfirm() {
            this.confirmNote = '';
            this.confirmOpen = true;
        },

        /**
         * The commit: the reviewed rows become patients.
         *
         * The key is generated once per job, so a retry after a network
         * error commits the same batch instead of a second one.
         */
        async confirmImportNow() {
            if (!this.job || this.committing) return;
            this.committing = true;
            this.confirmNote = '';
            try {
                if (!this.commitKey) this.commitKey = crypto.randomUUID();
                const result = await api.commitJob(this.job.id, this.commitKey);
                this.commitResult = {
                    created: result.created ?? 0,
                    filled: result.filled ?? 0,
                    skipped: result.skipped ?? 0,
                };
                this.confirmStripOpen = false;
                this.confirmOpen = false;
                this.confirmNote = this.t('importAgent.review.confirm.done', this.commitResult);
                // The job is done: it must not show up as an open import.
                this.job = null;
                this.reviewState = null;
                this.step = 'add';
                this.$root?.refreshImportResume?.();
                window.dispatchEvent(new CustomEvent('import-committed'));
            } catch (error) {
                this.showFailure(error);
                this.confirmNote = this.errorMessage(error);
            } finally {
                this.committing = false;
            }
        },

        get confirmImportDisabled() {
            return (this.confirmCounts?.unreviewed ?? 0) > 0;
        },

        confirmImportTitle() {
            const count = this.confirmCounts?.unreviewed ?? 0;
            return this.confirmImportDisabled
                ? this.t('importAgent.review.confirm.reviewFirst', { count })
                : '';
        },

        // ------------------------------------------------------ keyboard
        onCellKeydown(event, row, fieldKey) {
            const type = this.editorType(fieldKey);
            const target = event.target;
            if (event.key === 'Escape') {
                this.clearDraft(`${row.id}:${fieldKey}`);
                target?.blur();
                return;
            }
            if (event.key === 'Enter' && type !== 'notes') {
                event.preventDefault();
                this.moveFocusVertical(target, 1);
                return;
            }
            if (type !== 'select' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                this.moveFocusVertical(target, event.key === 'ArrowDown' ? 1 : -1);
                return;
            }
            if (type === 'select' && event.key.toLowerCase() === 'i') {
                event.preventDefault();
                this.showSource(row, fieldKey);
            }
        },

        moveFocusVertical(target, delta) {
            const cell = target?.closest?.('td');
            const row = cell?.closest?.('tr');
            if (!cell || !row) return;
            const index = [...row.children].indexOf(cell);
            let sibling = row[delta > 0 ? 'nextElementSibling' : 'previousElementSibling'];
            while (sibling) {
                if (sibling.tagName === 'TR') {
                    const nextCell = sibling.children[index];
                    const focusable = nextCell?.querySelector('input, select');
                    if (focusable && !focusable.disabled) {
                        focusable.focus();
                        focusable.select?.();
                        return;
                    }
                }
                sibling = sibling[delta > 0 ? 'nextElementSibling' : 'previousElementSibling'];
            }
        },

        // ------------------------------------------------------ misc
        onGridScroll(event) {
            this.grid.scrollTop = event.target?.scrollTop ?? 0;
            const viewport = event.target?.clientHeight;
            if (viewport) this.grid.viewport = Math.max(240, viewport);
        },

        /**
         * The file a row came from. `import_rows` has no `source_id`: the row
         * points at its chunk and the chunk points at the source.
         */
        sourceName(row) {
            if (!row) return null;
            const chunk = row.chunk_id ? this.reviewState?.chunksById.get(row.chunk_id) : null;
            const sourceId = chunk?.source_id ?? row.source_id ?? null;
            if (!sourceId) return null;
            return this.sources?.find((source) => source.id === sourceId)?.name ?? null;
        },

        chunkLabel(row) {
            if (!row?.chunk_id) return 'Manual';
            const chunk = this.reviewState?.chunksById.get(row.chunk_id);
            return chunk ? `#${chunk.idx}` : null;
        },
    };
}

/**
 * The wizard's own page-entry event. Registered by `main.js`, which cannot
 * reach into Alpine scopes; the component instance registry keeps this loose.
 */
export function importAgentEnter() {
    return window.__iaWizard?.onEnter?.();
}
