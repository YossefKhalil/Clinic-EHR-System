// The columns the Excel export can write, in the order they appear in the
// sheet. The panel lists them as checkboxes and the writer builds the
// workbook from the same list, so a new column only has to be added here
// (plus its cell reader in export.js).
//
// `label` is a key of src/locales/*.json: the workbook is written in the
// export language, not in the interface language.
export const EXPORT_FIELDS = Object.freeze([
    { key: 'name', label: 'Patient Name', width: 22 },
    { key: 'national_id', label: 'National ID', width: 16 },
    { key: 'mobile', label: 'Mobile', width: 13 },
    { key: 'governorate', label: 'Governorate', width: 12 },
    { key: 'age', label: 'Age', width: 6 },
    { key: 'marital_status', label: 'Marital Status', width: 12 },
    { key: 'children_count', label: 'Number of Children', width: 8 },
    { key: 'address', label: 'Address', width: 28 },
    { key: 'problem', label: 'Problem', width: 24 },
    { key: 'solution', label: 'Solution', width: 24 },
    { key: 'follower', label: 'Follower', width: 16 },
    { key: 'is_completed', label: 'Status', width: 11 },
    { key: 'source_of_money', label: 'Source of Money', width: 12 },
    { key: 'section', label: 'Section', width: 10 },
    { key: 'price', label: 'Price', width: 12 },
    { key: 'visit_date', label: 'Visit Date', width: 14 },
    { key: 'created_at', label: 'Registered Date', width: 14 },
    { key: 'notes', label: 'Notes', width: 40 },
]);

export const EXPORT_FIELD_KEYS = Object.freeze(EXPORT_FIELDS.map((field) => field.key));
