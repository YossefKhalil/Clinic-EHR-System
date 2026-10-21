import './styles/main.css';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import bootstrapBundle from 'bootstrap/dist/js/bootstrap.bundle.min.js';
import Alpine from 'alpinejs';
import { initI18n, t, setLocale, getLocale } from './services/i18n.js';
import { initSupabase, supabase, getCurrentUser, signIn, signOut } from './services/supabase.js';
import { loadImportEnabled, clearImportFlagCache } from './services/import-flag.js';
import { loadAiSettings as loadAiSettingsApi, saveAiSettings as saveAiSettingsApi, testAiProvider as testAiProviderApi, loadImportLimits as loadImportLimitsApi, saveImportLimits as saveImportLimitsApi } from './services/ai-settings.js';
import { initCloudinary, getImageUrl, isImageAttachment } from './services/cloudinary.js';
import { getDashboardStats, getRecentPatients } from './services/dashboard.js';
import { getPatients, deletePatient, togglePatientStatus, GOVERNORATES } from './services/patients.js';
import { emptyPatientFilters, activeFilterKeys } from './services/patient-filters.js';
import { patientMatchesQuery } from './services/fuzzy.js';
import { getPriceStats } from './services/prices.js';
import { loadOptions as fetchOptions, allOptions, createOption, updateOption, countOptionUsage, deleteOption, optionLabel as lookupOptionLabel } from './services/options.js';
import { importAgentWizard, importAgentEnter } from './features/import-agent/ui.js';

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

