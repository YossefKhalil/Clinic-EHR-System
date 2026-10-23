// The patient form -> Postgres payload, kept out of the Alpine component so
// the coercions that used to hide in the submit handler are unit-tested.
//
// Empty form strings are not valid values for the typed columns: Postgres
// rejects '' for integer, numeric and date columns. They become null here.

export function toNullableNumber(value) {
    return value === '' || value === null || value === undefined ? null : Number(value);
}

const ATTACHMENT_KEYS = [
    'public_id',
    'url',
    'name',
    'size',
    'mime',
    'uploaded_at',
    'authenticated',
    'resource_type',
    'format',
];

function attachmentForDatabase(attachment) {
    return Object.fromEntries(
        ATTACHMENT_KEYS.map((key) => [key, attachment?.[key]]),
    );
}

/**
 * Build the row sent to createPatient/updatePatient.
 *
 * `editingPatient` is the row before the edit: it keeps the completed flag
 * and suppresses `user_id`, so an edit never reassigns who registered the
 * patient. A new row gets the signed-in user's id.
 */
export function buildPatientPayload(form, {
    notes = [],
    attachments = [],
    editingPatient = null,
    userId = null,
} = {}) {
    const values = form ?? {};
    const payload = {
        ...values,
        section: values.section || null,
        source_of_money: values.source_of_money || null,
        marital_status: values.marital_status || null,
        age: toNullableNumber(values.age),
        children_count: toNullableNumber(values.children_count),
        price: toNullableNumber(values.price),
        date_of_birth: values.date_of_birth
            ? String(values.date_of_birth).slice(0, 10)
            : null,
        visit_date: values.visit_date
            ? String(values.visit_date).slice(0, 10)
            : null,
        notes: notes.map((note) => String(note ?? '').trim()).filter(Boolean),
        is_completed: editingPatient?.is_completed ?? false,
        attachments: attachments.map(attachmentForDatabase),
    };

    if (!editingPatient && userId) {
        payload.user_id = userId;
    }

    return payload;
}
