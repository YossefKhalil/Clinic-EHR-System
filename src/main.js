import './styles/main.css';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import bootstrapBundle from 'bootstrap/dist/js/bootstrap.bundle.min.js';
import Alpine from 'alpinejs';
import { initI18n, t, setLocale, getLocale } from './services/i18n.js';
import { initSupabase, supabase, getCurrentUser, signIn, signOut } from './services/supabase.js';
import { initCloudinary, getImageUrl, isImageAttachment } from './services/cloudinary.js';
import { getDashboardStats, getRecentPatients } from './services/dashboard.js';
import { getPatients, deletePatient, togglePatientStatus, GOVERNORATES } from './services/patients.js';
import { patientMatchesQuery } from './services/fuzzy.js';
import { getPriceStats } from './services/prices.js';
import { loadOptions as fetchOptions, allOptions, createOption, updateOption, optionLabel as lookupOptionLabel } from './services/options.js';
import { evaluateRow, postProcessPatient } from './services/ai-import.js';

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
        
        aiImportEnabled: true,
            aiSettings: null,
            aiSettingsForm: {
                provider: 'openrouter',
                model: '',
                enabled: false,
                openrouterKey: '',
                cloudflareAccountId: '',
                cloudflareToken: '',
                openaiBaseUrl: '',
                openaiKey: '',
            },
        aiSettingsSaving: false,
        aiSettingsTesting: false,
        aiSettingsTestResult: null,
        // AI import (3 steps: Add data → Review → Done). Nothing at all is
        // written to the database until the Import button is pressed.
        aiStep: 'add',
        aiFiles: [],                          // attachment chips {id, name, size, file}
        aiText: '',
        aiInstructions: '',
        aiShowInstructions: false,
        aiDefaults: { section: '', source_of_money: '', follower: '', visit_date: '' },
        aiDragOver: false,
        aiExtracting: false,
        aiAbortController: null,
        aiProgressLabel: '',
        aiProgressDone: 0,
        aiProgressTotal: 0,
        aiRows: [],                           // review rows (see ai-import.js)
        aiFilter: 'all',
        aiBulkField: 'source_of_money',
        aiBulkValue: '',
        aiImporting: false,
        aiRowSource: null,                    // modal text shown by the info icon
        aiResult: { added: 0, skipped: [] },
        lastImport: null,                     // { batchId, count } — powers Undo
        globalSearchFocused: false,
        globalSearchLoading: false,
        globalSearchResults: [],
        globalSearchSelectedIndex: -1,
        globalSearchDebounce: null,
        globalSearchRequestId: 0,
        
        // Prices
        priceStats: null,
        
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
                this.refreshAiImportEnabled();
                this.refreshOptions();
                if (this.isSuperAdmin) this.loadAiSettings();
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
            if (page !== 'patients') this.closeGlobalSearch();
            this.currentPage = page;
            this.closeMobileNav();
            try {
                if (page === 'dashboard') await this.showDashboard();
                if (page === 'patients') await this.loadPatients();
                if (page === 'prices') await this.showPrices();
                if (page === 'users') await this.loadUsers();
                if (page === 'settings') await this.showSettings();
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
                // Keep the AI review grid's validation in step: a newly added
                // source of money is accepted, a deactivated one is not.
                try {
                    const { setSourceOptions } = await import('./services/ai-import.js');
                    setSourceOptions(this.activeOptions('source').map((opt) => opt.key));
                } catch (error) {
                    console.error('Could not sync AI source options:', error);
                }
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
            await this.refreshOptions();
            this.resetSettingsOptions();
            if (this.isSuperAdmin) await this.loadAiSettings();
        },
        
        // Editable working copies so typing never writes through until Save.
        resetSettingsOptions() {
            const clone = (list) => list.map((opt) => ({ ...opt, _dirty: false, _saving: false }));
            this.settingsOptions = {
                follower: clone(allOptions('follower')),
                section: clone(allOptions('section')),
                source: clone(allOptions('source')),
            };
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
        
        // ---- AI import (3 steps) --------------------------------------------
        
        aiStepIndex() {
            return { add: 0, review: 1, done: 2 }[this.aiStep] ?? 0;
        },
        
        resetAiImport() {
            this.aiStep = 'add';
            this.aiFiles = [];
            this.aiText = '';
            this.aiInstructions = '';
            this.aiShowInstructions = false;
            this.aiDefaults = {
                section: this.aiSectionLocked() ? (this.profile?.section ?? '') : '',
                source_of_money: '', follower: '', visit_date: '',
            };
            this.aiDragOver = false;
            this.aiExtracting = false;
            this.aiProgressLabel = '';
            this.aiProgressDone = 0;
            this.aiProgressTotal = 0;
            this.aiRows = [];
            this.aiFilter = 'all';
            this.aiBulkField = 'source_of_money';
            this.aiBulkValue = '';
            this.aiImporting = false;
            this.aiRowSource = null;
        },
        
        openAiImport() {
            if (!this.aiImportEnabled) {
                this.showAlert(this.t('AI Import is disabled by the administrator.'), 'warning');
                return;
            }
            this.resetAiImport();
            this.currentPage = 'ai-import';
        },
        
        // ---- step 1: add data ----
        
        onAiFilesPicked(event) {
            this.addAiChips(Array.from(event.target.files ?? []));
            event.target.value = '';
        },
        
        onAiDrop(event) {
            this.aiDragOver = false;
            this.addAiChips(Array.from(event.dataTransfer?.files ?? []));
        },
        
        // Paste anywhere on the import page: images become chips, text goes
        // into the details textarea.
        onAiPaste(event) {
            const items = Array.from(event.clipboardData?.items ?? []);
            const images = items
                .filter((item) => item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter(Boolean);
            if (images.length) {
                this.addAiChips(images);
                return;
            }
            const text = event.clipboardData?.getData('text/plain');
            if (text) this.aiText = this.aiText ? this.aiText + '\n' + text : text;
        },
        
        addAiChips(files) {
            if (!files.length) return;
            if (this.aiFiles.length + files.length > 10) {
                this.showAlert(this.t('Up to 10 files per run.'), 'warning');
                files = files.slice(0, Math.max(0, 10 - this.aiFiles.length));
            }
            for (const file of files) {
                if (file.size > 8 * 1024 * 1024) {
                    this.showAlert(this.t('":name" is larger than 8 MB.', { name: file.name }), 'warning');
                    continue;
                }
                this.aiFiles.push({
                    id: `chip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                    name: file.name,
                    size: file.size,
                    file,
                });
            }
        },
        
        aiChipIcon(chip) {
            const name = chip?.name ?? '';
            if (/\.(xlsx|xls|csv)$/i.test(name)) return 'bi-file-earmark-spreadsheet';
            if (/\.pdf$/i.test(name)) return 'bi-file-earmark-pdf';
            if (/\.(docx?|odt)$/i.test(name)) return 'bi-file-earmark-word';
            if (/\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(name)) return 'bi-file-earmark-image';
            return 'bi-file-earmark-text';
        },
        
        formatAiSize(bytes) {
            if (!bytes && bytes !== 0) return '';
            if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
            return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        },
        
        // Section staff with an assigned section are locked into it; admins
        // and users without a section must choose one before saving.
        aiSectionLocked() {
            return !this.isSuperAdmin && Boolean(this.profile?.section);
        },
        
        needSectionChoice() {
            return !this.isSuperAdmin && !this.profile?.section;
        },
        
        aiCanExtract() {
            // Extraction no longer waits on the section choice: the defaults
            // panel lives in the review step, and saving is what needs it.
            return Boolean(this.aiFiles.length || this.aiText.trim());
        },

        // The section is required when saving, not when extracting.
        aiSaveReady() {
            return Boolean(this.aiDefaults.section || this.profile?.section);
        },

        // Fill every row's blank fields from the review-step defaults panel.
        // Anything the AI or the user already put in a cell is kept.
        applyAiDefaultsToRows() {
            const fields = ['section', 'source_of_money', 'follower', 'visit_date'];
            this.aiRows.forEach((row) => {
                if (!row?.data) return;
                fields.forEach((field) => {
                    const fallback = this.aiDefaults[field];
                    if (fallback && !String(row.data[field] ?? '').trim()) {
                        row.data[field] = fallback;
                    }
                });
            });
        },
        
        aiProgressPercent() {
            if (!this.aiProgressTotal) return 5;
            return Math.max(5, Math.round(this.aiProgressDone / this.aiProgressTotal * 100));
        },
        
        cancelAiExtraction() {
            this.aiAbortController?.abort();
        },
        
        // Step 1 → 2. Preprocesses every chip + the pasted text into chunks in
        // the browser, runs up to 3 extraction requests in parallel through
        // the edge function, normalizes what comes back, then checks
        // duplicates before showing the review table.
        async extractPatients() {
            if (!this.aiCanExtract() || this.aiExtracting) return;
            this.aiExtracting = true;
            this.aiProgressDone = 0;
            this.aiProgressTotal = 0;
            this.aiProgressLabel = this.t('Preparing files…');
            try {
                const [{ buildExtractionRequests, runExtractionRequests }, { parsePatientYaml, postProcessPatient }] = await Promise.all([
                    import('./services/ai-import-client.js'),
                    import('./services/ai-import.js'),
                ]);
                
                this.aiAbortController = new AbortController();
                
                const requests = await buildExtractionRequests(
                    this.aiFiles.map((chip) => chip.file),
                    this.aiText,
                    { onNote: (note) => this.showAlert(note, 'warning') }
                );
                
                if (!requests.length) {
                    this.aiProgressLabel = '';
                    return;
                }
                
                this.aiProgressTotal = requests.length;
                
                const results = await runExtractionRequests(requests, {
                    signal: this.aiAbortController.signal,
                    onProgress: ({ done, total, label }) => {
                        this.aiProgressDone = done;
                        this.aiProgressTotal = total;
                        this.aiProgressLabel = label
                            ? this.t('Extracting from :label (part :done of :total)…', { label, done, total })
                            : this.t('Extraction finished.');
                    },
                });
                
                // Parse each chunk's YAML, normalize each patient, and carry
                // the chunk label as the row's source (for the info icon).
                const truncatedChunks = [];
                const parseFailureMessages = [];
                
                for (const result of results) {
                    if (result.error) { parseFailureMessages.push(`${result.label}: ${result.error}`); continue; }
                    const { rows } = parsePatientYaml(result.yaml);
                    if (result.truncated) truncatedChunks.push(result.label);
                    for (const raw of rows) {
                        const row = postProcessPatient(raw, this.aiDefaults, result.label);
                        this.aiRows.push(row);
                    }
                }
                
                // In-batch duplicates: first row with an ID keeps "Ready", the
                // later ones get a blue Duplicate badge.
                this.markInBatchDuplicates();
                // Cross-section duplicates via the SECURITY DEFINER RPC.
                await this.markCrossSectionDuplicates();
                
                if (!this.aiRows.length) {
                    this.aiProgressLabel = '';
                    const detail = parseFailureMessages.length ? '\n' + parseFailureMessages.slice(0, 3).join('\n') : '';
                    this.showAlert(this.t('No patients could be extracted from that input.') + detail, 'warning');
                    if (parseFailureMessages.length) console.error('ai-import chunk errors:', parseFailureMessages);
                    return;
                }
                
                if (truncatedChunks.length) {
                    this.showAlert(this.t('Some parts were cut off by the AI model (token limit) — the last patient in each affected part may be missing. Consider smaller files.'), 'warning');
                }
                
                this.aiStep = 'review';
            } catch (error) {
                if (error?.name === 'AbortError') {
                    this.showAlert(this.t('Extraction cancelled.'), 'warning');
                } else {
                    console.error(error);
                    this.showAlert(error?.message || this.t('Something went wrong.'), 'danger');
                }
            } finally {
                this.aiExtracting = false;
                this.aiAbortController = null;
            }
        },
        
        markInBatchDuplicates() {
            const byId = new Map();
            for (const row of this.aiRows) {
                const nid = String(row.data.national_id ?? '').trim();
                if (!nid) continue;
                if (!byId.has(nid)) { byId.set(nid, row); continue; }
                row.duplicate = {
                    kind: 'batch',
                    message: this.t('National ID appears twice in this import — only the first row can be added.'),
                    fillable: false,
                };
                row.duplicateMode = 'skip';
            }
        },
        
        // Cross-section duplicates: RLS hides other sections' patients, so
        // the client cannot answer this alone. One call with every ID.
        async markCrossSectionDuplicates() {
            const ids = [...new Set(this.aiRows
                .map((row) => String(row.data.national_id ?? '').trim())
                .filter(Boolean))];
            if (!ids.length) return;
            
            let existingIds = new Set();
            try {
                const { data, error } = await supabase()
                    .rpc('existing_national_ids', { ids });
                if (!error && Array.isArray(data)) existingIds = new Set(data);
            } catch (e) {
                // Older schema without the RPC: degrade to a visible-only check.
                console.warn('existing_national_ids unavailable:', e);
            }
            
            // Which duplicates the caller can see (fill-empty fields is only
            // offered when the existing patient is visible under RLS).
            let visible = new Map();
            if (existingIds.size) {
                try {
                    const { data } = await supabase()
                        .from('patients')
                        .select('id, national_id, name, section')
                        .in('national_id', [...existingIds]);
                    (data ?? []).forEach((p) => visible.set(p.national_id, p));
                } catch {}
            }
            
            for (const row of this.aiRows) {
                if (row.duplicate?.kind === 'batch') continue;
                const nid = String(row.data.national_id ?? '').trim();
                if (!nid || !existingIds.has(nid)) continue;
                const seen = visible.get(nid);
                if (seen) {
                    row.duplicate = {
                        kind: 'existing',
                        existingId: seen.id,
                        message: this.t('A patient with this National ID already exists (":name").', { name: seen.name || nid }),
                        fillable: true,
                    };
                } else {
                    row.duplicate = {
                        kind: 'other_section',
                        message: this.t('National ID already exists in another section — you cannot view or edit it here.'),
                        fillable: false,
                    };
                }
                row.duplicateMode = 'skip'; // default for duplicates is Skip
            }
        },
        
        setDuplicateSkip(row) { row.duplicateMode = 'skip'; },
        setDuplicateFill(row) { row.duplicateMode = 'fill'; },
        
        backToAddStep() {
            this.aiStep = 'add';
        },
        
        // ---- step 2: review ----
        
        // Follower keys/labels for the review grid, derived from the editable
        // option list (issue #1) so the AI import follows Settings too.
        get followerOptions() {
            const map = {};
            for (const opt of this.activeOptions('follower')) map[opt.key] = this.optionLabel('follower', opt.key);
            return map;
        },
        
        aiRowEval(row) {
            const followerKeys = new Set(Object.keys(this.followerOptions));
            return evaluateRow(row.data ?? row, row.flags ?? [], followerKeys);
        },
        
        aiRowStatus(row) {
            return this.aiRowEval(row).status;
        },
        
        aiRowErrors(row) {
            return this.aiRowEval(row).errors.map((e) => this.t(e.key, e.params ?? {}));
        },
        
        aiCellWarning(row, field) {
            const list = this.aiRowEval(row).warnings[field] ?? [];
            return list.map((w) => this.t(w.key, w.params ?? {})).join(' | ');
        },
        
        visibleRows() {
            if (this.aiFilter === 'all') return this.aiRows;
            // "Needs attention": errors, checks, or duplicates — anything the
            // importer does not plan to save silently.
            return this.aiRows.filter((row) => this.aiRowStatus(row) !== 'ready' || row.duplicate);
        },
        
        attentionCount() {
            return this.aiRows.filter((row) => this.aiRowStatus(row) !== 'ready' || row.duplicate).length;
        },
        
        importableCount() {
            return this.aiRows.filter((row) => this.aiImportable(row)).length;
        },
        
        aiImportable(row) {
            if (this.aiRowStatus(row) === 'error') return false;
            if (row.duplicate && row.duplicateMode !== 'fill') return false;
            return true;
        },
        
        addReviewRow() {
            this.aiRows.unshift(postProcessPatient({}, {
                section: this.aiDefaults.section || this.profile?.section || '',
                source_of_money: this.aiDefaults.source_of_money || undefined,
                follower: this.aiDefaults.follower || undefined,
                visit_date: this.aiDefaults.visit_date || undefined,
                notes: undefined,
            }, this.t('Added manually')));
        },
        
        toggleSelectAll(checked) {
            this.visibleRows().forEach((row) => { row.selected = checked; });
        },
        
        allVisibleSelected() {
            const rows = this.visibleRows();
            return rows.length > 0 && rows.every((row) => row.selected);
        },
        
        selectedRowCount() {
            return this.aiRows.filter((row) => row.selected).length;
        },
        
        deleteSelectedRows() {
            const count = this.selectedRowCount();
            if (!count) return;
            if (!confirm(this.t('Delete :count row(s)?', { count }))) return;
            this.aiRows = this.aiRows.filter((row) => !row.selected);
        },
        
        applyBulkValue() {
            const field = this.aiBulkField;
            const value = this.aiBulkValue.trim();
            if (!field) return;
            this.aiRows
                .filter((row) => row.selected)
                .forEach((row) => {
                    row.data[field] = field === 'visit_date' ? value : value;
                });
            this.aiBulkValue = '';
        },
        
        showRowSource(row) {
            this.aiRowSource = row.source || this.t('No source text recorded for this row (added manually).');
        },
        
        aiNotesText(row) {
            const notes = Array.isArray(row?.data?.notes) ? row.data.notes : [];
            return notes.join('\n');
        },
        
        // ---- step 3 + saving ----
        
        // Everything on the review table is still just a draft: this is the
        // only place that touches the database.
        async importReviewedRows() {
            if (!this.aiSaveReady()) {
                this.showAlert(this.t('Choose a section before saving'), 'warning');
                return;
            }
            const targets = this.aiRows.filter((row) => this.aiImportable(row));
            if (!targets.length || this.aiImporting) return;
            
            this.aiImporting = true;
            try {
                const { importBatch } = await import('./services/ai-import.js');
                const { batchId, saved, failed } = await importBatch(targets, {
                    userId: this.user.id,
                    section: this.aiDefaults.section || this.profile?.section || null,
                });
                
                // Rows saved (and their fill-updates) leave the table; failed
                // rows stay for another look. Skips become the Done report.
                this.aiRows = this.aiRows.filter((row) => !this.aiImportable(row)
                    || failed.some((f) => f.row === row));
                const skipped = this.aiRows.map((row) => ({
                    name: row.data.name,
                    national_id: row.data.national_id,
                    reason: row.duplicate
                        ? row.duplicate.message
                        : (this.aiRowErrors(row)[0] ?? this.t('Row was not ready for import.')),
                }));
                
                this.lastImport = { batchId, count: saved.length };
                this.aiResult = { added: saved.length, skipped };
                
                if (failed.length) {
                    this.showAlert(this.t(':count row(s) failed to save and stay in the review table.', { count: failed.length }), 'warning');
                }
                
                await this.loadPatients();
                this.aiStep = 'done';
            } catch (error) {
                console.error(error);
                this.showAlert(error?.message || this.t('Something went wrong.'), 'danger');
            } finally {
                this.aiImporting = false;
            }
        },
        
        finishAndViewPatients() {
            this.resetAiImport();
            this.navigate('patients');
        },
        
        canUndoImport() {
            return Boolean(this.lastImport?.batchId && this.lastImport.count > 0);
        },
        
        async undoImport() {
            const { count } = this.lastImport ?? {};
            if (!this.lastImport?.batchId || !count) return;
            const message = `${this.t('Undo this import? This deletes the :count patient(s) that were just imported.', { count })} ${this.t('Edits made since the import will be lost.')}`;
            if (!confirm(message)) return;
            
            try {
                const { undoImportBatch } = await import('./services/ai-import.js');
                await undoImportBatch(this.lastImport.batchId);
                this.showAlert(this.t('Import undone: :count patient(s) deleted.', { count }));
                this.lastImport = null;
                this.resetAiImport();
                this.currentPage = 'patients';
                await this.loadPatients();
            } catch (error) {
                console.error(error);
                this.showAlert(error?.message || this.t('Something went wrong.'), 'danger');
            }
        },
        
        // Skipped rows (errors, duplicates, failures) as a CSV the staff can
        // hand back to whoever prepared the source document.
        downloadSkippedCsv() {
            const rows = [['name', 'national_id', 'reason']];
            this.aiResult.skipped.forEach((skip) => {
                rows.push([csvField(skip.name), csvField(skip.national_id ?? ''), csvField(skip.reason)]);
            });
            const csv = '\ufeff' + rows.map((r) => r.map(csvField).join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `skipped-import-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        },
        
        // Ask the ai-import function whether admins switched the feature on;
        // any signed-in user may ask, and a failure keeps the default (shown)
        // so a flaky network never hides a working feature.
        async refreshAiImportEnabled() {
            try {
                const fnUrl = import.meta.env.VITE_SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/ai-import';
                const token = (await supabase().auth.getSession()).data.session?.access_token;
                if (!token) return;
                const res = await fetch(fnUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ action: 'status' }),
                });
                if (!res.ok) return;
                const data = await res.json().catch(() => ({}));
                if (typeof data.enabled === 'boolean') this.aiImportEnabled = data.enabled;
            } catch (e) {
                console.error('ai import status failed:', e);
            }
        },

        async loadAiSettings() {
            const { getAiSettings } = await import('./services/ai-settings.js');
            try {
                const settings = await getAiSettings();
                this.aiSettings = settings;
                this.aiSettingsForm = {
                    provider: settings.provider || 'openrouter',
                    model: settings.model || '',
                    enabled: !!settings.enabled,
                    openrouterKey: '',
                    cloudflareAccountId: settings.providers?.cloudflare?.accountId || '',
                    cloudflareToken: '',
                    openaiBaseUrl: settings.providers?.openai?.baseUrl || '',
                    openaiKey: '',
                };
            } catch (error) {
                console.error('load ai settings failed:', error);
            }
        },

        async saveAiSettings() {
            if (this.aiSettingsSaving) return;
            this.aiSettingsSaving = true;
            this.aiSettingsTestResult = null;
            const { saveAiSettings } = await import('./services/ai-settings.js');
            try {
                const settings = await saveAiSettings({
                    provider: this.aiSettingsForm.provider,
                    model: this.aiSettingsForm.model,
                    enabled: !!this.aiSettingsForm.enabled,
                    openrouterKey: this.aiSettingsForm.openrouterKey.trim(),
                    cloudflareAccountId: this.aiSettingsForm.cloudflareAccountId.trim(),
                    cloudflareToken: this.aiSettingsForm.cloudflareToken.trim(),
                    openaiBaseUrl: this.aiSettingsForm.openaiBaseUrl.trim(),
                    openaiKey: this.aiSettingsForm.openaiKey.trim(),
                });
                this.aiSettings = settings;
                this.aiImportEnabled = !!settings.enabled;
                this.aiSettingsForm.openrouterKey = '';
                this.aiSettingsForm.cloudflareToken = '';
                this.aiSettingsForm.openaiKey = '';
                this.aiSettingsForm.cloudflareAccountId = settings.providers?.cloudflare?.accountId || '';
                this.aiSettingsForm.openaiBaseUrl = settings.providers?.openai?.baseUrl || '';
                this.aiSettingsForm.enabled = !!settings.enabled;
                this.showAlert(this.t('AI settings saved.'), 'success');
            } catch (error) {
                this.showAlert(error.message || 'Error saving AI settings', 'danger');
            } finally {
                this.aiSettingsSaving = false;
            }
        },

        async testAiSettings() {
            if (this.aiSettingsTesting) return;
            this.aiSettingsTesting = true;
            this.aiSettingsTestResult = null;
            const { testAiSettings } = await import('./services/ai-settings.js');
            try {
                await testAiSettings();
                this.aiSettingsTestResult = { ok: true, message: this.t('Connection OK — the provider answered.') };
            } catch (error) {
                this.aiSettingsTestResult = { ok: false, message: error.message || 'Connection failed' };
            } finally {
                this.aiSettingsTesting = false;
            }
        },

        async clearAiSettings() {
            if (!confirm(this.t('Remove the stored credentials? AI Import will be disabled until new ones are saved.'))) return;
            const { clearAiSettings } = await import('./services/ai-settings.js');
            try {
                const settings = await clearAiSettings();
                this.aiSettings = settings;
                this.aiImportEnabled = !!settings.enabled;
                this.aiSettingsForm.provider = settings.provider || 'openrouter';
                this.aiSettingsForm.model = settings.model || '';
                this.aiSettingsForm.enabled = !!settings.enabled;
                this.aiSettingsForm.openrouterKey = '';
                this.aiSettingsForm.cloudflareAccountId = '';
                this.aiSettingsForm.cloudflareToken = '';
                this.aiSettingsForm.openaiBaseUrl = '';
                this.aiSettingsForm.openaiKey = '';
                this.showAlert(this.t('Stored credentials removed.'), 'success');
            } catch (error) {
                this.showAlert(error.message || 'Error removing the credentials', 'danger');
            }
        },

        // Keep the model field sensible when the provider selection changes:
        // swap in the provider's default when the current value belongs to a
        // different provider family (or is empty). Takes the event value so
        // it cannot race x-model's own update.
        onAiProviderChange(selected) {
            const provider = selected || this.aiSettingsForm.provider;
            const defaults = {
                openrouter: 'google/gemini-2.5-flash-lite',
                cloudflare: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
                openai: '',
            };
            const current = (this.aiSettingsForm.model || '').trim();
            const looksForeign = (provider === 'cloudflare' && current && !current.startsWith('@cf/'))
                || (provider === 'openai' && (current.startsWith('@cf/') || current.startsWith('google/')))
                || (provider === 'openrouter' && current.startsWith('@cf/'));
            if (!current || looksForeign) this.aiSettingsForm.model = defaults[provider] || '';
        },

        get aiProviderLabel() {
            const provider = this.aiSettings?.provider || 'openrouter';
            return {
                openrouter: 'OpenRouter',
                cloudflare: 'Cloudflare Workers AI',
                openai: 'OpenAI-compatible',
            }[provider] || provider;
        },
        
        formatMoney(value) {
            if (value === null || value === undefined || value === '') return '0.00';
            return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },
        formatDate(dateStr) {
            if (!dateStr) return '—';
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

// CSV field quoting for the skipped-rows download (local files may contain
// Arabic commas or quotes, so always quote).
function csvField(value) {
    const text = String(value ?? '').replace(/"/g, '""');
    return `"${text}"`;
}

window.app = app;

document.addEventListener('DOMContentLoaded', () => {
    Alpine.start();
});