// Field registry — the single source of truth for the import agent.
//
// One entry per importable `patients` column, in form order. Everything else
// is generated from this file (spec §4, invariant I4):
//   - the extractor prompt's key order and field guide
//   - the YAML contract's allowed keys
//   - the review grid's columns, headers and editors
//   - the normalize/validate pipeline bindings
//   - the bulk-fill panel
//   - the CSV report headers
//
// Rules for this module:
//   - Plain ES modules only: no DOM, Node or Deno APIs. It is imported by the
//     browser through the `@import-core` Vite alias and by Edge Functions via
//     relative paths.
//   - Keys EQUAL column names (`date_of_birth`, `solution`). Decision D15.
//   - `normalize` and `validate` are the names of pure functions implemented
//     in `normalizers.js` / `validate.js`; they are strings so this file stays
//     dependency-free and serialisable.
//   - The governorate list, marital statuses and the live option lists are
//     resolved through `enums.js` (M1); `enum` names the source.

export const FIELD_REGISTRY_VERSION = 1;

/**
 * @typedef {Object} FieldEntry
 * @property {string} key            Registry key; identical to `column`.
 * @property {string} column         `patients` column the value is written to.
 * @property {{en: string, ar: string}} label  Form/grid label (i18n keys match the app).
 * @property {'text'|'date'|'number'|'select'|'textarea'|'notes'} control
 * @property {'text'|'date'|'integer'|'number'|'enum'|'list'} type
 * @property {boolean} required      Required at save (form asterisk).
 * @property {boolean} extract       The LLM extracts this field.
 * @property {boolean} bulkFill      Offered in "Apply to every patient".
 * @property {string|null} llmHint   One line for the generated field guide.
 * @property {string} normalize      Normalizer function name.
 * @property {string[]} validate     Validator function names (issue producers).
 * @property {{scan: string, min: number, max: number, maxEditDistance: number}|null} snapToSource
 * @property {string|null} enum      Dynamic enum source name, or null.
 */

