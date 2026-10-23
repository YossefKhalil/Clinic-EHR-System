import './styles/main.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
// Both builds of Bootstrap are loaded as separate assets, and only ONE of
// them is in the page at a time: the LTR one for the other languages, the
// RTL one for Arabic.
//
// Two builds at once fight each other: they define the same physical
// utilities, and both of them are `!important`, so `.ms-auto` would leave
// an auto margin on the left AND on the right. A group with such a margin
// floats in the middle of its row instead of hugging the end - that was the
// empty strip in the Arabic navbar - and every icon would get a margin on
// the wrong side as well.
import bootstrapLtrUrl from 'bootstrap/dist/css/bootstrap.min.css?url';
import bootstrapRtlUrl from 'bootstrap/dist/css/bootstrap.rtl.min.css?url';
import bootstrapBundle from 'bootstrap/dist/js/bootstrap.bundle.min.js';
import Alpine from 'alpinejs';
import { initI18n, t, setLocale, getLocale } from './services/i18n.js';
import { initSupabase, supabase, getCurrentUser, signInWithIdentifier, signOut } from './services/supabase.js';
import { loadImportEnabled, clearImportFlagCache } from './services/import-flag.js';
import { dbErrorMessage } from './services/error-message.js';
import { loadAiSettings as loadAiSettingsApi, saveAiSettings as saveAiSettingsApi, testAiProvider as testAiProviderApi, loadImportLimits as loadImportLimitsApi, saveImportLimits as saveImportLimitsApi, resetCloudConsent as resetCloudConsentApi } from './services/ai-settings.js';
import {
    browseLocalModel,
    createLocalState,
    emptySlot,
    localProfilePayload,
    pickSupportFiles,
    readDevice,
    resolveConfig,
    restoreLocalState,
    persistLocalState,
    validateLocalConfig,
    verifyLocalModelSlot,
} from './services/ai-local.js';
import { deviceSignals } from './features/import-agent/local/manifest.js';
import { initCloudinary, getImageUrl, isImageAttachment } from './services/cloudinary.js';
import { getDashboardStats, getRecentPatients } from './services/dashboard.js';
import { getPatients, getPatientsPage, deletePatient, togglePatientStatus, GOVERNORATES, governorateLabel } from './services/patients.js';
import { buildPatientPayload } from './services/patient-payload.js';
import { emptyPatientFilters, activeFilterKeys } from './services/patient-filters.js';
import { EXPORT_FIELDS, EXPORT_FIELD_KEYS } from './services/export-fields.js';
import { patientMatchesQuery } from './services/fuzzy.js';
import { getPriceStats } from './services/prices.js';
import { loadOptions as fetchOptions, allOptions, createOption, updateOption, countOptionUsage, deleteOption, optionLabel as lookupOptionLabel } from './services/options.js';
import { buildSearchDictionary, searchTermVariants, maritalStatusLabel } from './services/search-terms.js';
import { importAgentWizard, importAgentEnter } from './features/import-agent/ui.js';
import { GOVERNORATE_BY_ID_CODE, BORN_ABROAD_ID_CODE } from '@import-core/enums.js';

// The local runtime fields that hold text rather than a number. Reading a
// text field as a number turns it into NaN, which the server stores as null.
const LOCAL_TEXT_CONFIG = new Set(['text.chatTemplate', 'text.kvCacheType']);
const LOCAL_TEXT_FIELDS = Object.freeze([
    { group: 'text', key: 'contextTokens', type: 'number', min: 1024, max: 131072, step: 1024, labelKey: 'aiSettings.local.context', hintKey: 'aiSettings.local.contextHint' },
    { group: 'text', key: 'kvCacheType', type: 'select', options: ['f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1'], labelKey: 'aiSettings.local.kvCache', hintKey: 'aiSettings.local.kvCacheHint' },
    { group: 'text', key: 'gpuLayers', type: 'number', min: -1, max: 999, labelKey: 'aiSettings.local.gpuLayers', hintKey: 'aiSettings.local.gpuLayersHint' },
    { group: 'text', key: 'threads', type: 'number', min: 1, max: 16, labelKey: 'aiSettings.local.threads', hintKey: 'aiSettings.local.threadsHint' },
    { group: 'text', key: 'batchSize', type: 'number', min: 32, max: 2048, labelKey: 'aiSettings.local.batch', hintKey: 'aiSettings.local.batchHint' },
    { group: 'text', key: 'ubatchSize', type: 'number', min: 32, max: 2048, labelKey: 'aiSettings.local.ubatch', hintKey: 'aiSettings.local.ubatchHint' },
    { group: 'text', key: 'maxOutputTokens', type: 'number', min: 256, max: 32768, labelKey: 'aiSettings.local.maxOutput', hintKey: 'aiSettings.local.maxOutputHint' },
    { group: 'text', key: 'temperature', type: 'number', min: 0, max: 2, step: 0.1, labelKey: 'aiSettings.local.temperature' },
    { group: 'text', key: 'topK', type: 'number', min: 1, max: 200, labelKey: 'aiSettings.local.topK' },
    { group: 'text', key: 'topP', type: 'number', min: 0, max: 1, step: 0.05, labelKey: 'aiSettings.local.topP' },
    { group: 'text', key: 'repeatPenalty', type: 'number', min: 0.5, max: 2, step: 0.05, labelKey: 'aiSettings.local.repeatPenalty' },
    { group: 'text', key: 'flashAttention', type: 'switch', labelKey: 'aiSettings.local.flashAttention' },
    { group: 'text', key: 'mmap', type: 'switch', labelKey: 'aiSettings.local.mmap' },
    { group: 'text', key: 'enableThinking', type: 'switch', labelKey: 'aiSettings.local.allowThinking' },
    { group: 'text', key: 'repairPass', type: 'switch', labelKey: 'aiSettings.local.repairPass' },
    { group: 'text', key: 'chatTemplate', type: 'text', width: 'col-12', labelKey: 'aiSettings.local.chatTemplate', hintKey: 'aiSettings.local.chatTemplateAuto' },
]);
const LOCAL_OCR_FIELDS = Object.freeze([
    { group: 'ocr', key: 'executionProvider', type: 'select', options: ['webgpu', 'wasm'], labelKey: 'aiSettings.local.executionProvider' },
    { group: 'ocr', key: 'stripWidth', type: 'number', min: 320, max: 2048, labelKey: 'aiSettings.local.stripWidth' },
    { group: 'ocr', key: 'stripHeight', type: 'number', min: 64, max: 1024, labelKey: 'aiSettings.local.stripHeight' },
    { group: 'ocr', key: 'overlap', type: 'number', min: 0, max: 256, labelKey: 'aiSettings.local.overlap', hintKey: 'aiSettings.local.stripHint' },
    { group: 'ocr', key: 'imageLongSide', type: 'number', min: 512, max: 4096, labelKey: 'aiSettings.local.imageLongSide' },
    { group: 'ocr', key: 'maxNewTokens', type: 'number', min: 32, max: 2048, labelKey: 'aiSettings.local.maxNewTokens' },
    { group: 'ocr', key: 'graphOptimizationLevel', type: 'select', options: ['disabled', 'basic', 'extended', 'all'], labelKey: 'aiSettings.local.graphOptimization' },
]);
const LOCAL_RUNTIME_FIELDS = Object.freeze([
    { group: 'runtime', key: 'leaseSeconds', type: 'number', min: 60, max: 3600, labelKey: 'aiSettings.local.lease' },
    { group: 'runtime', key: 'heartbeatSeconds', type: 'number', min: 10, max: 1800, labelKey: 'aiSettings.local.heartbeat' },
    { group: 'runtime', key: 'maxAttempts', type: 'number', min: 1, max: 10, labelKey: 'aiSettings.local.attempts' },
    { group: 'runtime', key: 'parallel', type: 'number', min: 1, max: 4, labelKey: 'aiSettings.local.parallel', hintKey: 'aiSettings.local.parallelHint' },
]);

// A tab left open across a deploy still points at the previous build's
// hashed chunks, so the next dynamic import 404s ("error loading dynamically
// imported module"). Reload once to pull the fresh index.html; the
// sessionStorage guard keeps a genuinely broken deploy from looping.
window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    const lastReload = Number(sessionStorage.getItem('clinic-chunk-reload') || 0);
    if (Date.now() - lastReload > 10000) {
        sessionStorage.setItem('clinic-chunk-reload', String(Date.now()));
        window.location.reload();
    }
});

window.Alpine = Alpine;
window.t = t;

function translate(key, params = {}) {
    return t(key, params);
}

