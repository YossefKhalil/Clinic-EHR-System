import './styles/main.css';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import bootstrapBundle from 'bootstrap/dist/js/bootstrap.bundle.min.js';
import Alpine from 'alpinejs';
import { initI18n, t, setLocale, getLocale } from './services/i18n.js';
import { initSupabase, supabase, getCurrentUser, signIn, signOut } from './services/supabase.js';
import { loadImportEnabled, clearImportFlagCache } from './services/import-flag.js';
import { loadAiSettings as loadAiSettingsApi, saveAiSettings as saveAiSettingsApi, testAiProvider as testAiProviderApi } from './services/ai-settings.js';
import { initCloudinary, getImageUrl, isImageAttachment } from './services/cloudinary.js';
import { getDashboardStats, getRecentPatients } from './services/dashboard.js';
import { getPatients, deletePatient, togglePatientStatus, GOVERNORATES } from './services/patients.js';
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
        patientFilters: { search: '', filter_by: 'all', section: '', source_of_money: '', follower: '', is_completed: '', date_from: '', date_to: '' },
        
        // Navbar search
        globalSearch: '',
        exporting: false,
        
        globalSearchFocused: false,
        globalSearchLoading: false,
        globalSearchResults: [],
        globalSearchSelectedIndex: -1,
        globalSearchDebounce: null,
        globalSearchRequestId: 0,
        
        // Prices
        priceStats: null,

        // AI import entry: the ai_settings flag (fail open) and the job the
        // "Continue import" dropdown item can resume.
        importEnabled: true,
        importResumable: null,
        
        // Users
        users: [],
        
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
        aiSettingsTestResults: { openrouter: null, cloudflare: null, openai: null },
        aiSettingsMessage: null,
        aiSettingsInvalid: {},
        aiSettingsRowSeq: 0,
        aiSettingsMaxModels: 8,
        aiProviderOptions: [
            { id: 'openrouter', labelKey: 'aiSettings.provider.openrouter' },
            { id: 'cloudflare', labelKey: 'aiSettings.provider.cloudflare' },
            { id: 'openai', labelKey: 'aiSettings.provider.openai' },
        ],
        aiSettingsForm: {
            enabled: false,
            chain: [],
            credentials: {
                openrouter: { apiKey: '', clearKey: false },
                cloudflare: { accountId: '', apiToken: '', clearToken: false },
                openai: { baseUrl: '', apiKey: '', clearKey: false },
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
                
                window.localeChanged = () => {
                    this.localeLabel = t('locale_label');
                };
                
                this.localeLabel = t('locale_label');
                
                if (this.isLoggedIn) {
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

        /** The "Continue import" item appears only for an unfinished job. */
        async refreshImportResume() {
            if (!this.isLoggedIn || !this.importEnabled) {
                this.importResumable = null;
                return;
            }
            try {
                const { latestResumableJob } = await import('./features/import-agent/api.js');
                this.importResumable = await latestResumableJob();
            } catch {
                this.importResumable = null;
            }
        },

        async continueImport() {
            const job = this.importResumable;
            if (!job) return;
            await this.navigate('import');
            const wizard = window.__iaWizard;
            if (wizard) {
                wizard.resumable = job;
                await wizard.resume();
            }
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
            if (page !== 'patients') this.closeGlobalSearch();
            this.currentPage = page;
            this.closeMobileNav();
            try {
                if (page === 'dashboard') await this.showDashboard();
                if (page === 'patients') {
                    await this.loadPatients();
                    this.refreshImportResume();
                }
                if (page === 'prices') await this.showPrices();
                if (page === 'users') await this.loadUsers();
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
            this.stats = await getDashboardStats(this.isSuperAdmin, section);
            this.recentPatients = await getRecentPatients(this.isSuperAdmin, section);
        },
        
        async showPrices() {
            if (!this.isLoggedIn) return;
            this.priceStats = await getPriceStats(this.isSuperAdmin, this.profile?.section);
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
            }
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

        applyAiSettings(data) {
            const firstLoad = this.aiSettings === null;
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
            };
            if (firstLoad) {
                const primary = this.aiSettingsForm.chain.find((row) => row.provider);
                if (primary?.provider) this.aiSettingsProvider = primary.provider;
            }
            this.aiSettingsTestResults = { openrouter: null, cloudflare: null, openai: null };
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
            const { getUsers } = await import('./services/users.js');
            this.users = await getUsers();
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
        
        async handleFilter() {
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
            this.patientFilters = {
                search: this.globalSearch,
                filter_by: 'all',
                section: '', source_of_money: '', follower: '',
                is_completed: '', date_from: '', date_to: '',
            };
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
            this.patientFilters = { search: '', filter_by: 'all', section: '', source_of_money: '', follower: '', is_completed: '', date_from: '', date_to: '' };
            await this.loadPatients();
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
            this.currentPage = 'user-form';
        },
        
        editUser(u) {
            this.editingUser = u;
            this.userForm = { name: u.name, email: u.email, password: '', is_admin: !!u.is_admin, section: u.section || '' };
            this.currentPage = 'user-form';
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
                this.currentPage = 'users';
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