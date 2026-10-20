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

const PUMP_DELAY = 800;
const UNDO_LIMIT = 100;

/** The review page, like the pump, needs "today": caller-side clock only. */
function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

export function importAgentWizard() {
    return {
        // ------------------------------------------------------ lifecycle
        init() {
            window.__iaWizard = this;
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
            if (this.step === 'add' && !this.resumable) {
                try {
                    this.resumable = await api.latestResumableJob();
                } catch {
                    this.resumable = null;
                }
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

        // extraction
        job: null,
        jobStatus: '',
        banners: [],
        progress: { done: 0, total: 0, failed: 0, truncated: 0, nextLabel: '', tokens: null },
        cancelRequested: false,
        pumpActive: false,

        // review
        reviewState: null,
        filter: 'all',
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
            };
        },

        bannerText(banner) {
            return this.t(`importAgent.warn.${banner?.code ?? 'UNKNOWN'}`, banner?.params ?? {});
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

        // ------------------------------------------------------ extract
        async extract() {
            if (this.busy) return;
            this.busy = true;
            this.busyLabel = t('importAgent.wizard.sending');
            try {
                const sourcesMeta = this.usableFiles.map((file) => ({ name: file.name }));
                if (this.pastedText.trim()) sourcesMeta.push({ name: 'Typed text' });
                if (sourcesMeta.length === 0) throw new api.ImportApiError('BAD_REQUEST');
                const created = await api.callJob('create', {
                    hints: this.hints.trim().slice(0, LIMITS.MAX_HINT_CHARS),
                    sources_meta: sourcesMeta,
                    section: this.section || null,
                    defaults: {},
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

                    const prepared = prepareSources(file.sources, LIMITS);
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
            try {
                while (!this.cancelRequested && this.step === 'extracting') {
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
                this.step = 'review';
                this.$nextTick(() => this.measureGrid());

                if (changes.length > 0) {
                    await this.saveChanges(changes);
                    this.undoStack = [];
                    this.redoStack = [];
                }
            } catch (error) {
                this.loadError = error?.messageKey ?? 'importAgent.error.LOAD_FAILED';
                this.errorBanner = { messageKey: this.loadError };
                this.step = 'add';
            } finally {
                this.busy = false;
                this.busyLabel = '';
            }
        },

        measureGrid() {
            const scroll = this.$refs.gridScroll;
            if (scroll) this.grid.viewport = Math.max(240, scroll.clientHeight);
        },

        // ------------------------------------------------------ derived
        get visibleRows() {
            if (!this.reviewState) return [];
            return review.riskSort(review.filterRows(this.reviewState.rows, this.filter));
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
                return { all: 0, attention: 0, errors: 0, duplicates: 0, edited: 0, removed: 0 };
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

        async saveChanges(changes) {
            if (!this.reviewState) return;
            this.saveState = 'saving';
            let failed = false;
            for (const change of changes) {
                const row = review.rowById(this.reviewState, change.id);
                try {
                    if (!row) continue;
                    // The snapshot's stored version can go stale (undo/redo
                    // restore, or a snapshot taken before an earlier save in
                    // the same batch lands). The guard always wants the row's
                    // CURRENT version: match on it, increment from it.
                    const payload = { ...change.after, version: row.version ?? change.after.version ?? 1 };
                    const saved = await api.saveRow(row, payload);
                    row.version = saved?.version ?? row.version;
                } catch (error) {
                    failed = true;
                    if (error?.code === 'SAVE_CONFLICT') {
                        this.errorBanner = { messageKey: 'importAgent.error.SAVE_CONFLICT' };
                    } else if (error?.messageKey) {
                        this.errorBanner = { messageKey: error.messageKey };
                    }
                    break;
                }
            }
            this.saveState = failed ? 'failed' : 'saved';
            if (changes.length === 0) this.saveState = 'saved';
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

        confirmImportNow() {
            this.confirmNote = this.t('importAgent.review.confirm.commitPlaceholder');
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

        sourceName(row) {
            if (!row) return null;
            if (row.chunk_id) return this.sources?.find((source) => source.id === row.source_id)?.name ?? null;
            return null;
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
