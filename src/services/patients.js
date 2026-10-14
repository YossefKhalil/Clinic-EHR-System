import { supabase } from './supabase.js';

export async function getPatients(filters = {}, isSuperAdmin = false, userSection = null) {
    let query = supabase()
        .from('patients')
        .select('*')
        .order('created_at', { ascending: false });
    
    if (!isSuperAdmin && userSection) {
        query = query.eq('section', userSection);
    }
    
    if (filters.search) {
        const field = filters.filter_by || 'all';
        if (field === 'all') {
            // Any-value search across every patient field at once via the
            // anysearch computed field (see schema.sql). It renders every
            // column, including numbers/dates/jsonb, as text.
            const term = `%${filters.search}%`;
            query = query.ilike('anysearch', term);
        } else if (['name', 'national_id', 'mobile'].includes(field)) {
            query = query.ilike(field, `%${filters.search}%`);
        }
    }
    
    if (filters.section) query = query.eq('section', filters.section);
    if (filters.source_of_money) query = query.eq('source_of_money', filters.source_of_money);
    if (filters.follower) query = query.eq('follower', filters.follower);
    
    if (filters.is_completed !== '' && filters.is_completed !== undefined && filters.is_completed !== null) {
        query = query.eq('is_completed', filters.is_completed);
    }
    
    if (filters.date_from) query = query.gte('created_at', `${filters.date_from}T00:00:00`);
    if (filters.date_to) query = query.lte('created_at', `${filters.date_to}T23:59:59.999`);
    
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

export const FOLLOWERS = {
    hassan_hamam: 'حسن حمام',
    abdel_rahman_ahmed: 'عبد الرحمن أحمد',
    ahmed_saad: 'احمد سعد',
    mohamed_ali: 'محمد علي',
    mohamed_ahmed: 'محمد أحمد',
    hazem: 'حازم',
    mohamed_rabie: 'محمد ربيع',
};

export const GOVERNORATES = [
    'Cairo', 'Giza', 'Alexandria', 'Dakahlia', 'Red Sea', 'Beheira', 'Faiyum',
    'Gharbia', 'Ismailia', 'Monufia', 'Minya', 'Qalyubia', 'New Valley', 'Suez',
    'Aswan', 'Asyut', 'Beni Suef', 'Port Said', 'Damietta', 'South Sinai',
    'North Sinai', 'Sharqia', 'Kafr El Sheikh', 'Qena', 'Luxor', 'Sohag', 'Matrouh'
];

export const FOLLOWERS_AR = {
    'حسن حمام': 'hassan_hamam',
    'عبد الرحمن أحمد': 'abdel_rahman_ahmed',
    'احمد سعد': 'ahmed_saad',
    'محمد علي': 'mohamed_ali',
    'محمد أحمد': 'mohamed_ahmed',
    'حازم': 'hazem',
    'محمد ربيع': 'mohamed_rabie',
};