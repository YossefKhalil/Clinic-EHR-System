// Lightweight fuzzy matching shared by the navbar search and the patients
// filter. Normalizes both sides (case, Arabic diacritics, alef/ya/ta-marbuta
// variants, digits) then requires every token of the search string to hit
// somewhere in the target — order-independent, so "احمد محمد" matches
// "محمد احمد السيد" and "ahmed" matches "Ahmed".
const normalizeMap = {
    'أ': 'ا', 'إ': 'ا', 'آ': 'ا',
    'ى': 'ي', 'ئ': 'ي', 'ؤ': 'ي', 'ة': 'ه',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

// Remove Arabic harakat/tatweel.
const DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g;

export function normalizeText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(DIACRITICS, '')
        .replace(/[أإآىئؤة٠-٩۰-۹]/g, (ch) => normalizeMap[ch] ?? ch)
        .trim();
}

/**
 * Check one patient record against a raw search query across every documented
 * patient field (plus a handful of friendly aliases like the follower's Arabic
 * label). Tokens must all match, but they may hit different fields, so
 * "احمد agamy" finds the Ahmed registered in Agamy.
 */
export function patientMatchesQuery(patient, query, followerLabel = (k) => k ?? '') {
    if (!patient || !query || !String(query).trim()) return !patient ? false : true;

    const tokens = normalizeText(query).split(/\s+/).filter((tok) => tok.length > 1);
    if (!tokens.length) return true;

    const followKey = patient.follower ?? '';
    const statusWords = patient.is_completed ? ['complete', 'مكتمل'] : ['pending', 'قيد'];

    const fields = [
        patient.name, patient.national_id, patient.mobile,
        patient.governorate, patient.address, patient.problem, patient.solution,
        patient.marital_status, patient.age, patient.children_count,
        patient.visit_date, patient.created_at, patient.price,
        followKey, followerLabel(followKey),
        patient.section, patient.source_of_money,
        patient.is_completed ? 'complete completed' : 'pending',
        Array.isArray(patient.notes) ? patient.notes.join(' ') : (patient.notes ?? ''),
    ];

    const corpus = normalizeText(fields.join(' | ') + ' ' + statusWords.join(' '));
    return tokens.every((tok) => corpus.includes(tok));
}