// Empty form inputs must be sent as null, not '' — Postgres rejects '' for numeric/int columns.
function toNullableNumber(value) {
    return value === '' || value === null || value === undefined ? null : Number(value);
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

// Options added on the Settings page (issue #1) have no bespoke colors/icons,
// so they get a stable one derived from their key. The four historical keys
// keep exactly the look they had before the lists became editable.
const KNOWN_OPTION_COLORS = { agamy: 'success', dekhila: 'info', charity: 'warning', country: 'danger' };
const KNOWN_OPTION_ICONS = { agamy: 'bi-pin-map-fill', dekhila: 'bi-geo-alt-fill', charity: 'bi-heart-fill', country: 'bi-flag-fill' };
const OPTION_PALETTE = ['primary', 'success', 'info', 'warning', 'danger', 'secondary'];

function colorForOption(key) {
    const name = String(key || '');
    if (KNOWN_OPTION_COLORS[name]) return KNOWN_OPTION_COLORS[name];
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997;
    return OPTION_PALETTE[hash % OPTION_PALETTE.length];
}

function iconForOption(kind, key) {
    const name = String(key || '');
    if (KNOWN_OPTION_ICONS[name]) return KNOWN_OPTION_ICONS[name];
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
        localeLabel: 'العربية',
        // `?mock=review` preview route: renders the import review screen with
        // mock data, without a session. Never touches real data.
        mockPreview: false,
        
        loginForm: { email: '', password: '' },
        loginError: null,
        loginLoading: false,
        
        currentDate: new Date().toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
        
        // Dashboard
            stats: { total: 0, completed: 0, pending: 0, sections: {}, sources: {} },
        recentPatients: [],
        
        // Patients
        patients: [],
        patientsLoading: false,
        patientFilters: emptyPatientFilters(),
        
        // Filters toolbar/panel (issue #13): `filterDraft` is the staged copy
        // shown while the panel is open; it is applied to `patientFilters`
        // (the single source of truth for the table and the export) only on
        // Apply, so closing the panel without Apply discards the changes.
        showFilters: false,
        filterDraft: emptyPatientFilters(),
        
        // Navbar search
        globalSearch: '',
        exporting: false,
        
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
        
        // Governorates & editable options
        governorates: GOVERNORATES,
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
        
        // User form
        editingUser: null,
        userForm: null,
        
        // Alerts
        alertMessage: null,
        alertType: 'success',
        alertTimer: null,
        
        async init() {
            try {
                // Every page's inputs are x-model-bound, so the form objects must
                // hold a value before Alpine walks the tree. Left as `null`, each
                // input logs a TypeError on load (23 of them) before any form is
                // opened, and the bindings only recover once the form is opened.
                this.patientForm = this.newPatientForm();
                this.userForm = { name: '', email: '', password: '', is_admin: false, section: '' };

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
                };
                
                this.localeLabel = t('locale_label');

                // Visual preview of the import review screen: `?mock=review`.
                if (new URLSearchParams(window.location.search).get('mock') === 'review') {
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
            this.isSuperAdmin = !!this.profile?.is_admin;

            if (this.isLoggedIn) {
                // Fire-and-forget: failures must never block or break auth.
                this.refreshOptions();
                this.refreshImportState();
            } else {
                this.importEnabled = true;
                this.importResumable = null;
            }
        },

        /**
         * `?mock=review`: render the import review screen with mock data so
         * the UI can be compared against the mockup without a session or a
         * real extraction. It never reads or writes real data.
         */
        enterMockPreview() {
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
            const enabled = await loadImportEnabled();
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
            try {
                const { listOpenJobs } = await import('./features/import-agent/api.js');
                this.importOpenJobs = await listOpenJobs();
                this.importResumable = this.importOpenJobs[0] ?? null;
            } catch {
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
        // table: an admin row sees and touches every clinic's data, a section
        // staff row only their own clinic's, and neither means a plain viewer
        // with no granted scope (reads permitted by "Users can view own
        // profile" alone). Shown under the name on the dashboard.
        roleLabel() {
            if (this.isSuperAdmin) return this.t('Super Admin');
            if (this.profile?.section) return this.t('Section') + ': ' + this.optionLabel('section', this.profile.section);
            return this.t('No role assigned');
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
                || /invalid login credentials|invalid credentials/i.test(message);

            return rejected ? this.t('Invalid email or password') : this.t('Login failed. Please try again.');
        },
        
        async handleLogin() {
            this.loginLoading = true;
            this.loginError = null;
            
            try {
                await signIn(this.loginForm.email, this.loginForm.password);
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
            this.loginForm = { email: '', password: '' };
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
            await signOut();
            this.currentPage = 'login';
            this.isLoggedIn = false;
            this.user = null;
            this.profile = null;
            this.isSuperAdmin = false;
            this.importEnabled = true;
            this.importResumable = null;
        },
        
        // Mobile menu: close the collapsed panel after a navigation click so
        // the page underneath is not left covered by an open menu.
        closeMobileNav() {
            const nav = document.getElementById('navbarNav');
            if (!nav || !nav.classList.contains('show')) return;
            bootstrapBundle?.Collapse?.getOrCreateInstance(nav).hide();
        },

        async navigate(page) {
            // Settings is super-admin-only: no nav entry is rendered for other
            // roles and this guard keeps a stale page value from reaching it.
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
        },
        
        async showDashboard() {
            if (!this.isLoggedIn) return;
            const section = this.profile?.section || null;
            // One navigation pass: stats, recent patients and the financial
            // summary load in parallel (#15), so the dashboard never makes a
            // duplicate prices request. Stats/table failures keep the old
            // behavior (bubble up to the caller); a financial-summary failure
            // is contained inside its own card (warning + retry).
            const [_summary, stats, recent] = await Promise.allSettled([
                this.isSuperAdmin ? this.loadPriceStats() : Promise.resolve(null),
                getDashboardStats(this.isSuperAdmin, section),
                getRecentPatients(this.isSuperAdmin, section),
            ]);
            if (stats.status === 'fulfilled') this.stats = stats.value;
            if (recent.status === 'fulfilled') this.recentPatients = recent.value;
            if (stats.status === 'rejected') throw stats.reason;
            if (recent.status === 'rejected') throw recent.reason;
        },

        // The financial summary never throws: a failure is shown inside the
        // card with a retry action while the rest of the dashboard stays up.
        // Super-admin-only, matching the nav entry of the page it replaced.
        async loadPriceStats() {
            if (!this.isLoggedIn || !this.isSuperAdmin) return;
            try {
                this.priceStats = await getPriceStats(this.isSuperAdmin, this.profile?.section);
                this.priceStatsError = null;
            } catch (error) {
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
            try {
                await fetchOptions();
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
            const entries = this.optionStatEntries('section', this.stats?.sections);
            // Section staff only ever see their own section's numbers on the
            // dashboard, so show just that entry for them.
            if (!this.isSuperAdmin && this.profile?.section) {
                return entries.filter((entry) => entry.key === this.profile.section);
            }
            return entries;
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

        applyAiSettings(data) {            const firstLoad = this.aiSettings === null;
            this.aiSettings = data;
            this.aiSettingsForm.enabled = data.enabled === true;
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

        aiSavePayload() {
            const credentials = this.aiSettingsForm.credentials;
            const chain = this.aiSettingsForm.chain
                .filter((row) => row.provider || String(row.model ?? '').trim())
                .map((row) => ({ provider: row.provider, model: String(row.model ?? '').trim() }));
            return {
                enabled: this.aiSettingsForm.enabled,
                chain,
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

        aiDiscardChanges() {
            if (!this.aiSettings) {
                this.loadAiSettings();
                return;
            }
            this.applyAiSettings(this.aiSettings);
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
                this.showAlert(this.t('Could not save the option.') + ' ' + (error.message || ''), 'danger');
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
                this.showAlert(this.t('Could not save the option.') + ' ' + (error.message || ''), 'danger');
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
                this.showAlert(this.t('Could not remove the option.') + ' ' + (error.message || ''), 'danger');
            } finally {
                row._removing = false;
            }
        },
        
        async loadUsers() {
            // The Users tab only exists inside Settings, which no non-admin
            // can open; this also keeps stale state from loading the list.
            if (!this.isSuperAdmin) return;
            this.usersError = null;
            this.usersLoading = true;
            try {
                const { getUsers } = await import('./services/users.js');
                this.users = await getUsers();
            } catch (error) {
                console.error('User list load failed:', error);
                // The message lands in the tab with a retry action instead of
                // leaving a blank table.
                this.usersError = error.message || this.t('Could not load the user list.');
            } finally {
                this.usersLoading = false;
            }
        },
        
        async loadPatients() {
            this.patientsLoading = true;
            try {
                const noEmpty = {};
                Object.entries(this.patientFilters).forEach(([k, v]) => {
                    if (v !== '' && v !== null && v !== undefined) noEmpty[k] = v;
                });
                this.patients = await getPatients(noEmpty, this.isSuperAdmin, this.profile?.section);
            } finally {
                this.patientsLoading = false;
            }
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
        
        async handleFilter() {
            // Stays for the panel form's submit path; same behavior as the old
            // inline form's submit.
            await this.loadPatients();
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
                        { search: query, filter_by: 'all' },
                        this.isSuperAdmin, this.profile?.section
                    );
                    // Ignore stale responses: only the latest request may
                    // touch the dropdown.
                    if (requestId !== this.globalSearchRequestId) return;
                    this.globalSearchResults = results.slice(0, 5);
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
                .filter((patient) => patientMatchesQuery(patient, query, (key) => lookupOptionLabel('follower', key)))
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
            try {
                await togglePatientStatus(patient.id, !patient.is_completed);
                patient.is_completed = !patient.is_completed;
            } catch (error) {
                console.error(error);
                this.showAlert(this.t('Could not update the patient status. Please try again.'), 'danger');
            }
        },
        
        async removePatient(patient) {
            if (!confirm(this.t('Are you sure you want to delete this patient?'))) return;
            try {
                await deletePatient(patient.id);
                this.patients = this.patients.filter(p => p.id !== patient.id);
            } catch (error) {
                console.error(error);
                this.showAlert(this.t('Could not delete the patient. Please try again.'), 'danger');
            }
        },
        
        // Export every row the current viewer is allowed to see (same RLS
        // scope as the on-screen table; active filters are honored too).
        async exportPatients() {
            if (this.exporting) return;
            this.exporting = true;
            try {
                const { exportPatientsToExcel } = await import('./services/export.js');
                const noEmpty = {};
                Object.entries(this.patientFilters).forEach(([k, v]) => {
                    if (v !== '' && v !== null && v !== undefined) noEmpty[k] = v;
                });
                const filename = await exportPatientsToExcel(noEmpty, this.isSuperAdmin, this.profile?.section);
                this.showAlert(this.t('Export ready:') + ' ' + filename);
            } catch (error) {
                this.showAlert(error.message || 'Export failed', 'danger');
            } finally {
                this.exporting = false;
            }
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
        
        showAlert(message, type = 'success') {
            this.alertMessage = message;
            this.alertType = type;
            // A newer alert must not be cleared early by the previous timer.
            clearTimeout(this.alertTimer);
            this.alertTimer = setTimeout(() => {
                this.alertMessage = null;
            }, 4000);
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
                section: this.profile?.section || '',
                source_of_money: '',
            };
        },
        
        // The RLS insert policy requires either an admin row or a matching
        // section; an empty-string section would satisfy neither and Postgres
        // answers with the opaque row-level-security message.
        validatePatientForm() {
            if (this.isSuperAdmin || this.profile?.section) return null;
            return this.t('Your account has no clinic section assigned. Ask a Super Admin to set your section or grant you administrator access.');
        },
        
        async openPatientForm() {
            this.editingPatient = null;
            this.patientForm = this.newPatientForm();
            this.refreshAge();
            this.patientNotes = [''];
            this.patientAttachments = [];
            this.currentPage = 'patient-form';
        },
        
        async editPatient(patient) {
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
                section: patient.section || this.profile?.section || '',
                source_of_money: patient.source_of_money || '',
            };
            this.refreshAge();
            this.patientNotes = (patient.notes && patient.notes.length) ? [...patient.notes] : [''];
            this.patientAttachments = Array.isArray(patient.attachments)
                ? patient.attachments.map((att) => ({ ...att, uploading: false, progress: 100, error: null }))
                : [];
            this.currentPage = 'patient-form';
        },
        
        async showPatient(patient) {
            this.selectedPatient = {
                ...patient,
                user_name: patient.registered_by_name || patient.user_name || 'Unknown',
            };
            this.currentPage = 'patient-profile';
        },
        
        addNote() {
            this.patientNotes.push('');
        },
        removeNote(index) {
            this.patientNotes.splice(index, 1);
        },

        
        // ---- Attachments (Cloudinary) --------------------------------------
        
        // One folder per patient so assets stay grouped: the patient row id
        // when editing an existing patient, otherwise the typed national id,
        // with a fallback for files attached before the form is filled in.
        attachmentFolder() {
            const key = this.editingPatient?.id || (this.patientForm?.national_id || '').trim() || 'unassigned';
            return `clinic-ehr/patients/${key}`;
        },
        
        async onPatientAttach(event) {
            const { isSupportedAttachment, uploadAttachment } = await import('./services/cloudinary.js');
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            
            for (const file of files) {
                if (!isSupportedAttachment(file)) {
                    this.showAlert(this.t('Unsupported file type: :name', { name: file.name }), 'warning');
                    continue;
                }
                
                const entry = {
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
                
                try {
                    const uploaded = await uploadAttachment(file, {
                        folder: this.attachmentFolder(),
                        onProgress: (percent) => { entry.progress = percent; },
                    });
                    Object.assign(entry, uploaded, { uploading: false, progress: 100 });
                } catch (error) {
                    entry.uploading = false;
                    entry.error = error.message || this.t('Upload failed');
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
            if (!this.attachmentIsImage(attachment) || !attachment.public_id) return attachment.url || '';
            return getImageUrl(attachment.public_id, { width, quality: 80 });
        },
        
        attachmentFullUrl(attachment) {
            if (!attachment) return '';
            if (!this.attachmentIsImage(attachment) || !attachment.public_id) return attachment.url || '';
            return getImageUrl(attachment.public_id, { width: 1600, quality: 90 });
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
            // Enum columns have CHECK constraints listing their allowed
            // values, so '' is rejected ("violates check constraint").
            // Send a real NULL for "not chosen" instead.
            const payload = {
                ...this.patientForm,
                section: this.patientForm.section || null,
                source_of_money: this.patientForm.source_of_money || null,
                marital_status: this.patientForm.marital_status || null,
                age: toNullableNumber(this.patientForm.age),
                price: toNullableNumber(this.patientForm.price),
                // Postgres date columns reject '' outright ("invalid input
                // syntax for type date"), so empty date fields go as null.
                date_of_birth: this.patientForm.date_of_birth ? String(this.patientForm.date_of_birth).slice(0, 10) : null,
                visit_date: this.patientForm.visit_date ? String(this.patientForm.visit_date).slice(0, 10) : null,
                notes: this.patientNotes.map(n => n.trim()).filter(Boolean),
                is_completed: this.editingPatient?.is_completed ?? false,
                attachments: this.patientAttachments.map(({ public_id, url, name, size, mime, uploaded_at }) => ({
                    public_id, url, name, size, mime, uploaded_at,
                })),
            };
            if (!this.editingPatient) {
                payload.user_id = this.user.id;
            }

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
                this.showAlert(error.message || 'Error saving patient', 'danger');
            }
        },
        
        openUserForm() {
            this.editingUser = null;
            this.userForm = { name: '', email: '', password: '', is_admin: false, section: '' };
            // Create/edit is a Bootstrap modal over Settings → Users (#16) so
            // the table stays visible behind the form.
            this.showUserFormModal();
        },
        
        editUser(u) {
            this.editingUser = u;
            this.userForm = { name: u.name || '', email: u.email || '', password: '', is_admin: !!u.is_admin, section: u.section || '' };
            this.showUserFormModal();
        },
        
        showUserFormModal() {
            bootstrapBundle?.Modal?.getOrCreateInstance(document.getElementById('userFormModal'))?.show();
        },
        
        closeUserForm() {
            bootstrapBundle?.Modal?.getOrCreateInstance(document.getElementById('userFormModal'))?.hide();
            // A fresh form for the next open (openUserForm/editUser set the
            // real values; this just clears the modal's leftovers).
            this.userForm = { name: '', email: '', password: '', is_admin: false, section: '' };
        },
        
        async submitUserForm() {
            const { createUser, updateUser } = await import('./services/users.js');
            try {
                if (this.editingUser) {
                    await updateUser(this.editingUser.id, this.userForm);
                    this.showAlert(this.t('user updated successfully'));
                } else {
                    await createUser(this.userForm);
                    this.showAlert(this.t('user created successfully'));
                }
                // The modal closes on success only, so a failed save stays open
                // with its alert; the admin remains on Settings → Users.
                this.closeUserForm();
                await this.loadUsers();
            } catch (error) {
                this.showAlert(error.message || 'Error saving user', 'danger');
            }
        },
        
        async removeUser(u) {
            if (!confirm(this.t('Are you sure you want to delete this user?'))) return;
            const { deleteUser } = await import('./services/users.js');
            try {
                await deleteUser(u.id);
                this.users = this.users.filter(x => x.id !== u.id);
                this.showAlert(this.t('user deleted successfully'));
            } catch (error) {
                this.showAlert(error.message || 'Error deleting user', 'danger');
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