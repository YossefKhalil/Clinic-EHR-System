import { supabase } from './supabase.js';
import { getLocale } from './i18n.js';
import { escapeSearchTerm } from './search-terms.js';
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

// Rows for the directory, global search and dashboard-style reads. Notes and
// attachments are the two heavy columns; they are fetched by getPatient (or
// getPatientsByIds for an export) only when a record is actually opened.
const PATIENT_COLUMNS = [
    'id', 'name', 'national_id', 'record_type', 'mobile', 'date_of_birth',
    'age', 'marital_status', 'children_count', 'governorate', 'address',
    'problem', 'solution', 'visit_date', 'is_completed', 'price', 'follower',
    'section', 'source_of_money', 'user_id', 'created_at', 'updated_at',
    'registered_by_name', 'import_batch_id',
];
export const PATIENT_LIST_COLUMNS = PATIENT_COLUMNS.join(',');
export const PATIENT_FULL_COLUMNS = [...PATIENT_COLUMNS, 'notes', 'attachments'].join(',');

// One query builder for the full export and the paginated table, so the
// filters and sort can never drift between them.
function patientsQuery(filters = {}, options = {}) {
    const columns = options.full ? PATIENT_FULL_COLUMNS : PATIENT_LIST_COLUMNS;
    let query = options.count
        ? supabase().from('patients').select(columns, { count: 'estimated' })
        : supabase().from('patients').select(columns);

    // Section scope is enforced by RLS (readable_sections/writable_sections).
    // Filtering again by a single section here would hide the other sections
    // a user has been granted, so it is deliberately omitted.

    if (filters.search) {
        const field = filters.filter_by || 'all';
        if (field === 'all') {
            // search_text is the stored, trigger-maintained blob of every
            // searchable patient field. Filtering the column directly lets
            // the pg_trgm GIN index answer the ILIKE instead of recomputing
            // every row through a function. The terms are the word that was
            // typed and every word that means the same thing (the Arabic name
            // of a governorate and the English one that is stored), so both
            // are found.
            const terms = (filters.search_terms && filters.search_terms.length)
                ? filters.search_terms
                : [filters.search];
            if (terms.length > 1) {
                const filter = terms
                    .map((term) => `search_text.ilike.%${escapeSearchTerm(term)}%`)
                    .join(',');
                query = query.or(filter);
            } else {
                query = query.ilike('search_text', `%${escapeSearchTerm(filters.search)}%`);
            }
        } else if (['name', 'national_id', 'mobile'].includes(field)) {
            query = query.ilike(field, `%${escapeSearchTerm(filters.search)}%`);
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

// Every matching row, in 1000-row pages. PostgREST caps a single response at
// 1000 rows; the old export asked for one unbounded response and silently
// lost everything after row 1000 (issue #44).
export async function getAllPatients(filters = {}, options = {}) {
    const pageSize = Math.min(1000, Math.max(1, Number(options.pageSize) || 1000));
    const rows = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await patientsQuery(filters, { full: true })
            .range(from, from + pageSize - 1);
        if (error) throw error;
        const page = data ?? [];
        rows.push(...page);
        if (page.length < pageSize) break;
    }
    return rows;
}

// One server-side page for the patients directory. The count is estimated
// rather than exact: on a hot path the exact count forces a full scan, while
// the pager only needs a number close enough to render its links.
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

// Explicit rows for the export when the user ticked them in the table. The
// section scope is still applied by RLS, so an id outside the caller's
// sections simply comes back empty.
export async function getPatientsByIds(ids) {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!list.length) return [];

    // A long selection would overflow the PostgREST URL (and the 1000-row
    // response cap), so ask in small batches and merge them in export order.
    const CHUNK = 100;
    const batches = [];
    for (let index = 0; index < list.length; index += CHUNK) {
        batches.push(list.slice(index, index + CHUNK));
    }
    const pages = await Promise.all(batches.map(async (batch) => {
        const { data, error } = await supabase()
            .from('patients')
            .select(PATIENT_FULL_COLUMNS)
            .in('id', batch)
            .order('created_at', { ascending: true });
        if (error) throw error;
        return data ?? [];
    }));

    return pages.flat().sort((a, b) => (
        String(a.created_at || '').localeCompare(String(b.created_at || ''))
    ));
}

export async function getPatient(id) {
    const { data, error } = await supabase()
        .from('patients')
        .select(PATIENT_FULL_COLUMNS)
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
        .select('id, is_completed')
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
