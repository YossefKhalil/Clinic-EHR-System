import './styles/main.css';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import Alpine from 'alpinejs';
import { initI18n, t, setLocale, getLocale } from './services/i18n.js';
import { initSupabase, supabase, getCurrentUser, signIn, signOut } from './services/supabase.js';
import { initCloudinary } from './services/cloudinary.js';
import { getDashboardStats, getRecentPatients } from './services/dashboard.js';
import { getPatients, deletePatient, togglePatientStatus, FOLLOWERS, GOVERNORATES } from './services/patients.js';
import { patientMatchesQuery } from './services/fuzzy.js';
import { getPriceStats, SECTION_COLORS, SECTION_ICONS, SOURCE_COLORS, SOURCE_ICONS } from './services/prices.js';

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
        stats: { total: 0, completed: 0, pending: 0, agamy: 0, dekhila: 0, charity: 0, country: 0 },
        recentPatients: [],
        
        // Patients
        patients: [],
        patientsLoading: false,
        patientFilters: { search: '', filter_by: 'all', section: '', source_of_money: '', follower: '', is_completed: '', date_from: '', date_to: '' },
        
        // Navbar search
        globalSearch: '',
        exporting: false,
        
        // AI bulk import
        aiPrompt: '',
        aiAttachments: [],
        aiMessages: [],
        aiBusy: false,
        aiSaving: false,
        aiDraftRows: [],
        aiImportEnabled: true,
        aiSettings: null,
        aiSettingsForm: { key: '', model: '', enabled: false },
        aiSettingsSaving: false,
        aiSettingsTesting: false,
        aiSettingsTestResult: null,
        globalSearchFocused: false,
        globalSearchLoading: false,
        globalSearchResults: [],
        globalSearchSelectedIndex: -1,
        globalSearchDebounce: null,
        globalSearchAbort: null,
        
        // Prices
        priceStats: null,
        sectionColors: SECTION_COLORS,
        sectionIcons: SECTION_ICONS,
        sourceColors: SOURCE_COLORS,
        sourceIcons: SOURCE_ICONS,
        
        // Users
        users: [],
        
        // Governorates & Followers
        governorates: GOVERNORATES,
        followerOptions: FOLLOWERS,
        
        // Patient form
        editingPatient: null,
        patientForm: null,
        selectedPatient: null,
        patientNotes: [''],
        
        // User form
        editingUser: null,
        userForm: null,
        
        // Alerts
        alertMessage: null,
        alertType: 'success',
        
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
            if (this.profile?.section) return this.t('Section') + ': ' + this.t(this.profile.section === 'agamy' ? 'Agamy' : 'Dekhila');
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
        
        async navigate(page) {
            if (page !== 'patients') this.closeGlobalSearch();
            this.currentPage = page;
            try {
                if (page === 'dashboard') await this.showDashboard();
                if (page === 'patients') await this.loadPatients();
                if (page === 'prices') await this.showPrices();
                if (page === 'users') {
                    await this.loadUsers();
                    if (this.isSuperAdmin) await this.loadAiSettings();
                }
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
            this.stats = await getDashboardStats(this.user.id, this.isSuperAdmin, section);
            this.recentPatients = await getRecentPatients(this.user.id, this.isSuperAdmin, section);
        },
        
        async showPrices() {
            if (!this.isLoggedIn) return;
            this.priceStats = await getPriceStats(this.isSuperAdmin, this.profile?.section);
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
                this.globalSearchLoading = true;
                try {
                    const results = await getPatients(
                        { search: query, filter_by: 'all' },
                        this.isSuperAdmin, this.profile?.section
                    );
                    this.globalSearchResults = results.slice(0, 5);
                    this.globalSearchSelectedIndex = -1;
                } catch (error) {
                    console.error('Global search failed:', error);
                    this.globalSearchResults = [];
                } finally {
                    this.globalSearchLoading = false;
                }
            }, 250);
        },
        
        // Instant local filtering while the request is in flight, so the
        // dropdown feels immediate even on slow connections.
        blurredGlobalResults() {
            const query = (this.globalSearch || '').trim();
            if (!query) return [];
            return this.patients.slice(0, 50)
                .filter((patient) => patientMatchesQuery(patient, query, (key) => FOLLOWERS[key] || key))
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
            if (found) { await this.showPatient(found); }
        },
        
        closeGlobalSearch({ keepQuery = false, clearFocus = false } = {}) {
            clearTimeout(this.globalSearchDebounce);
            if (!keepQuery) this.globalSearchResults = [];
            this.globalSearchSelectedIndex = -1;
            if (clearFocus) this.globalSearchFocused = false;
        },
        
        // On small screens the navbar collapses away, so expose the search
        // from the bottom bar: open the patients page and focus its search.
        async openMobileSearch() {
            await this.navigate('patients');
            await this.$nextTick();
            document.querySelector('input[x-model="patientFilters.search"]')?.focus();
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
            }
        },
        
        async removePatient(patient) {
            if (!confirm(this.t('Are you sure you want to delete this patient?'))) return;
            try {
                await deletePatient(patient.id);
                this.patients = this.patients.filter(p => p.id !== patient.id);
            } catch (error) {
                console.error(error);
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
        
        // ---- AI bulk import ------------------------------------------------
        
        async openBulkImport() {
            if (!this.aiImportEnabled) {
                this.showAlert(this.t('AI Import is disabled by the administrator.'), 'warning');
                return;
            }
            this.aiPrompt = '';
            this.aiAttachments = [];
            this.aiDraftRows = [];
            if (!this.aiMessages.length) {
                this.aiMessages = [{
                    role: 'assistant',
                    text: this.t('Send me the patient list — describe them in words, or attach an image/spreadsheet/text file. I will extract every patient I can find and show them for your review before anything is saved.'),
                }];
            }
            this.currentPage = 'ai-import';
        },
        
        async onAiAttach(event) {
            const { fileToContents, isSupportedFile } = await import('./services/ai-import-client.js');
            const selected = Array.from(event.target.files ?? []);
            event.target.value = '';
            for (const file of selected) {
                if (!isSupportedFile(file).ok) {
                    this.showAlert(this.t('Unsupported file type: :name', { name: file.name }), 'warning');
                    continue;
                }
                try {
                    const content = await fileToContents(file);
                    this.aiAttachments.push({ name: file.name, kind: content.kind, content });
                } catch (error) {
                    this.showAlert(error.message, 'warning');
                }
            }
        },
        
        async sendAiRequest() {
            const prompt = this.aiPrompt.trim();
            if ((!prompt && !this.aiAttachments.length) || this.aiBusy) return;
            
            this.aiMessages.push({ role: 'user', text: prompt + (this.aiAttachments.length ? ` [${this.aiAttachments.map((a) => a.name).join(', ')}]` : '') });
            this.aiPrompt = '';
            this.aiBusy = true;
            
            try {
                const [{ generatePatientYaml }, { parsePatientYaml, validateRow, normalizeRow }] = await Promise.all([
                    import('./services/ai-import-client.js'),
                    import('./services/ai-import.js'),
                ]);
                
                const contents = [];
                if (prompt) contents.push({ kind: 'text', name: 'prompt', text: prompt });
                this.aiAttachments.forEach((a) => contents.push(a.content));
                
                // Section defaults the model should stamp onto every row.
                const defaults = this.profile?.section && !this.isSuperAdmin
                    ? [`section: ${this.profile.section}`]
                    : [];
                
                const yaml = await generatePatientYaml({ contents, defaults });
                const { rows, errors } = parsePatientYaml(yaml);
                
                if (rows.length) {
                    rows.forEach((raw) => {
                        const { row } = normalizeRow(raw);
                        this.aiDraftRows.push({ ...row, id: `row-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
                    });
                    const labeled = this.t('Found :count patient(s). Review the table below — edit anything green, fix or delete yellow rows, then import.', { count: rows.length });
                    this.aiMessages.push({ role: 'assistant', text: labeled + (errors.length ? ' ' + errors.join(' ') : '') });
                } else {
                    this.aiMessages.push({ role: 'assistant', text: this.t('I could not find any patients in that. Try describing them more explicitly or attach a clearer file.') });
                }
            } catch (error) {
                this.aiMessages.push({ role: 'assistant', text: error.message || this.t('Something went wrong.') });
            } finally {
                this.aiBusy = false;
                this.aiAttachments = [];
            }
        },
        
        rowErrors(row) {
            // Mirrors validateRow() in src/services/ai-import.js; kept local so
            // the markup stays synchronous and cheap.
            const errors = [];
            if (!row.name || !String(row.name).trim()) errors.push(this.t('Name is required'));
            const nid = String(row.national_id ?? '').trim();
            if (!nid) errors.push(this.t('National ID is required'));
            else if (!/^\d{14}$/.test(nid)) errors.push(this.t('National ID must be 14 digits'));
            if (row.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date_of_birth))) errors.push(this.t('Invalid date'));
            if (row.visit_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.visit_date))) errors.push(this.t('Invalid date'));
            if (row.age !== null && row.age !== '' && row.age !== undefined && !Number.isFinite(Number(row.age))) errors.push(this.t('Age must be a number'));
            if (row.price !== null && row.price !== '' && row.price !== undefined && !Number.isFinite(Number(row.price))) errors.push(this.t('Price must be a number'));
            if (row.source_of_money && !['charity', 'country'].includes(row.source_of_money)) errors.push(this.t('Invalid source'));
            if (row.marital_status && !['single', 'married', 'divorced', 'widowed'].includes(row.marital_status)) errors.push(this.t('Invalid marital status'));
            if (row.governorate && !this.governorates.includes(row.governorate)) errors.push(this.t('Unknown governorate'));
            return errors;
        },
        
        acceptableAiDraftCount() {
            return this.aiDraftRows.filter((row) => !this.rowErrors(row).length).length;
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
                    key: '',
                    model: settings.model || '',
                    enabled: !!settings.enabled,
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
                    key: this.aiSettingsForm.key.trim(),
                    model: this.aiSettingsForm.model,
                    enabled: !!this.aiSettingsForm.enabled,
                });
                this.aiSettings = settings;
                this.aiImportEnabled = !!settings.enabled;
                this.aiSettingsForm.key = '';
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
                this.aiSettingsTestResult = { ok: true, message: this.t('Connection OK — the key works.') };
            } catch (error) {
                this.aiSettingsTestResult = { ok: false, message: error.message || 'Connection failed' };
            } finally {
                this.aiSettingsTesting = false;
            }
        },

        async clearAiSettings() {
            if (!confirm(this.t('Remove the stored API key? AI Import will be disabled until a new key is saved.'))) return;
            const { clearAiSettings } = await import('./services/ai-settings.js');
            try {
                const settings = await clearAiSettings();
                this.aiSettings = settings;
                this.aiImportEnabled = !!settings.enabled;
                this.aiSettingsForm.key = '';
                this.aiSettingsForm.model = settings.model || '';
                this.aiSettingsForm.enabled = !!settings.enabled;
                this.showAlert(this.t('Stored API key removed.'), 'success');
            } catch (error) {
                this.showAlert(error.message || 'Error removing the key', 'danger');
            }
        },
        
        async saveAiDraft() {
            if (this.aiSaving) return;
            const ready = this.aiDraftRows.filter((row) => !this.rowErrors(row).length);
            if (!ready.length) return;
            
            this.aiSaving = true;
            try {
                const { sanitizeForInsert } = await import('./services/ai-import.js');
                const { createPatient } = await import('./services/patients.js');
                const accepted = [];
                const failed = [];
                for (const row of ready) {
                    try {
                        const created = await createPatient({
                            ...sanitizeForInsert(row),
                            section: this.profile?.section || row.section || null,
                            user_id: this.user.id,
                        });
                        accepted.push(created);
                    } catch (e) {
                        failed.push({ name: row.name, reason: e.message });
                    }
                }
                
                // Keep only the rows that failed, so the user can fix them.
                this.aiDraftRows = this.aiDraftRows.filter((row) => this.rowErrors(row).length || failed.some((f) => f.name === row.name));
                
                const summary = this.t('Imported :count patient(s).', { count: accepted.length });
                if (failed.length) {
                    this.showAlert(`${summary} ${this.t(':count row(s) failed:', { count: failed.length })} ${failed.map((f) => `${f.name}: ${f.reason}`).join(' | ')}`, 'warning');
                } else {
                    this.showAlert(summary);
                }
                if (accepted.length) await this.loadPatients();
            } finally {
                this.aiSaving = false;
            }
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
            return FOLLOWERS[key] || key || this.t('None');
        },
        
        showAlert(message, type = 'success') {
            this.alertMessage = message;
            this.alertType = type;
            setTimeout(() => {
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
            this.currentPage = 'patient-form';
        },
        
        async showPatient(patient) {
            this.selectedPatient = patient;
            this.currentPage = 'patient-profile';
        },
        
        addNote() {
            this.patientNotes.push('');
        },
        removeNote(index) {
            this.patientNotes.splice(index, 1);
        },
        
        async submitPatientForm() {
            const blocked = this.validatePatientForm();
            if (blocked) { this.showAlert(blocked, 'danger'); return; }

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

document.addEventListener('DOMContentLoaded', () => {
    Alpine.start();
});