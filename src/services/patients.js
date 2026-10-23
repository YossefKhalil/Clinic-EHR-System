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

// The filter of PostgREST is a list, so a comma, a bracket or a quote
// inside the term would cut the list in two. They are spaces in a search.
function escapeSearchTerm(term) {
    return String(term).replace(/[,()*"]/g, ' ').trim();
}

// One query builder for both the full export and the paginated table, so the
// filters and sort can never drift between them.
function patientsQuery(filters = {}, options = {}) {
    let query = options.count
        ? supabase().from('patients').select('*', { count: 'exact' })
        : supabase().from('patients').select('*');

    // Section scope is enforced by RLS (can_read_section/can_write_section).
    // Filtering again by a single section here would hide the other sections
    // a user has been granted, so it is deliberately omitted.

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

    return query;
}

// The unpaginated list. Export and global search pass a limit when they do
// not need every row; the patients directory uses getPatientsPage below.
export async function getPatients(filters = {}, options = {}) {
    let query = patientsQuery(filters);
    if (Number.isInteger(options.limit) && options.limit > 0) {
        query = query.limit(options.limit);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
}

// One server-side page for the patients directory. The count is requested
// with the page so the pager knows the size of the filtered result without a
// second round trip.
export async function getPatientsPage(filters = {}, options = {}) {
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 25));
    const page = Math.max(1, Math.trunc(Number(options.page) || 1));
    const from = (page - 1) * pageSize;

    const { data, error, count } = await patientsQuery(filters, { count: true })
        .range(from, from + pageSize - 1);
    if (error) throw error;

    return {
        rows: data ?? [],
        total: count ?? 0,
        page,
        pageSize,
    };
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

// The patient form reads the same governorate table the import agent uses.
export const GOVERNORATES = GOVERNORATE_ENTRIES.map((entry) => entry.value);

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
