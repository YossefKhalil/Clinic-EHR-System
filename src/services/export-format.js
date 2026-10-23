// The rows and headings of the Excel export, in the language of the sheet.
//
// Kept apart from export.js (which talks to the database and writes the file)
// so the formatting can be unit-tested without a browser or a network: this
// module imports nothing beyond the field registry and the locale files.
//
// The language is explicit and defaults to Arabic: the workbook is written in
// the language the user asked for, not in the language of the interface.
import { EXPORT_FIELDS, EXPORT_FIELD_KEYS } from './export-fields.js';
import { GOVERNORATES as GOVERNORATE_ENTRIES } from '@import-core/enums.js';
import en from '../locales/en.json';
import ar from '../locales/ar.json';

const DICTS = { en, ar };
const DATE_TAG = { en: 'en-GB', ar: 'ar-EG' };

/** A key of the locale files in the export language. */
export function label(language, key) {
    const dict = DICTS[language] || DICTS.en;
    return dict[key] ?? DICTS.en[key] ?? key;
}

export function exportLanguage(language) {
    return language === 'en' ? 'en' : 'ar';
}

// The app stores the English governorate name; the Arabic name ships with it.
export function governorateText(value, language) {
    const name = String(value || '').trim();
    if (!name) return '';
    if (language !== 'ar') return name;
    const entry = GOVERNORATE_ENTRIES.find((item) => item.value.toLowerCase() === name.toLowerCase());
    return entry ? entry.ar : name;
}

// Marital status is stored as a key ('married'), the label is a locale key.
function maritalText(value, language) {
    const key = String(value || '').trim();
    if (!key) return '';
    return label(language, key.charAt(0).toUpperCase() + key.slice(1));
}

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;
function dateText(value, language) {
    if (!value) return '';
    const day = String(value).slice(0, 10);
    if (!YYYYMMDD.test(day)) return String(value);
    return new Date(day).toLocaleDateString(DATE_TAG[language] || DATE_TAG.en,
        { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * The table the workbook is built from: the chosen columns (always in the
 * registry order, whatever order the caller sent), their localized headers and
 * one row of localized values per patient.
 *
 * `optionLabel(kind, key, language)` renders the stored key of an editable
 * option (follower / section / source); without it the key is shown as it is.
 */
export function buildExportTable({
    rows = [],
    fields = EXPORT_FIELD_KEYS,
    language = 'ar',
    optionLabel = (kind, key) => String(key ?? ''),
} = {}) {
    const lang = exportLanguage(language);
    const selected = new Set(Array.isArray(fields) ? fields : EXPORT_FIELD_KEYS);
    const columns = EXPORT_FIELDS.filter((field) => selected.has(field.key));
    if (!columns.length) throw new Error(label(lang, 'Choose at least one field.'));

    const option = (kind) => (patient) => (patient[kind]
        ? optionLabel(kind === 'source_of_money' ? 'source' : kind, patient[kind], lang)
        : '');

    const CELLS = {
        name: (patient) => patient.name ?? '',
        national_id: (patient) => patient.national_id ?? '',
        mobile: (patient) => patient.mobile ?? '',
        governorate: (patient) => governorateText(patient.governorate, lang),
        age: (patient) => patient.age ?? '',
        marital_status: (patient) => maritalText(patient.marital_status, lang),
        children_count: (patient) => patient.children_count ?? '',
        address: (patient) => patient.address ?? '',
        problem: (patient) => patient.problem ?? '',
        solution: (patient) => patient.solution ?? '',
        follower: option('follower'),
        is_completed: (patient) => label(lang, patient.is_completed ? 'Completed' : 'Pending'),
        source_of_money: option('source_of_money'),
        section: option('section'),
        price: (patient) => patient.price ?? '',
        visit_date: (patient) => dateText(patient.visit_date, lang),
        created_at: (patient) => dateText(patient.created_at, lang),
        notes: (patient) => (Array.isArray(patient.notes) ? patient.notes.filter(Boolean).join('\n') : ''),
    };

    const headers = columns.map((field) => (field.key === 'price'
        ? `${label(lang, field.label)} (${label(lang, 'EGP')})`
        : label(lang, field.label)));
    const body = rows.map((patient) => columns.map((field) => CELLS[field.key](patient)));

    return { headers, body, columns, language: lang, sheetName: label(lang, 'Patients') };
}
