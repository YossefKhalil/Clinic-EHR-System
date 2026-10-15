import { supabase } from './supabase.js';

export async function getDashboardStats(userId, isSuperAdmin, userSection = null) {
    let query = supabase().from('patients').select('*');
    
    if (!isSuperAdmin && userSection) {
        query = query.eq('section', userSection);
    }
    
    const { data: patients, error } = await query;
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
    const totalRevenue = patients.reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);
    
    return { total, completed, pending, sections, sources, totalRevenue };
}

export async function getRecentPatients(userId, isSuperAdmin, userSection = null, limit = 5) {
    let query = supabase()
        .from('patients')
        .select('*, users:user_id(name)')
        .order('created_at', { ascending: false })
        .limit(limit);
    
    if (!isSuperAdmin && userSection) {
        query = query.eq('section', userSection);
    }
    
    const { data, error } = await query;
    if (error) throw error;
    
    return data.map(p => ({
        ...p,
        user_name: p.users?.name || 'Unknown'
    }));
}