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
        patientFilters: { search: '', filter_by: 'name', section: '', source_of_money: '', follower: '', is_completed: '', date_from: '', date_to: '' },
        
        // Navbar search
        globalSearch: '',
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
                if (page === 'users') await this.loadUsers();
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
                filter_by: 'name',
                section: '', source_of_money: '', follower: '',
                is_completed: '', date_from: '', date_to: '',
            };
            await this.navigate('patients');
            // anysearch is the server-side matcher for the free-text box; the
            // filtered list uses it too, so both entry points agree.
            this.patientFilters.filter_by = 'all';
            await this.loadPatients();
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
            this.patientFilters = { search: '', filter_by: 'name', section: '', source_of_money: '', follower: '', is_completed: '', date_from: '', date_to: '' };
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
            const { createPatient, updatePatient } = await import('./services/patients.js');
            const payload = {
                ...this.patientForm,
                age: toNullableNumber(this.patientForm.age),
                price: toNullableNumber(this.patientForm.price),
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