// Whole years between a date of birth (YYYY-MM-DD) and today.
// Returns null when there is no usable date, so callers can tell "unknown"
// apart from a real age of 0.
function calcAge(dateOfBirth) {
    if (!dateOfBirth) return null;
    const dob = new Date(`${String(dateOfBirth).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(dob.getTime())) return null;

    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const months = today.getMonth() - dob.getMonth();
    if (months < 0 || (months === 0 && today.getDate() < dob.getDate())) age -= 1;

    return age >= 0 ? age : null;
}

// Options (followers, sections, sources) live in the database, never in this
// file: a colour and an icon are derived from the key itself, so adding an
// option in Settings needs no code change (issue #38).
const OPTION_PALETTE = ['primary', 'success', 'info', 'warning', 'danger', 'secondary'];

function colorForOption(key) {
    const name = String(key || '');
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997;
    return OPTION_PALETTE[hash % OPTION_PALETTE.length];
}

function iconForOption(kind) {
    if (kind === 'follower') return 'bi-person-check-fill';
    return kind === 'source' ? 'bi-cash-coin' : 'bi-diagram-3-fill';
}

async function loadUserProfile() {
    const authUser = getCurrentUser();
    if (!authUser) return null;
    
    const { data, error } = await supabase()
        .from('users')
        .select('*')
        .eq('id', authUser.id)
        .single();
    
    if (error) throw error;
    return data;
}

function app() {
    return {
        loading: true,
        isLoggedIn: false,
        user: null,
        profile: null,
        isSuperAdmin: false,
        currentPage: 'login',
        // Bumped whenever the session ends. An async loader captures it before
        // its request and drops the response if it no longer matches, so a
        // request from the previous user can never repopulate the next shell.
        sessionEpoch: 0,
        localeLabel: 'العربية',
        // `?mock=review` preview route: renders the import review screen with
        // mock data, without a session. Never touches real data.
        mockPreview: false,
        
        loginForm: { identifier: '', password: '' },
        loginError: null,
        loginLoading: false,
        
        currentDate: '',
        
        // Dashboard
            stats: { total: 0, completed: 0, pending: 0, sections: {}, sources: {} },
        recentPatients: [],
        
        // Patients
        patients: [],
        patientsLoading: false,
        // The directory is server-side paginated: only one page is in memory.
        patientPage: 1,
        patientPageSize: 25,
        patientTotal: 0,
        patientsError: false,
        patientFilters: emptyPatientFilters(),
        // The sort of the patients table: the key is the column that was
        // pressed, the direction is 'asc' or 'desc'. The newest row first is
        // the start, like before the table could be sorted.
        patientSort: { key: 'created_at', dir: 'desc' },
        
        // Filters toolbar/panel (issue #13): `filterDraft` is the staged copy
        // shown while the panel is open; it is applied to `patientFilters`
        // (the single source of truth for the table and the export) only on
        // Apply, so closing the panel without Apply discards the changes.
        showFilters: false,
        filterDraft: emptyPatientFilters(),
        
        // Navbar search
        globalSearch: '',
        exporting: false,
        // Excel export: the button writes the table's dataset in Arabic with
        // every column; the caret opens the language, the rows and the
        // columns for a custom workbook.
        exportPanelOpen: false,
        exportOptions: { language: 'ar', rows: 'filtered', fields: [...EXPORT_FIELD_KEYS] },
        exportFields: EXPORT_FIELDS,
        // Rows ticked in the table ("export selected patients").
        selectedPatientIds: [],
        
        globalSearchFocused: false,
        globalSearchLoading: false,
        globalSearchResults: [],
        globalSearchSelectedIndex: -1,
        globalSearchDebounce: null,
        globalSearchRequestId: 0,
        
        // Financial summary (the retired Prices page lives here now, #15).
        // A load failure is reported inline with a retry button instead of
        // taking the whole dashboard down.
        priceStats: null,
        priceStatsError: null,

        // AI import entry: the ai_settings flag (fail open) and the job the
        // "Continue import" dropdown item can resume.
        importEnabled: true,
        importResumable: null,
        // Every import of this account that is still open (the "Continue
        // import" entries in the drop-down, one per job).
        importOpenJobs: [],
        // The drop-down shows three open imports; "see more" reveals the rest.
        importJobsExpanded: false,
        importJobsLimit: 3,
        
        // Users
        users: [],
        usersLoading: false,
        usersError: null,

        // Settings tabs (#16): Clinic options / Users / AI & Import. Users are
        // fetched when their tab is shown, not on every Settings entry.
        settingsTab: 'options',
        // The patients table text size (a personal preference).
        patientTableFont: 0.9,
        // The dashboard cards can be folded into one line (the state is
        // remembered in this browser).
        statsCardOpen: true,
        financialCardOpen: true,
        
        // Governorates & editable options
        governorates: GOVERNORATES,
        // The governorate of a patient, in the language of the interface.
        governorateLabel,
        // Loaded from the app_options table on login and after every Settings
        // edit; helpers below read only from here.
        options: { follower: [], section: [], source: [] },
        optionKinds: ['follower', 'section', 'source'],
        
        // Settings page (issue #1): row copies that can be edited freely,
        // plus per-kind drafts for the "add option" inputs.
        settingsOptions: { follower: [], section: [], source: [] },
        newOption: {
            follower: { label_en: '', label_ar: '' },
            section: { label_en: '', label_ar: '' },
            source: { label_en: '', label_ar: '' },
        },

        // AI Import settings (super admin). `aiSettings` is the last server
        // view; the form is the editable draft. Secrets are never returned,
        // so secret inputs always start blank. A blank input keeps the saved
        // key; the clear flag removes it on save.
        aiSettings: null,
        aiSettingsLoading: false,
        aiSettingsLoadError: null,
        aiSettingsSaving: false,
        aiSettingsProvider: 'openrouter',
        aiSettingsTesting: null,
        aiSettingsTestResults: { openrouter: null, cloudflare: null, openai: null, groq: null },
        aiSettingsMessage: null,
        aiSettingsInvalid: {},
        aiSettingsRowSeq: 0,
        aiSettingsMaxModels: 8,
        // The engine: Off, Cloud or Local. The segmented control sets the
        // enabled flag and the mode together, so this is the only place the
        // engine is written down.
        aiEngine: 'off',
        // The engine before the current change, so a switch that needs the
        // consent can be held.
        aiEngineBefore: 'off',
        // The card holds changes that are not saved yet.
        aiSettingsDirty: false,
        // Whether this deployment allows the local engine at all.
        aiLocalEnabled: false,
        // The cloud consent record: the clinic accepted that the data leaves
        // the clinic. The record holds no patient data.
        aiCloudConsent: false,
        aiConsentChecked: false,
        // The local engine draft: the models the clinic picked and the
        // runtime settings. The files stay in the browser.
        aiLocal: createLocalState(),
        aiLocalDevice: null,
        aiLocalVerifying: null,
        // Browsing is separate from verifying: picking a 700 MB file and
        // loading it are two deliberate actions, and each has its own spinner.
        aiLocalBrowsing: null,
        aiLocalMessage: null,
        aiLocalConfigErrors: {},
        // The field descriptors the card renders. Exposed to Alpine so the
        // template and the label lookup use the same list.
        aiLocalTextFields: LOCAL_TEXT_FIELDS.map((field) => ({ ...field, idPrefix: 'ai-local-text' })),
        aiLocalSingleTextFields: LOCAL_TEXT_FIELDS.map((field) => ({ ...field, idPrefix: 'ai-local-single' })),
        aiLocalOcrFields: LOCAL_OCR_FIELDS,
        aiLocalRuntimeFields: LOCAL_RUNTIME_FIELDS,
        // The import limits (imports per day, rows per file, ...). They live
        // in `import_settings`, which only the ai-settings function may write,
        // so an admin raises the daily quota here instead of in the SQL
        // editor.
        aiLimits: {},
        aiLimitsDefaults: {},
        aiLimitsSaving: false,
        aiLimitsMessage: null,
        aiLimitFields: [
            { key: 'JOBS_PER_USER_DAY', labelKey: 'aiSettings.limits.jobsPerDay', hintKey: 'aiSettings.limits.jobsPerDayHint', default: 20 },
            { key: 'MAX_ROWS', labelKey: 'aiSettings.limits.maxRows', hintKey: 'aiSettings.limits.maxRowsHint', default: 500 },
            { key: 'MAX_FILES', labelKey: 'aiSettings.limits.maxFiles', hintKey: 'aiSettings.limits.maxFilesHint', default: 10 },
            { key: 'PROVIDER_TOKENS_PER_MINUTE', labelKey: 'aiSettings.limits.tokensPerMinute', hintKey: 'aiSettings.limits.tokensPerMinuteHint', default: 6000 },
        ],
        aiProviderOptions: [
            { id: 'openrouter', labelKey: 'aiSettings.provider.openrouter' },
            { id: 'cloudflare', labelKey: 'aiSettings.provider.cloudflare' },
            { id: 'openai', labelKey: 'aiSettings.provider.openai' },
            { id: 'groq', labelKey: 'aiSettings.provider.groq' },
        ],
        aiSettingsForm: {
            enabled: false,
            chain: [],
            credentials: {
                openrouter: { apiKey: '', clearKey: false },
                cloudflare: { accountId: '', apiToken: '', clearToken: false },
                openai: { baseUrl: '', apiKey: '', clearKey: false },
                groq: { apiKey: '', clearKey: false },
            },
        },
        
        // Patient form
        editingPatient: null,
        patientForm: null,
        selectedPatient: null,
        patientNotes: [''],
        // Cloudinary attachment entries: saved DB shape plus transient
        // uploading/progress/error state while a file is in flight.
        patientAttachments: [],
        // Token for the next attachment entry: an in-flight upload finds
        // its row by it even after the array shifts under it (issue #26).
        attachmentSeq: 0,
        
        // User form
        editingUser: null,
        userForm: null,
        // Inline validation/error message shown inside the user modal.
        userFormError: null,
        
        // Toasts (issue #37): showAlert stacks them in the corner and each
        // one removes itself after a few seconds. `toastTimers` holds their
        // timers so a sign-out can stop them.
        toasts: [],
        toastSeq: 0,
        toastTimers: {},
        
        async init() {
            try {
                // Every page's inputs are x-model-bound, so the form objects must
                // hold a value before Alpine walks the tree. Left as `null`, each
                // input logs a TypeError on load (23 of them) before any form is
                // opened, and the bindings only recover once the form is opened.
                this.patientForm = this.newPatientForm();
                this.userForm = this.emptyUserForm();

                await initI18n();
                await initSupabase();
                initCloudinary();

                const authUser = getCurrentUser();
                if (authUser) {
                    try {
                        this.profile = await loadUserProfile();
                    } catch {}
                    this.updateAuthState();
                }
                
                window.authStateChanged = async (user) => {
                    if (user) {
                        try {
                            this.profile = await loadUserProfile();
                        } catch {}
                    } else {
                        this.profile = null;
                    }
                    this.updateAuthState();
                };
                
                // The import wizard tells the shell when an import was committed:
                // the job is no longer open.
                window.addEventListener('import-committed', () => this.refreshImportResume());
                window.localeChanged = () => {
                    this.localeLabel = t('locale_label');
                    this.currentDate = this.formatToday();
                    document.title = t('Medical File');
                };

                this.localeLabel = t('locale_label');
                this.currentDate = this.formatToday();
                // The tab title follows the language too (the static <title>
                // is the Arabic name for the first paint and for no-JS).
                document.title = t('Medical File');
                this.patientTableFont = this.loadPatientTableFont();
                this.applyBootstrapDirection();
                const cards = this.loadCardState();
                this.statsCardOpen = cards.stats;
                this.financialCardOpen = cards.financial;

                // Visual preview of the import review screen: `?mock=review`.
                // UI-development tool only; a production build must never
                // fabricate a super-admin shell from a query param.
                if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === 'review') {
                    this.enterMockPreview();
                }

                if (this.isLoggedIn && !this.mockPreview) {
                    // A persisted session must land on the dashboard rather than
                    // back on the login screen, and a failed fetch must not leave
                    // the whole app stuck behind the page loader.
                    this.currentPage = 'dashboard';
                    try {
                        await this.showDashboard();
                    } catch (error) {
                        console.error('Dashboard load failed:', error);
                    }
                }
            } catch (error) {
                console.error('Init error:', error);
            } finally {
                this.loading = false;
            }
        },
        
        updateAuthState() {
            // The mock preview route owns its own shell state: a late auth
            // event must not bounce the preview back to the login screen.
            if (this.mockPreview) return;
            this.user = getCurrentUser();
            this.isLoggedIn = !!this.user;
            // One privileged role: a Super Admin. Everyone else is scoped by
            // the section grants on their profile.
            this.isSuperAdmin = !!this.profile?.is_super_admin;

            if (this.isLoggedIn) {
                // Fire-and-forget: failures must never block or break auth.
                this.refreshOptions();
                this.refreshImportState();
            } else {
                // A signed-out shell has one page and no data. This is also
                // the SIGNED_OUT path (expired refresh token, sign-out in
                // another tab), so it must not depend on logout() running.
                this.profile = null;
                this.isSuperAdmin = false;
                this.resetSessionState();
            }
        },

        /**
         * Drop every piece of data a previous session fetched. The clinic PCs
         * are shared, so signing out must leave nothing for the next user's
         * dashboard, search suggestions or admin screens to render.
         */
        resetSessionState() {
            // Invalidate in-flight loaders before clearing their results.
            this.sessionEpoch += 1;

            // Stop the timers first: they can write to the state below.
            clearTimeout(this.globalSearchDebounce);
            this.globalSearchDebounce = null;
            Object.values(this.toastTimers).forEach((timer) => clearTimeout(timer));
            this.toastTimers = {};

            this.currentPage = 'login';

            // Dashboard
            this.stats = { total: 0, completed: 0, pending: 0, sections: {}, sources: {} };
            this.recentPatients = [];
            this.priceStats = null;
            this.priceStatsError = null;

            // Patients table, filters and navbar search
            this.patients = [];
            this.patientsLoading = false;
            this.patientPage = 1;
            this.patientTotal = 0;
            this.patientFilters = emptyPatientFilters();
            this.filterDraft = emptyPatientFilters();
            this.patientSort = { key: 'created_at', dir: 'desc' };
            this.showFilters = false;
            this.selectedPatientIds = [];
            this.exportPanelOpen = false;
            this.exportOptions = { language: 'ar', rows: 'filtered', fields: [...EXPORT_FIELD_KEYS] };
            this.globalSearch = '';
            this.closeGlobalSearch({ keepQuery: false, clearFocus: true });
            this.globalSearchLoading = false;

            // Admin user list
            this.users = [];
            this.usersLoading = false;
            this.usersError = null;

            // Clinic options (labels, not patient data, but still last
            // session's server state)
            this.options = { follower: [], section: [], source: [] };
            this.settingsOptions = { follower: [], section: [], source: [] };

            // Open patient / form state
            this.selectedPatient = null;
            this.editingPatient = null;
            this.patientNotes = [''];
            this.patientAttachments = [];
            this.patientForm = this.newPatientForm();
            this.editingUser = null;
            this.userForm = this.emptyUserForm();

            // Import resume entries
            this.importEnabled = true;
            this.importResumable = null;
            this.importOpenJobs = [];
            this.importJobsExpanded = false;

            // Transient UI state
            this.exporting = false;
            this.toasts = [];
            this.loginForm = { identifier: '', password: '' };
            this.loginError = null;
            this.loginLoading = false;
        },

        /**
         * `?mock=review`: render the import review screen with mock data so
         * the UI can be compared against the mockup without a session or a
         * real extraction. It never reads or writes real data.
         */
        enterMockPreview() {
            // Development-only: the production build must not expose the
            // fake admin shell even if this method is called directly.
            if (!import.meta.env.DEV) return;
            this.mockPreview = true;
            this.isLoggedIn = true;
            this.isSuperAdmin = true;
            this.user = { id: 'mock-user', email: 'mock@example.test' };
            this.currentPage = 'import';
            this.loading = false;
        },

        /** Hide the import entry when ai_settings.enabled says so; fail open. */
        async refreshImportState() {
            if (!this.isLoggedIn) {
                this.importEnabled = true;
                this.importResumable = null;
                return;
            }
            const epoch = this.sessionEpoch;
            const enabled = await loadImportEnabled();
            if (epoch !== this.sessionEpoch || !this.isLoggedIn) return;
            this.importEnabled = enabled !== false;
            if (!this.importEnabled) this.importResumable = null;
        },

        /** The "Continue import" entries appear only for unfinished jobs. */
        async refreshImportResume() {
            if (!this.isLoggedIn || !this.importEnabled) {
                this.importResumable = null;
                this.importOpenJobs = [];
                return;
            }
            const epoch = this.sessionEpoch;
            try {
                const { listOpenJobs } = await import('./features/import-agent/api.js');
                const jobs = await listOpenJobs();
                if (epoch !== this.sessionEpoch) return;
                this.importOpenJobs = jobs;
                this.importResumable = this.importOpenJobs[0] ?? null;
            } catch {
                if (epoch !== this.sessionEpoch) return;
                this.importResumable = null;
                this.importOpenJobs = [];
            }
        },

        /** The open imports the drop-down shows (three, or all). */
        get importVisibleJobs() {
            const jobs = this.importOpenJobs ?? [];
            return this.importJobsExpanded ? jobs : jobs.slice(0, this.importJobsLimit);
        },

        /**
         * "Import from file or paste" always starts a NEW import: the wizard
         * is reset, so the user never lands in the previous job.
         */
        async openNewImport() {
            await this.navigate('import');
            const wizard = window.__iaWizard;
            if (wizard?.startNewImport) await wizard.startNewImport();
        },

        /** Cancel every open import of this account. */
        async clearAllImports() {
            const jobs = [...(this.importOpenJobs ?? [])];
            try {
                const { callJob } = await import('./features/import-agent/api.js');
                for (const job of jobs) {
                    try {
                        await callJob('cancel', { job_id: job.id });
                    } catch (error) {
                        console.error('Cancel import failed:', job?.id, error);
                    }
                }
            } finally {
                this.importJobsExpanded = false;
                await this.refreshImportResume();
            }
        },

        /** Continue one specific import. */
        async continueImport(job = null) {
            const target = job ?? this.importResumable;
            if (!target) return;
            await this.navigate('import');
            const wizard = window.__iaWizard;
            if (wizard) {
                wizard.resumable = target;
                await wizard.resume();
            }
        },

        /** Cancel one import and drop it from the list. */
        async cancelImport(job) {
            if (!job?.id) return;
            try {
                const { callJob } = await import('./features/import-agent/api.js');
                await callJob('cancel', { job_id: job.id });
            } catch (error) {
                console.error('Cancel import failed:', error);
            }
            await this.refreshImportResume();
        },

        /** A short label for an open import: when it started and its state. */
        importJobLabel(job) {
            if (!job) return '';
            const when = job.created_at ? new Date(job.created_at) : null;
            const time = when
                ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '';
            return time ? `· ${time}` : '';
        },
        
        // Role = what the account is allowed to do, straight from the users
        // table: a Super Admin works in every section and manages users;
        // everyone else is described by the sections they may read.
        roleLabel() {
            if (this.isSuperAdmin) return this.t('Super Admin');
            const sections = this.readableSectionKeys();
            if (!sections.length) return this.t('No section access');
            return this.t('Staff') + ' · ' + sections.map((key) => this.optionLabel('section', key)).join(', ');
        },

        // ---- Section permissions -------------------------------------------
        //
        // The database is authoritative (can_read_section/can_write_section);
        // these helpers only decide which controls the UI offers, so they must
        // mirror the same rule: Super Admin everything, otherwise the granted
        // arrays, with write implying read.

        /** Sections this account may see, in the configured order. */
        readableSectionKeys() {
            const options = this.activeOptions('section').map((option) => option.key);
            if (this.isSuperAdmin) return options;
            return options.filter((key) => this.canReadSection(key));
        },

        /** Sections this account may add, edit or delete. */
        writableSectionKeys() {
            const options = this.activeOptions('section').map((option) => option.key);
            if (this.isSuperAdmin) return options;
            return options.filter((key) => this.canWriteSection(key));
        },

        /** Active section options this account may write to. */
        writableSectionOptions() {
            return this.activeOptions('section').filter((option) => this.canWriteSection(option.key));
        },

        /** Reads the granted keys from the profile, tolerating a missing array. */
        profileSectionGrants(...fields) {
            const granted = new Set();
            fields.forEach((field) => {
                const value = this.profile?.[field];
                if (Array.isArray(value)) value.forEach((key) => granted.add(key));
            });
            return [...granted];
        },

        /**
         * A row created before per-section grants existed carries only the
         * primary `section` column. RLS still honours it while both arrays are
         * empty, so the UI must too.
         */
        hasLegacySectionGrant() {
            return !!this.profile?.section
                && !this.profileSectionGrants('read_sections').length
                && !this.profileSectionGrants('write_sections').length;
        },

        canReadSection(section) {
            if (this.isSuperAdmin) return true;
            if (!section) return false;
            if (this.profileSectionGrants('read_sections', 'write_sections').includes(section)) return true;
            return this.hasLegacySectionGrant() && this.profile.section === section;
        },

        canWriteSection(section) {
            if (this.isSuperAdmin) return true;
            if (!section) return false;
            if (this.profileSectionGrants('write_sections').includes(section)) return true;
            return this.hasLegacySectionGrant() && this.profile.section === section;
        },

        /** The section a new patient lands in before the user picks one. */
        defaultSection() {
            return this.writableSectionKeys()[0] || '';
        },
        
        t(key, params = {}) {
            return translate(key, params);
        },
        
        // Supabase answers the same way for a wrong password and an unknown
        // email, and that vagueness is worth keeping — but the user still needs
        // to be told the credentials were rejected, in their own language.
        loginErrorMessage(error) {
            const message = String(error?.message || '');
            const rejected = error?.status === 400 || error?.status === 401
                || /invalid login credentials|invalid credentials|invalid username or password/i.test(message);

            return rejected ? this.t('Invalid username or password') : this.t('Login failed. Please try again.');
        },
        
        async handleLogin() {
            this.loginLoading = true;
            this.loginError = null;
            
            try {
                await signInWithIdentifier(this.loginForm.identifier, this.loginForm.password);
            } catch (error) {
                // Credentials were rejected. Say so on the form instead of
                // leaving the page looking frozen with no feedback at all.
                this.loginError = this.loginErrorMessage(error);
                this.loginLoading = false;
                return;
            }
            
            // The credentials were accepted, so the user is in from here on.
            // Nothing below may strand them on the login screen: a missing
            // profile row or a failed dashboard fetch is reported, not fatal.
            this.updateAuthState();
            this.loginForm = { identifier: '', password: '' };
            this.currentPage = 'dashboard';
            this.loginLoading = false;
            
            try {
                this.profile = await loadUserProfile();
                this.updateAuthState();
                await this.showDashboard();
            } catch (error) {
                console.error('Post-login setup failed:', error);
                this.showAlert(this.t('You are signed in, but your profile could not be loaded.'), 'warning');
            }
        },
        
        async logout() {
            // Clear the shell first: the network call may be slow or fail, but
            // the previous user's data must leave the screen immediately.
            this.user = null;
            this.profile = null;
            this.isLoggedIn = false;
            this.isSuperAdmin = false;
            this.resetSessionState();
            try {
                await signOut();
            } catch (error) {
                console.error('Sign out failed:', error);
            }
        },
        
        // Mobile menu: close the collapsed panel after a navigation click so
        // the page underneath is not left covered by an open menu.
        closeMobileNav() {
            const nav = document.getElementById('navbarNav');
            if (!nav || !nav.classList.contains('show')) return;
            bootstrapBundle?.Collapse?.getOrCreateInstance(nav).hide();
        },

        async navigate(page) {
            // Signed out, the shell has exactly one page. A click from a stale
            // view (or the login logo) must not hide that page behind a gated
            // container and leave the screen blank.
            if (!this.isLoggedIn) {
                this.currentPage = 'login';
                return;
            }
            // Settings is Super-Admin-only: its Users tab is the only way to
            // manage accounts, so no other role may reach the page.
            if (page === 'settings' && !this.isSuperAdmin) return;
            // The import entry is hidden when the ai_settings flag is off.
            if (page === 'import' && !this.importEnabled) return;
            // Retired pages (#15, #16): the financial summary lives on the
            // dashboard, and user management inside Settings.
            if (page === 'prices' || page === 'users' || page === 'user-form') return;
            if (page !== 'patients') this.closeGlobalSearch();
            this.currentPage = page;
            this.closeMobileNav();
            try {
                if (page === 'dashboard') await this.showDashboard();
                if (page === 'patients') {
                    await this.loadPatients();
                    this.refreshImportResume();
                }
                if (page === 'settings') await this.showSettings();
                if (page === 'import') await importAgentEnter();
            } catch (error) {
                console.error(error);
            }
        },
        
        toggleLocale() {
            const newLocale = getLocale() === 'en' ? 'ar' : 'en';
            setLocale(newLocale);
            this.localeLabel = t('locale_label');
            this.currentDate = this.formatToday();
            this.applyBootstrapDirection();
        },

        /**
         * Load the build of Bootstrap that fits the language: the RTL one for
         * the Arabic interface, the LTR one for the others, so the physical
         * utilities mirror with the text order.
         *
         * The link sits at the end of the head, where the stylesheet of
         * Bootstrap used to be bundled, so the order of the rules stays the
         * same as before.
         */
        applyBootstrapDirection() {
            const rtl = getLocale() === 'ar';
            const url = rtl ? bootstrapRtlUrl : bootstrapLtrUrl;
            let link = document.getElementById('bs-core');
            if (!link) {
                link = document.createElement('link');
                link.id = 'bs-core';
                link.rel = 'stylesheet';
                document.head.appendChild(link);
            }
            const wanted = new URL(url, window.location.href).href;
            if (link.href !== wanted) link.href = wanted;
        },

        // Whether the dashboard cards are folded is remembered per browser.
        loadCardState() {
            try {
                const raw = localStorage.getItem('dashboardCards');
                if (raw) {
                    const parsed = JSON.parse(raw);
                    return {
                        stats: parsed?.stats !== false,
                        financial: parsed?.financial !== false,
                    };
                }
            } catch {
                // No storage (private mode): the default is fine.
            }
            return { stats: true, financial: true };
        },

        saveCardState() {
            try {
                localStorage.setItem('dashboardCards', JSON.stringify({
                    stats: this.statsCardOpen,
                    financial: this.financialCardOpen,
                }));
            } catch {
                // No storage: the state lasts for this page only.
            }
        },

        toggleStatsCard() {
            this.statsCardOpen = !this.statsCardOpen;
            this.saveCardState();
        },

        toggleFinancialCard() {
            this.financialCardOpen = !this.financialCardOpen;
            this.saveCardState();
        },

        // The table text size is remembered per browser. The size runs from
        // 90% to 150%: smaller than that the ten columns do not fit.
        loadPatientTableFont() {
            try {
                const stored = Number(localStorage.getItem('patientsTableFont'));
                if (Number.isFinite(stored) && stored >= 0.9 && stored <= 1.5) return stored;
            } catch {
                // No storage (private mode): the default is fine.
            }
            return 0.9;
        },

        savePatientTableFont() {
            try {
                localStorage.setItem('patientsTableFont', String(this.patientTableFont));
            } catch {
                // No storage: the setting lasts for this page only.
            }
        },

        /**
         * Today, in the app's language: the full day and month name, and the
         * Hijri date next to it.
         */
        formatToday(date = new Date()) {
            const arabic = getLocale() === 'ar';
            const gregorian = new Intl.DateTimeFormat(arabic ? 'ar-EG' : 'en-GB', {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            }).format(date);
            let hijri = '';
            try {
                hijri = new Intl.DateTimeFormat(
                    arabic ? 'ar-SA-u-ca-islamic-umalqura' : 'en-GB-u-ca-islamic',
                    { day: 'numeric', month: 'long', year: 'numeric' },
                ).format(date);
            } catch {
                hijri = '';
            }
            return hijri ? `${gregorian} · ${hijri}` : gregorian;
        },

        /** The date as numbers only (e.g. 22/10/2026), same in every language. */
        formatDateOnly(date) {
            const d = new Date(date);
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}/${month}/${year}`;
        },
        
        async showDashboard() {
            if (!this.isLoggedIn) return;
            const epoch = this.sessionEpoch;
            // One navigation pass: stats, recent patients and the financial
            // summary load in parallel (#15), so the dashboard never makes a
            // duplicate prices request. Stats/table failures keep the old
            // behavior (bubble up to the caller); a financial-summary failure
            // is contained inside its own card (warning + retry). RLS limits
            // every query to the sections this account may read.
            const [_summary, stats, recent] = await Promise.allSettled([
                this.loadPriceStats(),
                getDashboardStats(),
                getRecentPatients(),
            ]);
            // The session ended while the dashboard was loading: these rows
            // belong to the previous user and must not reach the new shell.
            if (epoch !== this.sessionEpoch) return;
            if (stats.status === 'fulfilled') this.stats = stats.value;
            if (recent.status === 'fulfilled') this.recentPatients = recent.value;
            if (stats.status === 'rejected') throw stats.reason;
            if (recent.status === 'rejected') throw recent.reason;
        },

        // The financial summary never throws: a failure is shown inside the
        // card with a retry action while the rest of the dashboard stays up.
        // It also carries the counts per source of money, so every account
        // sees them (a section account only sees its own section).
        async loadPriceStats() {
            if (!this.isLoggedIn) return;
            const epoch = this.sessionEpoch;
            try {
                const priceStats = await getPriceStats();
                if (epoch !== this.sessionEpoch) return;
                this.priceStats = priceStats;
                this.priceStatsError = null;
            } catch (error) {
                if (epoch !== this.sessionEpoch) return;
                console.error('Financial summary load failed:', error);
                this.priceStatsError = true;
            }
        },

        // Compact rows for the dashboard financial card, keeping the same
        // values, labels and formatting the Prices page showed.
        financialEntries(kind, totals) {
            return Object.entries(totals || {}).map(([key, data]) => ({
                key,
                label: lookupOptionLabel(kind, key),
                count: data?.count ?? 0,
                total: data?.total ?? 0,
            }));
        },
        sectionFinancialEntries() {
            return this.financialEntries('section', this.priceStats?.sectionTotals);
        },
        sourceFinancialEntries() {
            return this.financialEntries('source', this.priceStats?.sourceTotals);
        },
        hasFinancialData() {
            return (this.priceStats?.totalPatients ?? 0) > 0;
        },
        
        // ---- Editable options (issue #1) ------------------------------------
        
        async refreshOptions() {
            if (!this.isLoggedIn) return;
            const epoch = this.sessionEpoch;
            try {
                await fetchOptions();
                if (epoch !== this.sessionEpoch) return;
                this.options = {
                    follower: allOptions('follower'),
                    section: allOptions('section'),
                    source: allOptions('source'),
                };
            } catch (error) {
                // Options failing to load must not break the page: selects
                // simply render with whatever was cached.
                console.error('Could not load options:', error);
            }
        },
        
        activeOptions(kind) {
            return (this.options[kind] || []).filter((opt) => opt.active);
        },
        
        optionLabel(kind, key) {
            return lookupOptionLabel(kind, key);
        },
        
        sectionColor(key) { return colorForOption(key); },
        sectionIcon(key) { return iconForOption('section', key); },
        sourceColor(key) { return colorForOption(key); },
        sourceIcon(key) { return iconForOption('source', key); },
        
        // Dashboard/prices aggregation lists: every active option in its
        // configured order (zero counts included), then any legacy key that
        // still has rows but is no longer offered.
        optionStatEntries(kind, counts) {
            const entries = this.activeOptions(kind).map((opt) => ({
                key: opt.key,
                label: lookupOptionLabel(kind, opt.key),
                count: counts?.[opt.key] || 0,
            }));
            Object.entries(counts || {}).forEach(([key, count]) => {
                if (!entries.some((entry) => entry.key === key)) {
                    entries.push({ key, label: lookupOptionLabel(kind, key), count });
                }
            });
            return entries;
        },
        sectionStatEntries() {
            // RLS already removed any section this account cannot read, so the
            // counts only ever describe permitted sections.
            return this.optionStatEntries('section', this.stats?.sections);
        },
        sourceStatEntries() { return this.optionStatEntries('source', this.stats?.sources); },
        
        // ---- Settings page ---------------------------------------------------
        
        async showSettings() {
            try {
                await this.refreshOptions();
                this.resetSettingsOptions();
            } finally {
                // Options and AI settings are independent: a failed option
                // load must not leave the AI card silently empty.
                await this.loadAiSettings();
                // The import limits live in their own table; a failure there
                // must not hide the provider settings.
                await this.loadImportLimits();
            }
            // Coming back to Settings with the Users tab already selected
            // refreshes its list; opening the tab refetches as well.
            if (this.settingsTab === 'users') await this.loadUsers();
        },
        
        // Tabs at the top of Settings (#16): Clinic options, Users, AI & Import.
        async openSettingsTab(tab) {
            this.settingsTab = tab;
            // The user list is fetched when its tab is shown.
            if (tab === 'users') await this.loadUsers();
        },
        
        // Keyboard support for the tablist (ARIA tabs). RTL flips the visual
        // direction per the ARIA authoring practices.
        settingsTabKeydown(event) {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = ['options', 'users', 'ai'];
            const index = tabs.indexOf(this.settingsTab);
            const forwardKey = document.documentElement.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
            let next = index;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                next = (index + (event.key === forwardKey ? 1 : -1) + tabs.length) % tabs.length;
            } else if (event.key === 'Home') {
                next = 0;
            } else if (event.key === 'End') {
                next = tabs.length - 1;
            }
            if (next === index) return;
            this.openSettingsTab(tabs[next]);
            document.getElementById(`settings-tab-${tabs[next]}`)?.focus();
        },
        
        // Editable working copies so typing never writes through until Save.
        resetSettingsOptions() {
            const clone = (list) => list.map((opt) => ({ ...opt, _dirty: false, _saving: false, _removing: false }));
            this.settingsOptions = {
                follower: clone(allOptions('follower')),
                section: clone(allOptions('section')),
                source: clone(allOptions('source')),
            };
        },

        // ---- AI Import settings ---------------------------------------------

        async loadAiSettings() {
            if (!this.isSuperAdmin) return;
            this.aiSettingsLoading = true;
            this.aiSettingsLoadError = null;
            try {
                const data = await loadAiSettingsApi();
                // The device tier decides the defaults the server config is
                // resolved against, so probe before the card is built. The
                // browser-side handles are restored first too, so a slot the
                // clinic picked earlier keeps its handle when the server names
                // the same file.
                await this.loadAiLocalDevice();
                await restoreLocalState(this.aiLocal);
                this.applyAiSettings(data);
            } catch (error) {
                console.error('AI settings load failed:', error);
                const view = this.aiErrorView(error, 'aiSettings.loadFailed');
                this.aiSettingsLoadError = view;
                this.aiSettings = null;
            } finally {
                this.aiSettingsLoading = false;
            }
        },

        /** What the device can do, and the tier it suggests. */
        async loadAiLocalDevice() {
            try {
                this.aiLocalDevice = await readDevice();
            } catch (error) {
                console.error('Local device probe failed:', error);
                this.aiLocalDevice = null;
            }
        },

        /** The import limits and their defaults (super admin). */
        async loadImportLimits() {
            if (!this.isSuperAdmin) return;
            this.aiLimitsMessage = null;
            try {
                const data = await loadImportLimitsApi();
                this.aiLimits = { ...(data.limits ?? {}) };
                this.aiLimitsDefaults = { ...(data.defaults ?? {}) };
            } catch (error) {
                console.error('Import limits load failed:', error);
                this.aiLimitsMessage = this.aiErrorView(error, 'aiSettings.limits.loadFailed').key;
            }
        },

        /** The value of one limit: the override, or the default. */
        aiLimitValue(key) {
            const value = this.aiLimits?.[key];
            if (value !== undefined && value !== null && value !== '') return value;
            return this.aiLimitsDefaults?.[key] ?? '';
        },

        aiLimitSet(key, value) {
            this.aiLimits = { ...(this.aiLimits ?? {}) };
            const number = Number(value);
            if (!Number.isFinite(number) || number <= 0) {
                delete this.aiLimits[key];
            } else {
                this.aiLimits[key] = number;
            }
            this.aiLimitsMessage = null;
        },

        /** Write the limits back (the only writer of `import_settings`). */
        async saveImportLimits() {
            if (!this.isSuperAdmin || this.aiLimitsSaving) return;
            this.aiLimitsSaving = true;
            this.aiLimitsMessage = null;
            try {
                const data = await saveImportLimitsApi(this.aiLimits ?? {});
                this.aiLimits = { ...(data.limits ?? {}) };
                this.aiLimitsDefaults = { ...(data.defaults ?? {}) };
                this.aiLimitsMessage = t('aiSettings.limits.saved');
            } catch (error) {
                console.error('Import limits save failed:', error);
                const view = this.aiErrorView(error, 'aiSettings.limits.saveFailed');
                this.aiLimitsMessage = t(view.key, view.params);
            } finally {
                this.aiLimitsSaving = false;
            }
        },

        applyAiSettings(data) {
            const firstLoad = this.aiSettings === null;
            this.aiSettings = data;
            this.aiSettingsForm.enabled = data.enabled === true;
            // The engine: a row that is not enabled is Off, whatever the mode
            // says. A cloud selection without the consent record falls back
            // to Off, because the browser may restore the form state.
            const engine = data.engine ?? (data.enabled === true ? (data.inference_mode ?? 'cloud') : 'off');
            this.aiLocalEnabled = data.local_enabled === true;
            this.aiCloudConsent = data.cloud_consent === true;
            let next = engine;
            if (next === 'cloud' && !this.aiCloudConsent && data.enabled !== true) next = 'off';
            if (next === 'local' && !this.aiLocalEnabled) next = 'off';
            this.aiEngine = next;
            this.aiEngineBefore = next;
            this.aiSettingsForm.enabled = next !== 'off';
            this.aiLocal = this.aiLocalFromServer(data);
            const chain = Array.isArray(data.chain) ? data.chain : [];
            this.aiSettingsForm.chain = chain.map((row) => this.aiChainRow(row.provider, row.model));
            if (this.aiSettingsForm.chain.length === 0) {
                this.aiSettingsForm.chain = [this.aiChainRow(), this.aiChainRow()];
            }
            const cloudflare = data.providers?.cloudflare ?? {};
            const openai = data.providers?.openai ?? {};
            this.aiSettingsForm.credentials = {
                openrouter: { apiKey: '', clearKey: false },
                cloudflare: {
                    accountId: cloudflare.accountId ?? '',
                    apiToken: '',
                    clearToken: false,
                },
                openai: {
                    baseUrl: openai.baseUrl ?? '',
                    apiKey: '',
                    clearKey: false,
                },
                groq: {
                    apiKey: '',
                    clearKey: false,
                },
            };
            if (firstLoad) {
                const primary = this.aiSettingsForm.chain.find((row) => row.provider);
                if (primary?.provider) this.aiSettingsProvider = primary.provider;
            }
            this.aiSettingsTestResults = { openrouter: null, cloudflare: null, openai: null, groq: null };
            this.aiSettingsInvalid = {};
            this.aiSettingsMessage = null;
            this.aiSettingsDirty = false;
        },

        /** The local draft, as the server knows it. */
        aiLocalFromServer(data) {
            const state = createLocalState();
            const profile = data.local_profile ?? {};
            const config = data.local_config ?? {};
            state.mode = profile.mode === 'split' ? 'split' : 'single';
            // The server response has the names but never the handles. Keep
            // the handle, file and badge of a slot that still names the same
            // file, so a save made after a reload does not wipe the browser
            // side of the profile.
            const keepSlot = (slot, name) => {
                const current = this.aiLocal?.[slot];
                if (!current || !name || current.name !== name) {
                    return { status: name ? 'warn' : 'none' };
                }
                return {
                    handle: current.handle ?? null,
                    file: current.file ?? null,
                    status: current.status,
                    message: current.message ?? '',
                    params: current.params ?? {},
                    code: current.code ?? null,
                };
            };
            state.multimodal = {
                ...emptySlot(),
                ...keepSlot('multimodal', profile.name),
                name: profile.name ?? '',
                size: profile.size ?? 0,
                sha256: profile.sha256 ?? '',
                kind: 'gguf',
            };
            state.text = {
                ...emptySlot(),
                ...keepSlot('text', profile.textName),
                name: profile.textName ?? '',
                size: profile.textSize ?? 0,
                sha256: profile.textSha256 ?? '',
                kind: 'gguf',
            };
            state.vision = {
                ...emptySlot(),
                ...keepSlot('vision', profile.visionName),
                name: profile.visionName ?? '',
                size: profile.visionSize ?? 0,
                sha256: profile.visionSha256 ?? '',
                kind: 'onnx',
            };
            // The support files are local too. Keep them (and the folder
            // handle) when the server still names the same folder.
            const currentSupport = this.aiLocal?.support;
            const sameSupport = Boolean(
                profile.supportName && currentSupport?.name === profile.supportName,
            );
            state.support = {
                ...state.support,
                name: profile.supportName ?? '',
                status: profile.supportName ? (sameSupport ? currentSupport.status : 'warn') : 'none',
                message: sameSupport ? currentSupport.message ?? '' : '',
                missing: sameSupport ? currentSupport.missing ?? state.support.missing : state.support.missing,
                handle: sameSupport ? currentSupport.handle ?? null : null,
                files: sameSupport ? currentSupport.files ?? {} : {},
            };
            state.device = this.aiLocalDevice;
            if (config && typeof config === 'object') {
                // The service resolves the draft's own `config`; the server
                // payload has to be placed there first, or a saved config
                // would silently fall back to the defaults.
                state.config = config;
                const resolved = resolveConfig(state);
                state.config = resolved.config;
            }
            return state;
        },

        /**
         * The engine changed.
         *
         * Cloud mode may only be switched on after the clinic accepted that
         * the data leaves the clinic, so the first switch asks. The local
         * engine is refused when the deployment does not allow it.
         */
        aiOnEngineChange(engine) {
            this.aiSettingsMessage = null;
            this.aiSettingsDirty = true;
            if (engine === 'local' && !this.aiLocalEnabled) {
                this.aiEngine = 'off';
                this.aiEngineBefore = 'off';
                this.aiSettingsForm.enabled = false;
                this.aiNotify('warning', 'aiSettings.local.disabledHint');
                return;
            }
            if (engine === 'cloud' && !this.aiCloudConsent) {
                // Hold the current engine until the clinic accepted that the
                // data leaves the clinic.
                this.aiEngine = this.aiEngineBefore || 'off';
                this.aiConsentChecked = false;
                bootstrapBundle?.Modal?.getOrCreateInstance(document.getElementById('aiCloudConsentModal'))?.show();
                return;
            }
            this.aiEngine = engine;
            this.aiEngineBefore = engine;
            this.aiSettingsForm.enabled = engine !== 'off';
        },

        /** The clinic accepted the data egress: cloud mode may be switched on. */
        aiAcceptCloudConsent() {
            this.aiCloudConsent = true;
            this.aiConsentChecked = false;
            this.aiEngine = 'cloud';
            this.aiSettingsForm.enabled = true;
            bootstrapBundle?.Modal?.getOrCreateInstance(document.getElementById('aiCloudConsentModal'))?.hide();
        },

        /** Withdraw the consent: the next switch to cloud asks again. */
        async aiResetCloudConsent() {
            try {
                const data = await resetCloudConsentApi();
                this.applyAiSettings(data);
                this.aiNotify('info', 'aiSettings.consent.resetDone');
            } catch (error) {
                console.error('Cloud consent reset failed:', error);
                const view = this.aiErrorView(error, 'aiSettings.saveFailed');
                this.aiNotify('danger', view.key, view.params);
            }
        },

        /** Step one: pick a model file. Nothing is loaded or hashed yet. */
        async aiLocalBrowse(slot) {
            this.aiLocalMessage = null;
            this.aiLocalBrowsing = slot;
            this.aiSettingsDirty = true;
            try {
                const picked = await browseLocalModel(this.aiLocal, slot);
                if (!picked) return;
                this.aiLocalMessage = { type: 'info', key: 'aiSettings.local.modelPicked' };
            } catch (error) {
                console.error('Local model pick failed:', error);
                this.aiLocalMessage = { type: 'danger', key: 'aiSettings.local.pickFailed' };
            } finally {
                this.aiLocalBrowsing = null;
            }
        },

        /**
         * Step two: verify the picked file. The SHA-256 and the header probe
         * run here, so the slow work is a separate, deliberate click.
         */
        async aiLocalVerify(slot) {
            this.aiLocalMessage = null;
            this.aiLocalVerifying = slot;
            try {
                const result = await verifyLocalModelSlot(this.aiLocal, slot);
                if (!result.ok) {
                    this.aiLocalMessage = {
                        type: 'danger',
                        key: 'aiSettings.local.modelRejected',
                        params: { detail: this.aiLocalErrorDetail(result) },
                    };
                    return;
                }
                this.aiLocalMessage = { type: 'success', key: 'aiSettings.local.modelAccepted' };
            } catch (error) {
                console.error('Local model verification failed:', error);
                this.aiLocalMessage = {
                    type: 'danger',
                    key: 'aiSettings.local.modelRejected',
                    params: { detail: error?.message || this.t('aiSettings.local.pickFailed') },
                };
            } finally {
                this.aiLocalVerifying = null;
            }
        },

        /** The error code and the detail, when the probe supplied both. */
        aiLocalErrorDetail(result) {
            const code = String(result?.code ?? '');
            const message = String(result?.message ?? '');
            if (code && message) return `${code}: ${message}`;
            return code || message || this.t('aiSettings.local.pickFailed');
        },

        /** Pick the folder with the tokenizer and the config files. */
        async aiLocalBrowseSupport() {
            this.aiLocalMessage = null;
            this.aiSettingsDirty = true;
            try {
                const picked = await pickSupportFiles(this.aiLocal);
                // A plain cancel is not a failure. The input fallback only
                // returns false when the clinic closed the picker too.
                if (!picked) return;
                if (this.aiLocal.support.missing.length > 0) {
                    this.aiLocalMessage = { type: 'warning', key: 'aiSettings.local.supportMissing', params: { files: this.aiLocal.support.missing.join(', ') } };
                    return;
                }
                this.aiLocalMessage = { type: 'success', key: 'aiSettings.local.supportAccepted' };
            } catch (error) {
                console.error('Local support files pick failed:', error);
                this.aiLocalMessage = { type: 'danger', key: 'aiSettings.local.pickFailed' };
            }
        },

        /** Forget one model. */
        aiLocalRemove(slot) {
            this.aiLocal[slot] = emptySlot();
            this.aiLocalMessage = null;
            this.aiSettingsDirty = true;
        },

        /** The layout changed: the other slot is not used any more. */
        aiOnLocalLayoutChange() {
            this.aiLocalMessage = null;
            this.aiSettingsDirty = true;
        },

        /**
         * Write one config value.
         *
         * The kind of the field decides how the value is read: a switch is a
         * boolean, a text field is text, everything else is a number. A
         * number field that was cleared or contains garbage keeps its previous
         * value rather than becoming NaN.
         */
        aiLocalSetConfig(group, key, value) {
            if (!this.aiLocal.config[group]) return;
            const current = this.aiLocal.config[group][key];
            const path = `${group}.${key}`;
            let next;
            if (LOCAL_TEXT_CONFIG.has(path)) {
                const text = String(value ?? '').trim();
                next = text === '' && key === 'chatTemplate' ? null : text;
            } else if (typeof current === 'boolean') {
                next = Boolean(value);
            } else {
                const text = String(value ?? '').trim();
                if (text === '') {
                    next = current;
                } else {
                    const number = Number(text);
                    next = Number.isFinite(number) ? number : current;
                }
            }
            this.aiLocal.config = {
                ...this.aiLocal.config,
                [group]: { ...this.aiLocal.config[group], [key]: next },
            };
            this.aiLocalClearConfigError(path);
            this.aiSettingsDirty = true;
        },

        aiLocalClearConfigError(path) {
            if (!this.aiLocalConfigErrors[path]) return;
            const next = { ...this.aiLocalConfigErrors };
            delete next[path];
            this.aiLocalConfigErrors = next;
        },

        /** True when a field is outside the bounds the server enforces too. */
        aiLocalConfigInvalid(path) {
            return this.aiLocalConfigErrors[path] === true;
        },

        /**
         * Validate on blur: the whole config is checked because a few bounds
         * are relational (ubatch <= batch, heartbeat <= lease/2).
         */
        aiLocalValidateConfigField(group, key) {
            const result = validateLocalConfig(this.aiLocal.config);
            const errors = result.errors ?? [];
            this.aiLocalConfigErrors = Object.fromEntries(errors.map((path) => [path, true]));
            return !errors.includes(`${group}.${key}`);
        },

        aiLocalValidateConfig() {
            const result = validateLocalConfig(this.aiLocal.config);
            this.aiLocalConfigErrors = Object.fromEntries((result.errors ?? []).map((path) => [path, true]));
            return result;
        },

        /** The human label of a dotted config path, for the error message. */
        aiLocalConfigLabel(path) {
            const fields = [...LOCAL_TEXT_FIELDS, ...LOCAL_OCR_FIELDS, ...LOCAL_RUNTIME_FIELDS];
            const field = fields.find((entry) => `${entry.group}.${entry.key}` === path);
            return field ? this.t(field.labelKey) : path;
        },

        /** The resolved config: device tier defaults plus the user's choices. */
        aiLocalResolvedConfig() {
            return resolveConfig(this.aiLocal).config;
        },

        aiLocalConfigWarnings() {
            return resolveConfig(this.aiLocal).warnings ?? [];
        },

        /** The colour of one readiness chip. */
        aiLocalSignals() {
            return deviceSignals(this.aiLocalDevice ?? {});
        },

        aiLocalSignal(name) {
            return this.aiLocalSignals()[name] ?? 'warn';
        },

        /** The suggested tier, in the words the card uses (medium, not mid). */
        aiLocalTierLabel(tier = this.aiLocalDevice?.tier) {
            const normalized = tier === 'low' || tier === 'high' ? tier : 'medium';
            return this.t(`aiSettings.local.tier.${normalized}`);
        },

        aiLocalThreadsLabel() {
            const count = Number(this.aiLocalDevice?.threads) || 0;
            return count > 0
                ? this.t('aiSettings.local.chip.threads', { count })
                : this.t('aiSettings.local.chip.unknown');
        },

        aiLocalMemoryLabel() {
            const count = Number(this.aiLocalDevice?.memory) || 0;
            return count > 0
                ? this.t('aiSettings.local.chip.memory', { count })
                : this.t('aiSettings.local.chip.memoryUnknown');
        },

        aiLocalStorageLabel() {
            const free = Number(this.aiLocalDevice?.storageFree) || 0;
            return free > 0
                ? this.t('aiSettings.local.chip.storage', { size: this.aiLocalFormatBytes(free) })
                : this.t('aiSettings.local.chip.unknown');
        },

        /** The badge class of a model slot. */
        aiLocalBadgeClass(status) {
            if (status === 'ok') return 'text-bg-success border';
            if (status === 'warn') return 'text-bg-warning border';
            if (status === 'error') return 'text-bg-danger border';
            return 'text-bg-light border';
        },

        /** The badge text of a model slot. */
        aiLocalBadgeKey(status) {
            if (status === 'ok') return 'aiSettings.local.statusReady';
            if (status === 'warn') return 'aiSettings.local.statusNotVerified';
            if (status === 'error') return 'aiSettings.local.statusError';
            return 'aiSettings.local.statusNone';
        },

        /** The badge says why a slot failed, not just that it failed. */
        aiLocalBadgeLabel(slot) {
            const status = slot?.status;
            if (status === 'error' && slot?.code) {
                return this.t('aiSettings.local.statusErrorCode', { code: slot.code });
            }
            return this.t(this.aiLocalBadgeKey(status));
        },

        /** A slot message is either a translation key or a probe's own text. */
        aiLocalSlotMessage(slot) {
            const message = slot?.message ?? '';
            if (!message) return '';
            return this.t(message, slot?.params ?? {});
        },

        /** The size and the hash of a model file. */
        aiLocalFileMeta(slot) {
            const parts = [];
            if (slot.size) parts.push(this.aiLocalFormatBytes(slot.size));
            if (slot.sha256) parts.push(this.t('aiSettings.local.sha256', { hash: slot.sha256.slice(0, 12) }));
            return parts.join(' · ');
        },

        aiLocalFormatBytes(bytes) {
            const number = Number(bytes) || 0;
            if (number <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB'];
            let value = number;
            let index = 0;
            while (value >= 1000 && index < units.length - 1) {
                value /= 1000;
                index += 1;
            }
            return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
        },

        /** The provider token limit only applies to the cloud engine. */
        aiLimitIsCloudOnly(field) {
            return field.key === 'PROVIDER_TOKENS_PER_MINUTE';
        },

        aiChainRow(provider = '', model = '') {
            this.aiSettingsRowSeq += 1;
            return {
                _key: `ai-chain-${this.aiSettingsRowSeq}`,
                provider,
                model,
            };
        },

        aiProviderLabel(provider) {
            const option = this.aiProviderOptions.find((entry) => entry.id === provider);
            return option ? this.t(option.labelKey) : String(provider || '');
        },

        aiSavedProvider(provider) {
            return this.aiSettings?.providers?.[provider] ?? {};
        },

        /** Ready for a chain row, including credentials typed but not saved. */
        aiProviderConfigured(provider) {
            const credentials = this.aiSettingsForm.credentials;
            const saved = this.aiSavedProvider(provider);
            if (provider === 'openrouter') {
                return Boolean(credentials.openrouter.apiKey.trim())
                    || (saved.configured === true && !credentials.openrouter.clearKey);
            }
            if (provider === 'cloudflare') {
                if (!credentials.cloudflare.accountId.trim()) return false;
                return Boolean(credentials.cloudflare.apiToken.trim())
                    || (saved.configured === true && !credentials.cloudflare.clearToken);
            }
            if (provider === 'openai') {
                return Boolean(credentials.openai.baseUrl.trim());
            }
            if (provider === 'groq') {
                return Boolean(credentials.groq.apiKey.trim())
                    || (saved.configured === true && !credentials.groq.clearKey);
            }
            return false;
        },

        aiProviderHasSavedKey(provider) {
            return this.aiSavedProvider(provider).hasKey === true;
        },

        aiProviderSavedKey(provider) {
            if (!this.aiProviderHasSavedKey(provider)) return false;
            if (provider === 'cloudflare') return !this.aiSettingsForm.credentials.cloudflare.clearToken;
            return !this.aiSettingsForm.credentials[provider].clearKey;
        },

        aiProviderInChain(provider) {
            return this.aiSettingsForm.chain.some((row) => row.provider === provider);
        },

        aiDraftSecret(provider) {
            if (provider === 'openrouter') return Boolean(this.aiSettingsForm.credentials.openrouter.apiKey.trim());
            if (provider === 'cloudflare') return Boolean(this.aiSettingsForm.credentials.cloudflare.apiToken.trim());
            if (provider === 'openai') return Boolean(this.aiSettingsForm.credentials.openai.apiKey.trim());
            if (provider === 'groq') return Boolean(this.aiSettingsForm.credentials.groq.apiKey.trim());
            return false;
        },

        aiProviderWarning(provider) {
            const saved = this.aiSavedProvider(provider);
            if (!saved.configured || saved.healthy !== false) return '';
            if (!this.aiProviderConfigured(provider)) return '';
            if (this.aiDraftSecret(provider)) return '';
            return this.t(saved.code === 'ENCRYPTION_KEY_MISSING'
                ? 'aiSettings.encryptionMissing'
                : 'aiSettings.keyUnreadable');
        },

        aiProviderReady(provider) {
            return this.aiProviderConfigured(provider) && !this.aiProviderWarning(provider);
        },

        aiProviderStatusText(provider) {
            if (!this.aiProviderConfigured(provider)) return this.t('aiSettings.notConfigured');
            if (this.aiProviderWarning(provider)) return this.t('aiSettings.healthWarning');
            return this.t('aiSettings.configured');
        },

        aiSelectProvider(provider) {
            this.aiSettingsProvider = provider;
            this.aiClearMessage();
        },

        aiOnCredentialInput(provider) {
            this.aiClearTest(provider);
            this.aiClearMessage();
        },

        aiOnChainInput(index, field) {
            this.aiClearInvalid(index, field);
            this.aiClearMessage();
        },

        aiHasFreeOpenRouter() {
            return (this.aiSettingsForm?.chain ?? []).some((row) => (
                row.provider === 'openrouter'
                && String(row.model ?? '').trim().toLowerCase().endsWith(':free')
            ));
        },

        aiAddChainRow() {
            if (this.aiSettingsForm.chain.length >= this.aiSettingsMaxModels) {
                this.aiNotify('warning', 'aiSettings.chainTooLong', { max: this.aiSettingsMaxModels });
                return;
            }
            this.aiSettingsForm.chain.push(this.aiChainRow());
            this.aiClearMessage();
        },

        aiRemoveChainRow(index) {
            this.aiSettingsForm.chain.splice(index, 1);
            this.aiSettingsInvalid = {};
            this.aiClearMessage();
        },

        aiMoveChainRow(index, delta) {
            const target = index + delta;
            if (target < 0 || target >= this.aiSettingsForm.chain.length) return;
            const [row] = this.aiSettingsForm.chain.splice(index, 1);
            this.aiSettingsForm.chain.splice(target, 0, row);
            this.aiSettingsInvalid = {};
            this.aiClearMessage();
        },

        aiClearInvalid(index, field) {
            const key = `${index}:${field}`;
            if (!(key in this.aiSettingsInvalid)) return;
            const next = { ...this.aiSettingsInvalid };
            delete next[key];
            this.aiSettingsInvalid = next;
        },

        aiIsInvalid(index, field) {
            return this.aiSettingsInvalid[`${index}:${field}`] === true;
        },

        aiClearAllInvalid() {
            this.aiSettingsInvalid = {};
        },

        aiClearTest(provider) {
            if (!this.aiSettingsTestResults[provider]) return;
            this.aiSettingsTestResults = { ...this.aiSettingsTestResults, [provider]: null };
        },

        aiTestText(provider) {
            const result = this.aiSettingsTestResults[provider];
            return result ? this.t(result.key, result.params) : '';
        },

        aiTestClass(provider) {
            const result = this.aiSettingsTestResults[provider];
            if (!result) return '';
            if (result.type === 'success') return 'text-success';
            if (result.type === 'warning') return 'text-warning';
            return 'text-danger';
        },

        aiClearMessage() {
            if (this.aiSettingsMessage) this.aiSettingsMessage = null;
        },

        aiNotify(type, key, params = {}) {
            this.aiSettingsMessage = { type, key, params };
        },

        aiValidateSettings() {
            this.aiClearAllInvalid();
            const chain = this.aiSettingsForm.chain;
            const touched = [];
            chain.forEach((row, index) => {
                const provider = String(row.provider ?? '');
                const model = String(row.model ?? '').trim();
                if (!provider && !model) return;
                touched.push({ index, provider, model });
            });

            // The cloud engine needs a model chain. The local engine needs a
            // model file and a config inside the bounds the server enforces.
            if (this.aiEngine === 'local') {
                if (!this.aiLocalModelReady()) {
                    this.aiNotify('warning', 'aiSettings.local.modelMissing');
                    return false;
                }
                // Support files are only required when the vision model is
                // actually ready (verified). A vision model in error state
                // (e.g., wrong file type, verification failed) should not
                // block saving a text-only configuration.
                if (this.aiLocal.mode === 'split'
                    && this.aiLocal.vision.name
                    && this.aiLocal.vision.status === 'ok'
                    && (this.aiLocal.support.missing ?? []).length > 0) {
                    this.aiNotify('warning', 'aiSettings.local.supportMissing', {
                        files: this.aiLocal.support.missing.join(', '),
                    });
                    return false;
                }
                const validation = this.aiLocalValidateConfig();
                if (!validation.valid) {
                    const fields = validation.errors.map((path) => this.aiLocalConfigLabel(path)).join(', ');
                    this.aiNotify('warning', 'aiSettings.local.configInvalid', { fields });
                    return false;
                }
                return true;
            }

            if (this.aiSettingsForm.enabled && touched.length === 0) {
                this.aiNotify('warning', 'aiSettings.chainEmpty');
                return false;
            }
            if (touched.length > this.aiSettingsMaxModels) {
                this.aiNotify('warning', 'aiSettings.chainTooLong', { max: this.aiSettingsMaxModels });
                return false;
            }

            const seen = new Set();
            for (const item of touched) {
                if (!item.provider || !item.model) {
                    this.aiSettingsInvalid = {
                        ...this.aiSettingsInvalid,
                        [`${item.index}:provider`]: !item.provider,
                        [`${item.index}:model`]: !item.model,
                    };
                    this.aiNotify('warning', 'aiSettings.chainIncomplete');
                    return false;
                }
                if (item.model.length > 160) {
                    this.aiSettingsInvalid = { ...this.aiSettingsInvalid, [`${item.index}:model`]: true };
                    this.aiNotify('warning', 'aiSettings.modelTooLong');
                    return false;
                }
                if (!this.aiProviderReady(item.provider)) {
                    this.aiSettingsInvalid = { ...this.aiSettingsInvalid, [`${item.index}:provider`]: true };
                    this.aiNotify('warning', 'aiSettings.providerNotReady', {
                        provider: this.aiProviderLabel(item.provider),
                    });
                    return false;
                }
                const key = `${item.provider}:${item.model.toLowerCase()}`;
                if (seen.has(key)) {
                    this.aiSettingsInvalid = { ...this.aiSettingsInvalid, [`${item.index}:model`]: true };
                    this.aiNotify('warning', 'aiSettings.chainDuplicate');
                    return false;
                }
                seen.add(key);
            }
            return true;
        },

        /** True when the local engine has everything it needs. */
        aiLocalModelReady() {
            const local = this.aiLocal;
            if (local.mode === 'single') return Boolean(local.multimodal.name);
            // The text model is the one every split import needs. The vision
            // model is only needed when the import contains images, so a
            // missing or broken vision file must not block a text import.
            return Boolean(local.text.name);
        },

        aiSavePayload() {
            const credentials = this.aiSettingsForm.credentials;
            const chain = this.aiSettingsForm.chain
                // Only the complete rows go to the server: a half-filled row
                // is a draft, and the server refuses an incomplete chain.
                .filter((row) => row.provider && String(row.model ?? '').trim())
                .map((row) => ({ provider: row.provider, model: String(row.model ?? '').trim() }));
            const engine = this.aiEngine;
            return {
                // The segmented control sets the flag and the mode together.
                enabled: engine !== 'off',
                inference_mode: engine === 'local' ? 'local' : 'cloud',
                cloud_consent: this.aiCloudConsent === true,
                chain,
                // The local profile holds the names, the sizes and the hashes
                // only. The files and their handles stay in the browser. The
                // config is resolved against the device tier, so the server
                // stores exactly what the import will run.
                local_profile: localProfilePayload(this.aiLocal),
                local_config: this.aiLocalResolvedConfig(),
                credentials: {
                    openrouter: {
                        apiKey: credentials.openrouter.apiKey.trim(),
                        clearKey: credentials.openrouter.clearKey === true,
                    },
                    cloudflare: {
                        accountId: credentials.cloudflare.accountId.trim(),
                        apiToken: credentials.cloudflare.apiToken.trim(),
                        clearToken: credentials.cloudflare.clearToken === true,
                    },
                    openai: {
                        baseUrl: credentials.openai.baseUrl.trim(),
                        apiKey: credentials.openai.apiKey.trim(),
                        clearKey: credentials.openai.clearKey === true,
                    },
                    groq: {
                        apiKey: credentials.groq.apiKey.trim(),
                        clearKey: credentials.groq.clearKey === true,
                    },
                },
            };
        },

        async saveAiSettings() {
            if (this.aiSettingsSaving) return;
            if (!this.aiValidateSettings()) return;
            this.aiSettingsSaving = true;
            try {
                // The models are remembered in the browser, so the clinic
                // picks them once and not on every visit. Write them BEFORE
                // the server call: a rejected server save (for example when
                // the deployment has turned the local engine off) must not
                // throw away a file the clinic already picked.
                const hasLocalFiles = ['multimodal', 'text', 'vision']
                    .some((slot) => Boolean(this.aiLocal?.[slot]?.name));
                if (hasLocalFiles) await persistLocalState(this.aiLocal);
                const data = await saveAiSettingsApi(this.aiSavePayload());
                this.applyAiSettings(data);
                clearImportFlagCache();
                this.importEnabled = data.enabled === true;
                if (!this.importEnabled) {
                    this.importResumable = null;
                } else {
                    this.refreshImportResume();
                }
                this.aiNotify('success', 'aiSettings.saved');
            } catch (error) {
                console.error('AI settings save failed:', error);
                const view = this.aiErrorView(error, 'aiSettings.saveFailed');
                this.aiNotify('danger', view.key, view.params);
            } finally {
                this.aiSettingsSaving = false;
            }
        },

        aiTestPayload(provider) {
            const credentials = this.aiSettingsForm.credentials;
            if (provider === 'openrouter') {
                return { apiKey: credentials.openrouter.apiKey.trim() };
            }
            if (provider === 'cloudflare') {
                return {
                    accountId: credentials.cloudflare.accountId.trim(),
                    apiToken: credentials.cloudflare.apiToken.trim(),
                };
            }
            if (provider === 'groq') {
                return { apiKey: credentials.groq.apiKey.trim() };
            }
            return {
                baseUrl: credentials.openai.baseUrl.trim(),
                apiKey: credentials.openai.apiKey.trim(),
            };
        },

        async testAiSettingsProvider(provider) {
            if (this.aiSettingsTesting) return;
            this.aiSettingsTesting = provider;
            this.aiClearTest(provider);
            this.aiClearMessage();
            try {
                const result = await testAiProviderApi(provider, this.aiTestPayload(provider));
                const daily = result?.freeDaily;
                const remaining = Number(daily?.remaining);
                const limit = Number(daily?.limit);
                const used = Number(daily?.used);
                if (provider === 'openrouter' && daily && Number.isFinite(remaining)) {
                    this.aiSettingsTestResults = {
                        ...this.aiSettingsTestResults,
                        [provider]: remaining > 0
                            ? {
                                type: 'success',
                                key: 'aiSettings.testOkFreeQuota',
                                params: { remaining, limit: Number.isFinite(limit) ? limit : 0 },
                            }
                            : {
                                type: 'warning',
                                key: 'aiSettings.testFreeQuotaExhausted',
                                params: {
                                    used: Number.isFinite(used) ? used : 0,
                                    limit: Number.isFinite(limit) ? limit : 0,
                                },
                            },
                    };
                } else {
                    this.aiSettingsTestResults = {
                        ...this.aiSettingsTestResults,
                        [provider]: { type: 'success', key: 'aiSettings.testOk', params: {} },
                    };
                }
            } catch (error) {
                console.error('AI provider test failed:', provider, error?.code);
                this.aiSettingsTestResults = {
                    ...this.aiSettingsTestResults,
                    [provider]: this.aiTestErrorView(error),
                };
            } finally {
                this.aiSettingsTesting = null;
            }
        },

        aiRemoveSavedKey(provider) {
            if (!this.aiProviderSavedKey(provider)) return;
            if (provider !== 'openai' && this.aiProviderInChain(provider)) {
                this.aiNotify('warning', 'aiSettings.providerInUse');
                return;
            }
            if (!confirm(this.t('aiSettings.removeKeyConfirm', { provider: this.aiProviderLabel(provider) }))) {
                return;
            }
            if (provider === 'openrouter') {
                this.aiSettingsForm.credentials.openrouter.apiKey = '';
                this.aiSettingsForm.credentials.openrouter.clearKey = true;
            } else if (provider === 'cloudflare') {
                this.aiSettingsForm.credentials.cloudflare.apiToken = '';
                this.aiSettingsForm.credentials.cloudflare.clearToken = true;
            } else if (provider === 'groq') {
                this.aiSettingsForm.credentials.groq.apiKey = '';
                this.aiSettingsForm.credentials.groq.clearKey = true;
            } else {
                this.aiSettingsForm.credentials.openai.apiKey = '';
                this.aiSettingsForm.credentials.openai.clearKey = true;
            }
            this.aiClearTest(provider);
            this.aiNotify('warning', 'aiSettings.keyRemovedOnSave');
        },

        async aiDiscardChanges() {
            if (!this.aiSettings) {
                this.loadAiSettings();
                return;
            }
            // Restore the browser-side handles first: the server never has
            // them, and applyAiSettings keeps one only when the server still
            // names the same file. Without this step a discard after browsing
            // another model loses the saved model's handle.
            await restoreLocalState(this.aiLocal);
            this.applyAiSettings(this.aiSettings);
            this.aiLocalMessage = null;
            this.aiLocalConfigErrors = {};
            this.aiNotify('info', 'aiSettings.discarded');
        },

        aiErrorView(error, fallbackKey) {
            const code = String(error?.code ?? '');
            const provider = error?.details?.provider
                ? this.aiProviderLabel(error.details.provider)
                : this.t('aiSettings.providerLabel');
            if (code === 'OFFLINE') return { key: 'aiSettings.offline', params: {} };
            if (code === 'BACKEND_OUTDATED' || code === 'NOT_FOUND') {
                return { key: 'aiSettings.backendOutdated', params: {} };
            }
            if (code.startsWith('UNAUTHORIZED')) return { key: 'aiSettings.sessionExpired', params: {} };
            if (code === 'FORBIDDEN') return { key: 'aiSettings.forbidden', params: {} };
            if (code === 'ENCRYPTION_KEY_MISSING') return { key: 'aiSettings.encryptionMissing', params: {} };
            if (code === 'PROVIDER_IN_USE') return { key: 'aiSettings.providerInUse', params: {} };
            if (code === 'PROVIDER_NOT_READY') return { key: 'aiSettings.providerNotReady', params: { provider } };
            if (code === 'CHAIN_EMPTY') return { key: 'aiSettings.chainEmpty', params: {} };
            if (code === 'CHAIN_INCOMPLETE') return { key: 'aiSettings.chainIncomplete', params: {} };
            if (code === 'CHAIN_TOO_LONG') {
                return { key: 'aiSettings.chainTooLong', params: { max: this.aiSettingsMaxModels } };
            }
            if (code === 'CHAIN_DUPLICATE') return { key: 'aiSettings.chainDuplicate', params: {} };
            if (code === 'MODEL_TOO_LONG') return { key: 'aiSettings.modelTooLong', params: {} };
            if (code === 'CLOUD_CONSENT_REQUIRED') return { key: 'aiSettings.consent.required', params: {} };
            if (code === 'LOCAL_MODE_DISABLED') return { key: 'aiSettings.local.disabledHint', params: {} };
            if (code === 'ENGINE_MISMATCH') return { key: 'aiSettings.engineMismatch', params: {} };
            if (code === 'LOCAL_MODEL_NOT_CONFIGURED') return { key: 'aiSettings.local.modelMissing', params: {} };
            if (code === 'INVALID_ACCOUNT_ID') return { key: 'aiSettings.invalidAccountId', params: {} };
            if (code === 'INVALID_BASE_URL') return { key: 'aiSettings.invalidBaseUrl', params: {} };
            if (code === 'INVALID_SECRET') return { key: 'aiSettings.invalidSecret', params: {} };
            if (code === 'BAD_REQUEST') return { key: 'aiSettings.badRequest', params: {} };
            if (code === 'SAVE_FAILED') return { key: 'aiSettings.saveFailed', params: {} };
            if (code === 'DECRYPT_FAILED') return { key: 'aiSettings.keyUnreadable', params: {} };
            return { key: fallbackKey, params: {} };
        },

        aiTestErrorView(error) {
            const code = String(error?.code ?? '');
            if (code === 'NOT_CONFIGURED') {
                return { type: 'warning', key: 'aiSettings.testNeedsCredentials', params: {} };
            }
            if (code === 'TEST_FAILED') {
                const status = error?.details?.upstreamStatus;
                if (!status) {
                    return { type: 'danger', key: 'aiSettings.testUnreachable', params: {} };
                }
                if (status === 401 || status === 403) {
                    return { type: 'danger', key: 'aiSettings.testRejected', params: { status } };
                }
                return { type: 'danger', key: 'aiSettings.testRequestRejected', params: { status } };
            }
            const view = this.aiErrorView(error, 'aiSettings.couldNotTest');
            return { type: 'danger', key: view.key, params: view.params };
        },

        optionKindLabel(kind) {
            if (kind === 'follower') return this.t('Followers');
            if (kind === 'section') return this.t('Sections');
            return this.t('Sources of Money');
        },
        
        optionKindIcon(kind) {
            if (kind === 'follower') return 'bi-person-check-fill';
            if (kind === 'section') return 'bi-diagram-3-fill';
            return 'bi-cash-coin';
        },
        
        async addOption(kind) {
            const draft = this.newOption[kind];
            if (!draft.label_en.trim() && !draft.label_ar.trim()) {
                this.showAlert(this.t('Enter a label in at least one language.'), 'warning');
                return;
            }
            try {
                await createOption(kind, draft);
                draft.label_en = '';
                draft.label_ar = '';
                await this.refreshOptions();
                this.resetSettingsOptions();
                this.showAlert(this.t('Option added.'), 'success');
            } catch (error) {
                console.error(error);
                this.showAlert(this.t('Could not save the option.') + ' ' + this.errorMessage(error), 'danger');
            }
        },
        
        async saveOption(kind, row) {
            if (!String(row.label_en).trim() && !String(row.label_ar).trim()) {
                this.showAlert(this.t('Enter a label in at least one language.'), 'warning');
                return;
            }
            row._saving = true;
            try {
                await updateOption(row.id, { label_en: row.label_en, label_ar: row.label_ar, active: row.active });
                row._dirty = false;
                await this.refreshOptions();
                this.showAlert(this.t('Option saved.'), 'success');
            } catch (error) {
                console.error(error);
                this.showAlert(this.t('Could not save the option.') + ' ' + this.errorMessage(error), 'danger');
            } finally {
                row._saving = false;
            }
        },
        
        async removeOption(kind, row) {
            if (row._saving || row._removing) return;
            row._removing = true;
            try {
                const used = await countOptionUsage(kind, row.key);
                if (used > 0) {
                    this.showAlert(this.t('This option is used by :count patient(s). Deactivate it instead so existing records keep their label.', { count: used }), 'warning');
                    return;
                }
                if (!confirm(this.t('Remove this option permanently?'))) return;
                await deleteOption(row.id);
                await this.refreshOptions();
                this.resetSettingsOptions();
                this.showAlert(this.t('Option removed.'), 'success');
            } catch (error) {
                console.error(error);
                this.showAlert(this.t('Could not remove the option.') + ' ' + this.errorMessage(error), 'danger');
            } finally {
                row._removing = false;
            }
        },
        
        async loadUsers() {
            // The Users tab only exists inside Settings, which no non-admin
            // can open; this also keeps stale state from loading the list.
            if (!this.isSuperAdmin) return;
            const epoch = this.sessionEpoch;
            this.usersError = null;
            this.usersLoading = true;
            try {
                const { getUsers } = await import('./services/users.js');
                const users = await getUsers();
                if (epoch !== this.sessionEpoch) return;
                this.users = users;
            } catch (error) {
                if (epoch !== this.sessionEpoch) return;
                console.error('User list load failed:', error);
                // The message lands in the tab with a retry action instead of
                // leaving a blank table.
                this.usersError = this.errorMessage(error);
            } finally {
                if (epoch === this.sessionEpoch) this.usersLoading = false;
            }
        },

        // Database errors reach the UI translated and short (issue #34);
        // English Postgres strings like "duplicate key value violates
        // constraint" must never surface in an Arabic clinic system.
        errorMessage(error) {
            return dbErrorMessage(error, (key) => this.t(key));
        },
        
        async loadPatients({ page = 1 } = {}) {
            if (!this.isLoggedIn) return;
            const epoch = this.sessionEpoch;
            this.patientPage = Math.max(1, Math.trunc(Number(page) || 1));
            this.patientsLoading = true;
            this.patientsError = false;
            try {
                const noEmpty = {};
                Object.entries(this.patientFilters).forEach(([k, v]) => {
                    if (v !== '' && v !== null && v !== undefined) noEmpty[k] = v;
                });
                if (noEmpty.search) noEmpty.search_terms = this.searchTerms(noEmpty.search);
                const result = await getPatientsPage({
                    ...noEmpty,
                    sort: this.patientSort.key,
                    dir: this.patientSort.dir,
                }, {
                    page: this.patientPage,
                    pageSize: this.patientPageSize,
                });
                // The signed-out shell was reset while this request was in
                // flight; discard the previous user's rows.
                if (epoch !== this.sessionEpoch) return;
                const lastPage = Math.max(1, Math.ceil(result.total / this.patientPageSize));
                if (this.patientPage > lastPage) {
                    // A delete or a filter change can empty the page that was
                    // open; show the last page that still has rows.
                    this.patientPage = lastPage;
                    await this.loadPatients({ page: lastPage });
                    return;
                }
                this.patients = result.rows;
                this.patientTotal = result.total;
            } catch (error) {
                // Keep the rows already on screen: a failed refresh must
                // neither empty the table nor leave it silently stale
                // (issue #27). The banner offers a retry.
                console.error('Patient list load failed:', error);
                this.patientsError = true;
            } finally {
                if (epoch === this.sessionEpoch) this.patientsLoading = false;
            }
        },

        patientPageCount() {
            return Math.max(1, Math.ceil(this.patientTotal / this.patientPageSize));
        },

        async goToPatientPage(page) {
            const target = Math.max(1, Math.min(this.patientPageCount(), Math.trunc(Number(page) || 1)));
            if (target === this.patientPage || this.patientsLoading) return;
            await this.loadPatients({ page: target });
        },
        
        // ---- The sort of the patients table ---------------------------------

        // The columns the table can be sorted by, with the label of their
        // header - the menu of the sort button and the header of the table
        // always say the same thing.
        sortOptions() {
            return [
                { key: 'name', label: this.t('Patient Name') },
                { key: 'national_id', label: this.t('National ID') },
                { key: 'mobile', label: this.t('Mobile No.') },
                { key: 'governorate', label: this.t('Governorate') },
                { key: 'is_completed', label: this.t('Status') },
                { key: 'follower', label: this.t('Follower') },
                { key: 'source_of_money', label: this.t('Source of Money') },
                { key: 'section', label: this.t('Section') },
                { key: 'created_at', label: this.t('Registered Date') },
            ];
        },

        // Sort by a column: the same column again flips the direction, a new
        // column starts at the beginning - ascending, and the newest first
        // for the date.
        async sortPatientsBy(key) {
            const current = this.patientSort;
            const dir = current.key === key
                ? (current.dir === 'asc' ? 'desc' : 'asc')
                : (key === 'created_at' ? 'desc' : 'asc');
            this.patientSort = { key, dir };
            await this.loadPatients();
        },

        // The arrow of a column: the direction of the current sort, or a
        // faint sign that the column can be sorted at all.
        sortIcon(key) {
            if (this.patientSort.key !== key) return 'bi-arrow-down-up';
            return this.patientSort.dir === 'asc' ? 'bi-sort-up' : 'bi-sort-down';
        },

        // What the sort button says right now.
        sortSummary() {
            const option = this.sortOptions().find((o) => o.key === this.patientSort.key);
            const label = option ? option.label : this.t('Registered Date');
            const dir = this.patientSort.dir === 'asc' ? this.t('Ascending') : this.t('Descending');
            return `${this.t('Sort')}: ${label} (${dir})`;
        },

        // For the screen readers: what the column is sorted by.
        ariaSort(key) {
            if (this.patientSort.key !== key) return 'none';
            return this.patientSort.dir === 'asc' ? 'ascending' : 'descending';
        },

        // ---- Patients filters panel (issue #13) ------------------------------
        
        // Number of active filters: drives the count badge and the chips row.
        activeFilterCount() {
            return activeFilterKeys(this.patientFilters, { admin: this.isSuperAdmin }).length;
        },
        
        // The applied filters as removable chips, so the reason the table is
        // filtered stays visible while the panel is closed.
        appliedFilterChips() {
            const f = this.patientFilters;
            const chips = [];
            
            if ((f.search || '').trim()) {
                chips.push({ key: 'search', label: `${this.t('Search')}: ${f.search.trim()}` });
            }
            if (f.is_completed === 'true' || f.is_completed === 'false') {
                chips.push({
                    key: 'is_completed',
                    label: `${this.t('Status')}: ${this.t(f.is_completed === 'true' ? 'Completed' : 'Pending')}`,
                });
            }
            if (f.date_from || f.date_to) {
                const range = [this.formatDate(f.date_from), this.formatDate(f.date_to)].filter(Boolean).join(' – ');
                chips.push({ key: 'dates', label: `${this.t('Registered')}: ${range}` });
            }
            if (this.isSuperAdmin) {
                if (f.follower) chips.push({ key: 'follower', label: `${this.t('Follower')}: ${this.optionLabel('follower', f.follower)}` });
                if (f.section) chips.push({ key: 'section', label: `${this.t('Section')}: ${this.optionLabel('section', f.section)}` });
                if (f.source_of_money) chips.push({ key: 'source_of_money', label: `${this.t('Source of Money')}: ${this.optionLabel('source', f.source_of_money)}` });
            }
            return chips.map((chip) => ({ ...chip, aria: `${this.t('Remove')} ${chip.label}` }));
        },
        
        // Chips act on the applied filters directly (no panel round-trip) and
        // refetch once. The date range chip removes both date bounds together.
        async removeAppliedFilter(key) {
            const next = emptyPatientFilters();
            activeFilterKeys(this.patientFilters).forEach((active) => { next[active] = this.patientFilters[active]; });
            if (key === 'dates') {
                next.date_from = '';
                next.date_to = '';
            } else {
                next[key] = '';
            }
            this.patientFilters = next;
            await this.loadPatients();
        },
        
        // Clear every filter and refetch immediately. Used by the toolbar's
        // clear-all action and the panel's Reset.
        async clearAllFilters() {
            this.patientFilters = emptyPatientFilters();
            this.filterDraft = emptyPatientFilters();
            await this.loadPatients();
        },
        
        // Opening the panel stages a copy of the applied filters; reopening
        // therefore always shows what the table is actually scoped by.
        openFilters() {
            this.filterDraft = { ...emptyPatientFilters(), ...this.patientFilters };
            this.showFilters = true;
            this.$nextTick(() => {
                this.$refs.filterPanel?.querySelector('input, select')?.focus();
            });
        },
        
        // Closing (toggle, outside click, Esc, the × button) discards the
        // staged values and returns focus to the Filters button.
        closeFilters() {
            this.showFilters = false;
            this.$refs.patientFiltersToggle?.focus();
        },
        
        // Apply: one fetch with the staged filters — no refetch per keystroke.
        async applyFilters() {
            this.patientFilters = { ...emptyPatientFilters(), ...this.filterDraft };
            this.showFilters = false;
            await this.loadPatients();
            this.$refs.patientFiltersToggle?.focus();
        },
        
        // Keep Tab inside the open panel (dialog behaviour on mobile, popover
        // behaviour on desktop) and let Esc close it.
        filtersPanelKeydown(event) {
            if (event.key === 'Escape') {
                event.stopPropagation();
                this.closeFilters();
                return;
            }
            if (event.key !== 'Tab' || !this.showFilters) return;
            const panel = this.$refs.filterPanel;
            if (!panel) return;
            const focusables = panel.querySelectorAll(
                'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            );
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || !panel.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
                event.preventDefault();
                first.focus();
            }
        },
        
        // The terms a search runs with: the word that was typed and every word
        // that means the same thing - the Arabic name of a governorate and
        // the English name that is stored, and so on.
        searchTerms(term) {
            return searchTermVariants(term, buildSearchDictionary({
                follower: allOptions('follower'),
                section: allOptions('section'),
                source: allOptions('source'),
            }));
        },

        // Navbar search. One box, zero options: it searches every patient
        // field at once server-side (anysearch) and shows a handful of live
        // suggestions; picking one opens that patient, Enter opens the full
        // filtered list.
        async onGlobalInput() {
            clearTimeout(this.globalSearchDebounce);
            const query = (this.globalSearch || '').trim();
            if (!query) { this.closeGlobalSearch(); return; }
            
            this.globalSearchDebounce = setTimeout(async () => {
                const requestId = this.globalSearchRequestId + 1;
                this.globalSearchRequestId = requestId;
                this.globalSearchLoading = true;
                try {
                    const results = await getPatients(
                        { search: query, filter_by: 'all', search_terms: this.searchTerms(query) },
                        { limit: 5 },
                    );
                    // Ignore stale responses: only the latest request may
                    // touch the dropdown.
                    if (requestId !== this.globalSearchRequestId) return;
                    this.globalSearchResults = results;
                    this.globalSearchSelectedIndex = -1;
                } catch (error) {
                    if (requestId !== this.globalSearchRequestId) return;
                    console.error('Global search failed:', error);
                    this.globalSearchResults = [];
                } finally {
                    if (requestId === this.globalSearchRequestId) this.globalSearchLoading = false;
                }
            }, 250);
        },
        
        // Instant local filtering while the request is in flight, so the
        // dropdown feels immediate even on slow connections.
        blurredGlobalResults() {
            const query = (this.globalSearch || '').trim();
            if (!query) return [];
            return this.patients.slice(0, 50)
                .filter((patient) => patientMatchesQuery(patient, query, {
                    governorate: (value) => governorateLabel(value),
                    marital: (value) => maritalStatusLabel(value),
                    follower: (key) => lookupOptionLabel('follower', key),
                    section: (key) => lookupOptionLabel('section', key),
                    source: (key) => lookupOptionLabel('source', key),
                }))
                .slice(0, 5);
        },
        
        globalSuggestions() {
            return this.globalSearchResults.length
                ? this.globalSearchResults
                : this.blurredGlobalResults();
        },
        
        onGlobalKeydown(event) {
            const suggestions = this.globalSuggestions();
            if (event.key === 'Escape') { this.closeGlobalSearch({ clearFocus: true }); return; }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                this.globalSearchSelectedIndex = Math.min(
                    this.globalSearchSelectedIndex + 1, suggestions.length - 1);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                this.globalSearchSelectedIndex = Math.max(this.globalSearchSelectedIndex - 1, -1);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                if (this.globalSearchSelectedIndex >= 0 && suggestions[this.globalSearchSelectedIndex]) {
                    this.pickGlobalResult(suggestions[this.globalSearchSelectedIndex]);
                } else {
                    this.runGlobalList();
                }
            }
        },
        
        async runGlobalList() {
            this.closeGlobalSearch({ keepQuery: true });
            this.patientFilters = { ...emptyPatientFilters(), search: this.globalSearch };
            await this.navigate('patients');
        },
        
        async pickGlobalResult(patient) {
            const targetId = patient.id;
            this.closeGlobalSearch({ keepQuery: false, clearFocus: true });
            this.globalSearch = '';
            await this.navigate('patients');
            const found = this.patients.find((p) => p.id === targetId);
            if (found) { await this.showPatient(found); return; }
            // The loaded list can miss the row when active filters exclude
            // it — fetch it directly by id so the pick always opens.
            try {
                const { getPatient } = await import('./services/patients.js');
                const full = await getPatient(targetId);
                if (full) { await this.showPatient(full); return; }
            } catch (error) {
                console.error(error);
            }
            this.showAlert(this.t('Could not open that patient. They may be outside your current filters.'), 'danger');
        },
        
        closeGlobalSearch({ keepQuery = false, clearFocus = false } = {}) {
            clearTimeout(this.globalSearchDebounce);
            this.globalSearchRequestId += 1;
            if (!keepQuery) this.globalSearchResults = [];
            this.globalSearchSelectedIndex = -1;
            if (clearFocus) this.globalSearchFocused = false;
        },
        
        async resetFilters() {
            await this.clearAllFilters();
        },
        
        async toggleStatus(patient) {
            if (!this.canWriteSection(patient?.section)) {
                this.showAlert(this.t('You do not have write access to this section.'), 'danger');
                return;
            }
            try {
                await togglePatientStatus(patient.id, !patient.is_completed);
                patient.is_completed = !patient.is_completed;
            } catch (error) {
                console.error(error);
                this.showAlert(this.t('Could not update the patient status. Please try again.'), 'danger');
            }
        },
        
        async removePatient(patient) {
            if (!this.canWriteSection(patient?.section)) {
                this.showAlert(this.t('You do not have write access to this section.'), 'danger');
                return;
            }
            if (!confirm(this.t('Are you sure you want to delete this patient?'))) return;
            try {
                await deletePatient(patient.id);
                // Refetch the page so the total and the rows agree; loadPatients
                // falls back one page if the last row of this page was deleted.
                await this.loadPatients({ page: this.patientPage });
            } catch (error) {
                console.error(error);
                this.showAlert(this.t('Could not delete the patient. Please try again.'), 'danger');
            }
        },
        
        // ---- Excel export -------------------------------------------------
        // The button writes every row the current viewer is allowed to see
        // (same RLS scope as the on-screen table, active filters honored) in
        // Arabic with every column. The caret opens the same export with
        // choices: language, rows (all / this page / ticked) and columns.

        toggleExportPanel() {
            this.exportPanelOpen = !this.exportPanelOpen;
        },

        closeExportPanel() {
            this.exportPanelOpen = false;
        },

        exportSelectAllFields(selectAll) {
            this.exportOptions.fields = selectAll ? [...EXPORT_FIELD_KEYS] : [];
        },

        isPatientSelected(id) {
            return this.selectedPatientIds.includes(id);
        },

        togglePatientSelection(id, selected) {
            if (!id) return;
            if (selected && !this.selectedPatientIds.includes(id)) this.selectedPatientIds.push(id);
            if (!selected) this.selectedPatientIds = this.selectedPatientIds.filter((value) => value !== id);
        },

        allPageSelected() {
            return this.patients.length > 0
                && this.patients.every((patient) => this.isPatientSelected(patient.id));
        },

        toggleSelectAllOnPage(selected) {
            const ids = this.patients.map((patient) => patient.id);
            if (selected) {
                this.selectedPatientIds = [...new Set([...this.selectedPatientIds, ...ids])];
                return;
            }
            this.selectedPatientIds = this.selectedPatientIds.filter((id) => !ids.includes(id));
        },

        // The filters of the table without the empty values, so the export
        // and the listing can never disagree.
        activePatientFilters() {
            const filters = {};
            Object.entries(this.patientFilters).forEach(([key, value]) => {
                if (value !== '' && value !== null && value !== undefined) filters[key] = value;
            });
            if (filters.search) filters.search_terms = this.searchTerms(filters.search);
            return filters;
        },

        // The rows the chosen scope means; null = every row the filters match.
        exportRowIds(rows) {
            if (rows === 'page') return this.patients.map((patient) => patient.id);
            if (rows === 'selected') return [...this.selectedPatientIds];
            return null;
        },

        async runExport({ rows = 'filtered', language = 'ar', fields = EXPORT_FIELD_KEYS } = {}) {
            if (this.exporting) return false;
            const ids = this.exportRowIds(rows);
            if (ids && !ids.length) {
                this.showAlert(this.t('No patients selected.'), 'warning');
                return false;
            }
            if (!fields.length) {
                this.showAlert(this.t('Choose at least one field.'), 'warning');
                return false;
            }

            this.exporting = true;
            try {
                const { exportPatientsToExcel } = await import('./services/export.js');
                const filename = await exportPatientsToExcel({
                    filters: this.activePatientFilters(),
                    ids,
                    fields,
                    language,
                });
                this.showAlert(this.t('Export ready:') + ' ' + filename);
                return true;
            } catch (error) {
                this.showAlert(this.errorMessage(error), 'danger');
                return false;
            } finally {
                this.exporting = false;
            }
        },

        // The button: the default workbook (Arabic, filtered rows, every column).
        async exportPatients() {
            const done = await this.runExport();
            if (done) this.closeExportPanel();
        },

        // The panel: the choices the caret collected.
        async exportPatientsCustom() {
            const { rows, language, fields } = this.exportOptions;
            const done = await this.runExport({ rows, language, fields });
            if (done) this.closeExportPanel();
        },
        
        formatMoney(value) {
            if (value === null || value === undefined || value === '') return '0.00';
            return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },
        formatDate(dateStr) {
            if (!dateStr) return '';
            return new Date(dateStr).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
        },
        followerLabel(key) {
            return key ? lookupOptionLabel('follower', key) : this.t('None');
        },
        
        // One notification. It stacks with the others instead of replacing
        // them, and removes itself; the close button does the same at once.
        showAlert(message, type = 'success') {
            if (!message) return;
            this.toastSeq += 1;
            const id = this.toastSeq;
            // Four is what fits on a phone screen without covering the page.
            this.toasts = [...this.toasts, { id, message, type }].slice(-4);
            clearTimeout(this.toastTimers[id]);
            this.toastTimers[id] = setTimeout(() => this.dismissAlert(id), 4500);
        },

        dismissAlert(id) {
            clearTimeout(this.toastTimers[id]);
            delete this.toastTimers[id];
            this.toasts = this.toasts.filter((toast) => toast.id !== id);
        },

        toastIcon(type) {
            if (type === 'danger') return 'bi-exclamation-octagon-fill';
            if (type === 'warning') return 'bi-exclamation-triangle-fill';
            if (type === 'info') return 'bi-info-circle-fill';
            return 'bi-check-circle-fill';
        },
        
        // Age is derived, never typed: with a date of birth present it is
        // recalculated and the input goes read-only (see index.html). Without a
        // date of birth the field stays editable, so ages transcribed from the
        // paper forms can still be recorded.
        refreshAge() {
            if (!this.patientForm) return;
            const calculated = calcAge(this.patientForm.date_of_birth);
            if (calculated !== null) this.patientForm.age = calculated;
        },

        /**
         * Derive date of birth from Egyptian national ID (14 digits).
         * Egyptian National ID structure:
         * - Digit 1: Century code (2 for 1900s, 3 for 2000s)
         * - Digits 2-3: Year (last two digits)
         * - Digits 4-5: Month (01-12)
         * - Digits 6-7: Day (01-31)
         * - Remaining digits: governorate, sequence, etc.
         */
        deriveDobFromEgyptianNid(nationalId) {
            if (!nationalId) return null;
            const id = String(nationalId).replace(/\D/g, '');
            if (id.length !== 14) return null;
            const centuryCode = id[0];
            const yearPart = id.substring(1, 3);
            const monthPart = id.substring(3, 5);
            const dayPart = id.substring(5, 7);
            let century;
            if (centuryCode === '2') {
                century = '19';
            } else if (centuryCode === '3') {
                century = '20';
            } else {
                return null;
            }
            const year = parseInt(century + yearPart, 10);
            const month = parseInt(monthPart, 10);
            const day = parseInt(dayPart, 10);
            if (month < 1 || month > 12 || day < 1 || day > 31) return null;
            const dob = new Date(year, month - 1, day);
            if (dob.getFullYear() !== year || dob.getMonth() !== month - 1 || dob.getDate() !== day) {
                return null;
            }
            const monthStr = String(month).padStart(2, '0');
            const dayStr = String(day).padStart(2, '0');
            return `${year}-${monthStr}-${dayStr}`;
        },

        deriveGovernorateFromEgyptianNid(nationalId) {
            if (!nationalId) return null;
            const id = String(nationalId).replace(/\D/g, '');
            if (id.length !== 14) return null;
            const governorateCode = id.substring(7, 9);
            if (governorateCode === BORN_ABROAD_ID_CODE) return null;
            if (GOVERNORATE_BY_ID_CODE && GOVERNORATE_BY_ID_CODE[governorateCode]) {
                return GOVERNORATE_BY_ID_CODE[governorateCode];
            }
            return null;
        },

        onNationalIdChange() {
            if (!this.patientForm) return;
            const dob = this.deriveDobFromEgyptianNid(this.patientForm.national_id);
            if (dob) {
                this.patientForm.date_of_birth = dob;
                this.refreshAge();
            }
            const governorate = this.deriveGovernorateFromEgyptianNid(this.patientForm.national_id);
            if (governorate && !this.patientForm.governorate) {
                this.patientForm.governorate = governorate;
            }
        },

        onNationalIdInput() {
            this.onNationalIdChange();
        },

        onNationalIdBlur() {
            this.onNationalIdChange();
        },

        // Same rule for the read-only patient profile.
        patientAgeOf(patient) {
            if (!patient) return 'N/A';
            const calculated = calcAge(patient.date_of_birth);
            return calculated !== null ? calculated : (patient.age ?? 'N/A');
        },

        newPatientForm() {
            return {
                name: '',
                national_id: '',
                mobile: '',
                date_of_birth: '',
                age: '',
                marital_status: '',
                children_count: 0,
                governorate: '',
                address: '',
                problem: '',
                solution: '',
                visit_date: '',
                price: '',
                follower: '',
                section: this.defaultSection(),
                source_of_money: '',
            };
        },
        
        // The RLS insert policy requires a writable section on the row; an
        // empty-string section would satisfy neither and Postgres answers with
        // the opaque row-level-security message.
        validatePatientForm() {
            // An expired session is not a missing clinic section. Check the
            // session first so the form says what actually happened.
            if (!this.isLoggedIn || !this.user) {
                return this.t('Your session has expired. Please sign in again.');
            }
            if (!this.writableSectionKeys().length) {
                return this.t('Your account has no section write access. Ask a Super Admin to grant it.');
            }
            if (!this.canWriteSection(this.patientForm?.section)) {
                return this.t('You do not have write access to this section.');
            }
            return null;
        },
        
        async openPatientForm() {
            if (!this.isLoggedIn) { this.currentPage = 'login'; return; }
            if (!this.writableSectionKeys().length) {
                this.showAlert(this.t('Your account has no section write access. Ask a Super Admin to grant it.'), 'danger');
                return;
            }
            this.editingPatient = null;
            this.patientForm = this.newPatientForm();
            this.refreshAge();
            this.patientNotes = [''];
            this.patientAttachments = [];
            this.currentPage = 'patient-form';
        },
        
        async editPatient(patient) {
            if (!this.isLoggedIn) { this.currentPage = 'login'; return; }
            if (!this.canWriteSection(patient?.section)) {
                this.showAlert(this.t('You do not have write access to this section.'), 'danger');
                return;
            }
            this.editingPatient = patient;
            this.patientForm = {
                name: patient.name || '',
                national_id: patient.national_id || '',
                mobile: patient.mobile || '',
                date_of_birth: patient.date_of_birth || '',
                age: patient.age ?? '',
                marital_status: patient.marital_status || '',
                children_count: patient.children_count ?? 0,
                governorate: patient.governorate || '',
                address: patient.address || '',
                problem: patient.problem || '',
                solution: patient.solution || '',
                visit_date: patient.visit_date ? String(patient.visit_date).slice(0, 10) : '',
                price: patient.price ?? '',
                follower: patient.follower || '',
                section: patient.section || this.defaultSection(),
                source_of_money: patient.source_of_money || '',
            };
            this.refreshAge();
            this.patientNotes = (patient.notes && patient.notes.length) ? [...patient.notes] : [''];
            this.patientAttachments = Array.isArray(patient.attachments)
                ? patient.attachments.map((att) => ({ ...att, uploading: false, progress: 100, error: null }))
                : [];
            // Check PDF accessibility for authenticated attachments
            this.checkPatientPdfs();
            this.currentPage = 'patient-form';
        },
        
        async showPatient(patient) {
            if (!this.isLoggedIn) { this.currentPage = 'login'; return; }
            this.selectedPatient = {
                ...patient,
                user_name: patient.registered_by_name || patient.user_name || 'Unknown',
            };
            this.currentPage = 'patient-profile';
            // Check PDF accessibility for authenticated attachments
            this.checkPatientPdfs();
        },

        async checkPatientPdfs() {
            if (!this.selectedPatient?.attachments?.length) return;
            for (const att of this.selectedPatient.attachments) {
                if (!this.attachmentIsImage(att) && att.authenticated) {
                    const result = await this.checkPdfAccessible(att);
                    att._pdfAccessible = result.accessible;
                    att._pdfError = result.error;
                }
            }
        },
        
        addNote() {
            this.patientNotes.push('');
        },
        removeNote(index) {
            this.patientNotes.splice(index, 1);
        },

        
        // ---- Attachments (Cloudinary) --------------------------------------
        
        // One folder per patient so assets stay grouped. An existing patient
        // uses its row id; a new patient has no row yet, so its uploads go to
        // the signed-in user's draft scope. That scope is what the signing
        // function checks, so a typed national id can never target another
        // section's patient folder.
        attachmentFolder() {
            if (this.editingPatient?.id) {
                return `clinic-ehr/patients/${this.editingPatient.id}`;
            }
            const owner = this.user?.id;
            if (!owner) return '';
            const key = (this.patientForm?.national_id || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_') || 'unassigned';
            return `clinic-ehr/drafts/${owner}/${key}`;
        },
        
        async onPatientAttach(event) {
            const epoch = this.sessionEpoch;
            const { isSupportedAttachment, uploadAttachment } = await import('./services/cloudinary.js');
            // The session ended while the module was loading: this upload
            // belongs to the previous shell.
            if (epoch !== this.sessionEpoch) return;
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            
            for (const file of files) {
                if (epoch !== this.sessionEpoch) return;
                if (!isSupportedAttachment(file)) {
                    this.showAlert(this.t('Unsupported file type: :name', { name: file.name }), 'warning');
                    continue;
                }
                
                const entry = {
                    _token: ++this.attachmentSeq,
                    public_id: null,
                    url: null,
                    name: file.name,
                    size: file.size,
                    mime: file.type || '',
                    uploaded_at: null,
                    uploading: true,
                    progress: 0,
                    error: null,
                };
                this.patientAttachments.push(entry);
                // Writes must go through the array so Alpine re-renders, and
                // must find the entry again by its stable token: removing an
                // earlier file while this one uploads shifts the indexes, and
                // removing this file itself means its result must be dropped
                // instead of written into another entry (issue #26).
                const token = entry._token;
                const liveEntry = () => this.patientAttachments.find((att) => att._token === token);
                
                try {
                    const uploaded = await uploadAttachment(file, {
                        folder: this.attachmentFolder(),
                        onProgress: (percent) => {
                            // Ignore progress from a previous session after
                            // logout replaced the attachment array.
                            if (epoch !== this.sessionEpoch) return;
                            const target = liveEntry();
                            if (target) target.progress = percent;
                        },
                    });
                    // Merge upload result and mark complete
                    const target = liveEntry();
                    if (epoch !== this.sessionEpoch || !target) return;
                    Object.assign(target, uploaded, { uploading: false, progress: 100 });
                    // Check PDF accessibility for newly uploaded authenticated PDFs
                    if (!this.attachmentIsImage(target) && target.authenticated) {
                        const result = await this.checkPdfAccessible(target);
                        if (epoch !== this.sessionEpoch) return;
                        target._pdfAccessible = result.accessible;
                        target._pdfError = result.error;
                    }
                } catch (error) {
                    if (epoch !== this.sessionEpoch) return;
                    const target = liveEntry();
                    if (!target) return;
                    target.uploading = false;
                    target.error = error.message || this.t('Upload failed');
                }
            }
        },
        
        removeAttachment(index) {
            // Known limitation: unsigned uploads cannot delete from Cloudinary,
            // so the asset is orphaned if it was already uploaded.
            this.patientAttachments.splice(index, 1);
        },
        
        attachmentIsImage(attachment) {
            return isImageAttachment(attachment);
        },
        
        attachmentUrl(attachment, width = 320) {
            if (!attachment) return '';
            // Authenticated assets cannot use on-the-fly transformations, so
            // the stored signed URL is the only deliverable form.
            if (attachment.authenticated) return attachment.url || '';
            if (!this.attachmentIsImage(attachment) || !attachment.public_id) return attachment.url || '';
            return getImageUrl(attachment.public_id, { width, quality: 80 });
        },
        
        attachmentFullUrl(attachment) {
            if (!attachment) return '';
            if (attachment.authenticated) return attachment.url || '';
            if (!this.attachmentIsImage(attachment) || !attachment.public_id) return attachment.url || '';
            return getImageUrl(attachment.public_id, { width: 1600, quality: 90 });
        },

        /**
         * Checks if a PDF attachment URL is accessible (not blocked by Cloudinary Free tier).
         * Returns a promise that resolves to { accessible: boolean, error?: string }.
         */
        async checkPdfAccessible(attachment) {
            if (!attachment || this.attachmentIsImage(attachment)) {
                return { accessible: true };
            }
            const url = this.attachmentFullUrl(attachment);
            if (!url) return { accessible: false, error: 'No URL' };
            
            try {
                // Use HEAD request to check accessibility without downloading the file
                const response = await fetch(url, { method: 'HEAD', mode: 'cors' });
                if (response.ok) {
                    return { accessible: true };
                }
                if (response.status === 401) {
                    const text = await response.text().catch(() => '');
                    if (text.includes('deny or ACL failure') || text.includes('blocked for delivery')) {
                        return { 
                            accessible: false, 
                            error: this.t('pdf.blocked') 
                        };
                    }
                }
                return { accessible: false, error: `HTTP ${response.status}` };
            } catch (e) {
                // CORS or network error - assume accessible (browser will handle)
                return { accessible: true };
            }
        },

        /**
         * Returns a user-friendly message for Cloudinary PDF block error.
         */
        getPdfBlockedMessage() {
            return this.t('pdf.blocked');
        },
        
        formatFileSize(bytes) {
            if (bytes === null || bytes === undefined) return '';
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        },
        
        async submitPatientForm() {
            const blocked = this.validatePatientForm();
            if (blocked) { this.showAlert(blocked, 'danger'); return; }
            
            if (this.patientAttachments.some((att) => att.uploading)) {
                this.showAlert(this.t('Please wait for the uploads to finish.'), 'warning');
                return;
            }
            if (this.patientAttachments.some((att) => att.error)) {
                this.showAlert(this.t('Remove the files that failed to upload before saving.'), 'danger');
                return;
            }

            const { createPatient, updatePatient } = await import('./services/patients.js');
            // The coercions live in a pure module so they can be tested
            // without mounting the Alpine component.
            const payload = buildPatientPayload(this.patientForm, {
                notes: this.patientNotes,
                attachments: this.patientAttachments,
                editingPatient: this.editingPatient,
                userId: this.user?.id,
            });

            try {
                if (this.editingPatient) {
                    await updatePatient(this.editingPatient.id, payload);
                    this.showAlert(this.t('Patient Updated Successfully'));
                } else {
                    await createPatient(payload);
                    this.showAlert(this.t('Patient Created Successfully'));
                }
                this.currentPage = 'patients';
                await this.loadPatients();
            } catch (error) {
                this.showAlert(this.errorMessage(error), 'danger');
            }
        },
        
        /** A blank user form; also used to clear the modal after a save. */
        emptyUserForm() {
            return {
                name: '',
                email: '',
                password: '',
                is_super_admin: false,
                read_sections: [],
                write_sections: [],
            };
        },

        /** The sections offered in the create/edit permission matrix. */
        userSectionOptions() {
            return this.activeOptions('section');
        },

        /** A Super Admin editing their own account must not lock themselves out. */
        isEditingSelf() {
            return !!this.editingUser && this.editingUser.id === this.user?.id;
        },

        openUserForm() {
            if (!this.isSuperAdmin) return;
            this.editingUser = null;
            this.userForm = this.emptyUserForm();
            this.userFormError = null;
            // Create/edit is a Bootstrap modal over Settings → Users so the
            // table stays visible behind the form.
            this.showUserFormModal();
        },

        editUser(u) {
            if (!this.isSuperAdmin) return;
            this.editingUser = u;
            this.userForm = {
                name: u.name || '',
                email: u.email || '',
                password: '',
                is_super_admin: !!u.is_super_admin,
                read_sections: Array.isArray(u.read_sections) ? [...u.read_sections] : [],
                write_sections: Array.isArray(u.write_sections) ? [...u.write_sections] : [],
            };
            this.userFormError = null;
            this.showUserFormModal();
        },

        showUserFormModal() {
            bootstrapBundle?.Modal?.getOrCreateInstance(document.getElementById('userFormModal'))?.show();
        },

        closeUserForm() {
            bootstrapBundle?.Modal?.getOrCreateInstance(document.getElementById('userFormModal'))?.hide();
            // A fresh form for the next open (openUserForm/editUser set the
            // real values; this just clears the modal's leftovers).
            this.userForm = this.emptyUserForm();
            this.userFormError = null;
        },

        // ---- Permission matrix (create/edit) --------------------------------

        userCanRead(section) {
            return (this.userForm?.read_sections || []).includes(section);
        },

        userCanWrite(section) {
            return (this.userForm?.write_sections || []).includes(section);
        },

        toggleUserRead(section, checked) {
            const read = new Set(this.userForm.read_sections || []);
            const write = new Set(this.userForm.write_sections || []);
            if (checked) {
                read.add(section);
            } else {
                // Read off also clears write: a write grant the user cannot see
                // would be meaningless.
                read.delete(section);
                write.delete(section);
            }
            this.userForm.read_sections = [...read];
            this.userForm.write_sections = [...write];
        },

        toggleUserWrite(section, checked) {
            const write = new Set(this.userForm.write_sections || []);
            const read = new Set(this.userForm.read_sections || []);
            if (checked) {
                // Write implies read.
                write.add(section);
                read.add(section);
            } else {
                write.delete(section);
            }
            this.userForm.read_sections = [...read];
            this.userForm.write_sections = [...write];
        },

        grantAllUserRead() {
            const keys = this.userSectionOptions().map((opt) => opt.key);
            this.userForm.read_sections = keys;
            this.userForm.write_sections = (this.userForm.write_sections || [])
                .filter((key) => keys.includes(key));
        },

        clearUserPermissions() {
            this.userForm.read_sections = [];
            this.userForm.write_sections = [];
        },

        setUserSuperAdmin(checked) {
            this.userForm.is_super_admin = !!checked;
            // A Super Admin reaches every section through the role flag, so
            // stale per-section grants are cleared to keep the form honest if
            // the role is later removed.
            if (checked) this.clearUserPermissions();
        },

        async submitUserForm() {
            if (!this.isSuperAdmin) return;
            this.userFormError = null;

            if (!String(this.userForm.name || '').trim()) {
                this.userFormError = this.t('Full name is required');
                return;
            }
            if (!String(this.userForm.email || '').trim()) {
                this.userFormError = this.t('A valid email address is required');
                return;
            }
            if (!this.editingUser && !this.userForm.password) {
                this.userFormError = this.t('Password is required');
                return;
            }
            if (this.userForm.password && this.userForm.password.length < 6) {
                this.userFormError = this.t('Password must be at least 6 characters');
                return;
            }
            if (!this.userForm.is_super_admin && !this.userForm.read_sections?.length) {
                this.userFormError = this.t('Select at least one section this user can read.');
                return;
            }

            const { createUser, updateUser } = await import('./services/users.js');
            try {
                if (this.editingUser) {
                    await updateUser(this.editingUser.id, this.userForm);
                    this.showAlert(this.t('user updated successfully'));
                } else {
                    await createUser(this.userForm);
                    this.showAlert(this.t('user created successfully'));
                }
                // Close on success only: a failed save stays open with its
                // message so the Super Admin can correct the field.
                this.closeUserForm();
                await this.loadUsers();
            } catch (error) {
                this.userFormError = this.errorMessage(error);
            }
        },

        async removeUser(u) {
            if (!this.isSuperAdmin) return;
            if (u.id === this.user?.id) {
                this.showAlert(this.t('You cannot delete your own account.'), 'warning');
                return;
            }
            if (!confirm(this.t('Are you sure you want to delete this user?'))) return;
            const { deleteUser } = await import('./services/users.js');
            try {
                await deleteUser(u.id);
                this.users = this.users.filter((x) => x.id !== u.id);
                this.showAlert(this.t('user deleted successfully'));
            } catch (error) {
                this.showAlert(this.errorMessage(error), 'danger');
            }
        }
    };
}

window.app = app;

// The wizard mounts as a nested Alpine scope on its own page; this global is
// what the page markup references (mirrors `window.app`).
window.importAgentWizard = importAgentWizard;

document.addEventListener('DOMContentLoaded', () => {
    Alpine.start();
});