/** @type {FieldEntry[]} */
export const FIELDS = [
    {
        key: 'name',
        column: 'name',
        label: { en: 'Patient Name', ar: 'اسم المريض' },
        control: 'text',
        type: 'text',
        required: true,
        extract: true,
        bulkFill: false,
        llmHint: 'The patient\'s full name as written. Do not complete partial names.',
        normalize: 'name',
        validate: ['nameRequired'],
        snapToSource: null,
        enum: null,
    },
    {
        key: 'national_id',
        column: 'national_id',
        label: { en: 'National ID', ar: 'الرقم القومي' },
        control: 'text',
        type: 'text',
        required: true,
        extract: true,
        bulkFill: false,
        llmHint: 'Exactly as written; normally 14 digits. Copy digits exactly; never reformat or complete them.',
        normalize: 'nationalId',
        validate: ['nidRequired', 'nidDateRange'],
        // 13–15 digit runs in the cited lines; exactly one candidate within
        // edit distance 2 snaps (spec §8.2.3, regression R-01).
        snapToSource: { scan: 'digitRuns', min: 13, max: 15, maxEditDistance: 2 },
        enum: null,
    },
    {
        key: 'mobile',
        column: 'mobile',
        label: { en: 'Mobile Phone', ar: 'رقم الجوال' },
        control: 'text',
        type: 'text',
        required: false,
        extract: true,
        bulkFill: false,
        llmHint: 'The patient\'s phone number as written, including any leading 0, +20, spaces or dashes.',
        normalize: 'mobile',
        validate: [],
        snapToSource: { scan: 'digitRuns', min: 10, max: 13, maxEditDistance: 1 },
        enum: null,
    },
    {
        key: 'date_of_birth',
        column: 'date_of_birth',
        label: { en: 'Date of Birth', ar: 'تاريخ الميلاد' },
        control: 'date',
        type: 'date',
        required: false,
        extract: true,
        bulkFill: false,
        llmHint: 'Date of birth as written (for example "23-12-85" or "15 مارس 2002"). Copy the format; never convert it.',
        normalize: 'date',
        validate: ['dateOfBirthRange'],
        snapToSource: null,
        enum: null,
    },
    {
        key: 'age',
        column: 'age',
        label: { en: 'Age', ar: 'السن' },
        control: 'number',
        type: 'integer',
        required: false,
        extract: true,
        bulkFill: false,
        llmHint: 'Age as written. If only a date of birth is present, leave empty — never calculate.',
        normalize: 'age',
        validate: ['ageRange'],
        snapToSource: null,
        enum: null,
    },
    {
        key: 'marital_status',
        column: 'marital_status',
        label: { en: 'Marital Status', ar: 'الحالة الاجتماعية' },
        control: 'select',
        type: 'enum',
        required: false,
        extract: true,
        bulkFill: true,
        llmHint: 'As written, e.g. "متزوج", "single". Do not translate or map.',
        normalize: 'enumMatch',
        validate: [],
        snapToSource: null,
        enum: 'maritalStatus',
    },
    {
        key: 'children_count',
        column: 'children_count',
        label: { en: 'Number of Children', ar: 'عدد الأطفال' },
        control: 'number',
        type: 'integer',
        required: false,
        extract: true,
        bulkFill: true,
        llmHint: 'Number of children as written. Leave empty when not stated.',
        normalize: 'childrenCount',
        validate: ['childrenRange'],
        snapToSource: null,
        enum: null,
    },
    {
        key: 'governorate',
        column: 'governorate',
        label: { en: 'Governorate', ar: 'المحافظة' },
        control: 'select',
        type: 'enum',
        required: false,
        extract: true,
        bulkFill: true,
        llmHint: 'The governorate as written. A city (for example Tanta) is not a governorate — put it in address.',
        normalize: 'enumMatch',
        validate: [],
        snapToSource: null,
        enum: 'governorate',
    },
    {
        key: 'address',
        column: 'address',
        label: { en: 'Full Residential Address', ar: 'العنوان السكني الكامل' },
        control: 'textarea',
        type: 'text',
        required: false,
        extract: true,
        bulkFill: false,
        llmHint: 'The full residential address as written.',
        normalize: 'freeText',
        validate: ['textLength'],
        snapToSource: null,
        enum: null,
    },
    {
        key: 'problem',
        column: 'problem',
        label: { en: 'Presented Symptoms / Problem', ar: 'الأعراض المقدمة / المشكلة' },
        control: 'textarea',
        type: 'text',
        required: false,
        extract: true,
        bulkFill: false,
        llmHint: 'Why the patient came: complaints and symptoms, as written.',
        normalize: 'freeText',
        validate: ['textLength'],
        snapToSource: null,
        enum: null,
    },
    {
        key: 'solution',
        column: 'solution',
        label: { en: 'Diagnosis & Treatment Plan', ar: 'التشخيص وخطة العلاج' },
        control: 'textarea',
        type: 'text',
        required: false,
        extract: true,
        bulkFill: false,
        llmHint: 'The doctor\'s assessment, prescriptions, tests and treatment plan.',
        normalize: 'freeText',
        validate: ['textLength'],
        snapToSource: null,
        enum: null,
    },
    {
        key: 'visit_date',
        column: 'visit_date',
        label: { en: 'Visit Date', ar: 'تاريخ الزيارة' },
        control: 'date',
        type: 'date',
        required: false,
        extract: true,
        bulkFill: true,
        llmHint: 'Visit date as written. Do not invent a year and do not resolve words like "yesterday".',
        normalize: 'date',
        validate: ['visitDateRange'],
        snapToSource: null,
        enum: null,
    },
    {
        key: 'price',
        column: 'price',
        label: { en: 'Price (EGP)', ar: 'السعر (ج.م)' },
        control: 'number',
        type: 'number',
        required: false,
        extract: true,
        bulkFill: true,
        llmHint: 'Amount paid as written, for example "300 ج" or "250". Keep currency words and digits exactly.',
        normalize: 'price',
        validate: ['priceRange'],
        snapToSource: null,
        enum: null,
    },
    {
        key: 'follower',
        column: 'follower',
        label: { en: 'Follower', ar: 'المتابع' },
        control: 'select',
        type: 'enum',
        required: false,
        extract: true,
        bulkFill: true,
        llmHint: 'The staff member following this patient, as written (e.g. "Dr. Hala"). Do not map it to a list.',
        normalize: 'enumMatch',
        validate: [],
        snapToSource: null,
        enum: 'follower',
    },
    {
        // Never LLM-extracted (invariant: authorization-relevant value).
        // Comes from the user's permissions or the bulk-fill panel.
        key: 'section',
        column: 'section',
        label: { en: 'Section', ar: 'القسم' },
        control: 'select',
        type: 'enum',
        required: true,
        extract: false,
        bulkFill: true,
        llmHint: null,
        normalize: 'enumMatch',
        validate: ['sectionRequired'],
        snapToSource: null,
        enum: 'section',
    },
    {
        key: 'source_of_money',
        column: 'source_of_money',
        label: { en: 'Source of Money', ar: 'مصدر المال' },
        control: 'select',
        type: 'enum',
        required: false,
        extract: true,
        bulkFill: true,
        llmHint: 'Source of money as written, for example "نقدي" or "insurance".',
        normalize: 'enumMatch',
        validate: [],
        snapToSource: null,
        enum: 'sourceOfMoney',
    },
    {
        key: 'notes',
        column: 'notes',
        label: { en: 'Internal Clinic Notes', ar: 'ملاحظات العيادة الداخلية' },
        control: 'notes',
        type: 'list',
        required: false,
        extract: true,
        bulkFill: false,
        llmHint: 'Note-like text about the patient: allergies, reminders, remarks (e.g. "ملاحظات"). One entry per note.',
        normalize: 'notes',
        validate: ['notesLimits'],
        snapToSource: null,
        enum: null,
    },
];

// Keys the LLM may output beyond the extracted fields. Parsed separately and
// never written to a patient column (spec §4.2).
export const META_KEYS = ['unmapped', '_uncertain', '_src'];

export const FIELD_KEYS = FIELDS.map((field) => field.key);

/** Fields the extractor prompt lists, in registry order. */
export const EXTRACT_FIELDS = FIELDS.filter((field) => field.extract);

/** Keys the extractor must output: extracted fields, then meta keys. */
export const EXTRACT_OUTPUT_KEYS = [...EXTRACT_FIELDS.map((field) => field.key), ...META_KEYS];

/** Fields offered in the "Apply to every patient" panel. */
export const BULK_FILL_FIELDS = FIELDS.filter((field) => field.bulkFill);

/** Grid columns: registry order, status first (spec §10.3). */
export const GRID_COLUMN_KEYS = ['status', ...FIELD_KEYS];

export function fieldByKey(key) {
    return FIELDS.find((field) => field.key === key) || null;
}

export function fieldByColumn(column) {
    return FIELDS.find((field) => field.column === column) || null;
}
