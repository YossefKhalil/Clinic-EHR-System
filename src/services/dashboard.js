import { supabase } from './supabase.js';

export async function getDashboardStats() {
    // Only the columns the cards aggregate. Notes, attachments and the other
    // free-text fields would otherwise be downloaded on every dashboard visit.
    // RLS limits the rows to the sections this account may read.
    const { data: patients, error } = await supabase()
        .from('patients')
        .select('is_completed, section, source_of_money');
    if (error) throw error;
    
    const total = patients.length;
    const completed = patients.filter(p => p.is_completed).length;
    const pending = total - completed;
    // Keyed counts instead of fixed columns: sections and sources of money
    // are editable lists now (issue #1), so any key can appear here.
    const sections = {};
    const sources = {};
    patients.forEach(p => {
        if (p.section) sections[p.section] = (sections[p.section] || 0) + 1;
        if (p.source_of_money) sources[p.source_of_money] = (sources[p.source_of_money] || 0) + 1;
    });
    return { total, completed, pending, sections, sources };
}

export async function getRecentPatients(limit = 5) {
    // RLS limits the rows to the sections this account may read.
    const { data, error } = await supabase()
        .from('patients')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    
    // registered_by_name is denormalized onto the patient row (schema.sql) so
    // section staff can see a registrar even though RLS hides other users.
    return data.map(p => ({
        ...p,
        user_name: p.registered_by_name || 'Unknown'
    }));
}