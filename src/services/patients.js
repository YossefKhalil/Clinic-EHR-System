import { supabase } from './supabase.js';
import { getLocale } from './i18n.js';
// The governorate table of the import (the single source of truth): the
// stored value is the English name, the Arabic name comes with it.
import { GOVERNORATES as GOVERNORATE_ENTRIES } from '@import-core/enums.js';

// The columns the patients table can be sorted by. The key is what the
// table uses, the value is the column of the database - nothing else can be
// sorted by, so the query cannot be bent.
const SORTABLE_COLUMNS = {
    name: 'name',
    national_id: 'national_id',
    mobile: 'mobile',
    governorate: 'governorate',
    is_completed: 'is_completed',
    follower: 'follower',
    source_of_money: 'source_of_money',
    section: 'section',
    created_at: 'created_at',
};

export function sortableColumns() {
    return Object.keys(SORTABLE_COLUMNS);
}

// The filter of PostgREST is a list, so a comma, a bracket or a quote
// inside the term would cut the list in two. They are spaces in a search.
function escapeSearchTerm(term) {
    return String(term).replace(/[,()*"]/g, ' ').trim();
}

export async function getPatients(filters = {}, isSuperAdmin = false, userSection = null) {
    let query = supabase()
        .from('patients')
        .select('*');
    
    if (!isSuperAdmin && userSection) {
        query = query.eq('section', userSection);
    }
    
    if (filters.search) {
        const field = filters.filter_by || 'all';
        if (field === 'all') {
            // Any-value search across every patient field at once via the
            // anysearch computed field (see schema.sql). It renders every
            // column, including numbers/dates/jsonb, as text.
            //
            // The terms are the word that was typed and every word that
            // means the same thing (the Arabic name of a governorate and the
            // English one that is stored), so both are found.
            const terms = (filters.search_terms && filters.search_terms.length)
                ? filters.search_terms
                : [filters.search];
            if (terms.length > 1) {
                const filter = terms
                    .map((term) => `anysearch.ilike.%${escapeSearchTerm(term)}%`)
                    .join(',');
                query = query.or(filter);
            } else {
                query = query.ilike('anysearch', `%${filters.search}%`);
            }
        } else if (['name', 'national_id', 'mobile'].includes(field)) {
            query = query.ilike(field, `%${filters.search}%`);
        }
    }
    
    if (filters.section) query = query.eq('section', filters.section);
    if (filters.source_of_money) query = query.eq('source_of_money', filters.source_of_money);
    if (filters.follower) query = query.eq('follower', filters.follower);
    if (filters.record_type) query = query.eq('record_type', filters.record_type);
    
    if (filters.is_completed !== '' && filters.is_completed !== undefined && filters.is_completed !== null) {
        query = query.eq('is_completed', filters.is_completed);
    }
    
    // Date inputs are calendar days in the viewer's timezone; convert the
    // local day boundaries to UTC instants before comparing with timestamptz,
    // otherwise the filter is off by the timezone offset at the edges.
    if (filters.date_from) query = query.gte('created_at', new Date(`${filters.date_from}T00:00:00`).toISOString());
    if (filters.date_to) query = query.lte('created_at', new Date(`${filters.date_to}T23:59:59.999`).toISOString());
    
    // The sort: the newest row first is the start, a column that was pressed
    // takes over. A second key keeps rows with the same value in the same
    // order, so the table never shuffles itself.
    const sortColumn = SORTABLE_COLUMNS[filters.sort] || 'created_at';
    const ascending = filters.dir === 'asc';
    query = query.order(sortColumn, { ascending });
    if (sortColumn === 'created_at') query = query.order('id', { ascending: true });
    else query = query.order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) throw error;
    return data;
}

export async function getPatient(id) {
    const { data, error } = await supabase()
        .from('patients')
        .select('*')
        .eq('id', id)
        .single();
    
    if (error) throw error;
    return data;
}

export async function createPatient(patientData) {
    const { data, error } = await supabase()
        .from('patients')
        .insert(patientData)
        .select()
        .single();
    
    if (error) throw error;
    return data;
}

export async function updatePatient(id, patientData) {
    const { data, error } = await supabase()
        .from('patients')
        .update(patientData)
        .eq('id', id)
        .select()
        .single();
    
    if (error) throw error;
    return data;
}

export async function deletePatient(id) {
    const { error } = await supabase()
        .from('patients')
        .delete()
        .eq('id', id);
    
    if (error) throw error;
}

export async function togglePatientStatus(id, isCompleted) {
    const { data, error } = await supabase()
        .from('patients')
        .update({ is_completed: isCompleted })
        .eq('id', id)
        .select()
        .single();
    
    if (error) throw error;
    return data;
}

export const RECORD_TYPES = ['patient', 'food', 'classroom', 'well'];

export const RECORD_TYPE_LABELS = {
    patient: { en: 'Patient', ar: 'مريض' },
    food: { en: 'Food distribution (إطعام)', ar: 'إطعام' },
    classroom: { en: 'Classroom preparation', ar: 'تجهيز فصل دراسي' },
    well: { en: 'Well drilling', ar: 'حفر بئر' },
};

export const GOVERNORATES = [
    'Cairo', 'Giza', 'Alexandria', 'Dakahlia', 'Red Sea', 'Beheira', 'Faiyum',
    'Gharbia', 'Ismailia', 'Monufia', 'Minya', 'Qalyubia', 'New Valley', 'Suez',
    'Aswan', 'Asyut', 'Beni Suef', 'Port Said', 'Damietta', 'South Sinai',
    'North Sinai', 'Sharqia', 'Kafr El Sheikh', 'Qena', 'Luxor', 'Sohag', 'Matrouh'
];

const GOVERNORATE_AR = new Map(
    GOVERNORATE_ENTRIES.map((entry) => [entry.value.toLowerCase(), entry.ar]),
);

/**
 * The governorate of a patient, in the language of the interface.
 *
 * The app stores the English name (that is the value of the field); the
 * Arabic name is only for reading. An unknown value is returned as it is,
 * so a name that is not in the table is never lost.
 */
export function governorateLabel(value) {
    const name = (value || '').trim();
    if (!name) return '';
    if (getLocale() !== 'ar') return name;
    return GOVERNORATE_AR.get(name.toLowerCase()) || name;
}

export const FOLLOWERS_AR = {
    'حسن حمام': 'hassan_hamam',
    'عبد الرحمن أحمد': 'abdel_rahman_ahmed',
    'احمد سعد': 'ahmed_saad',
    'محمد علي': 'mohamed_ali',
    'محمد أحمد': 'mohamed_ahmed',
    'حازم': 'hazem',
    'محمد ربيع': 'mohamed_rabie',
};