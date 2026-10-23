// Excel export for the patients directory.
//
// The workbook is written in the language the caller asks for (Arabic by
// default), independently of the interface language: headers, option labels,
// the status and the dates are all in that language, and an Arabic sheet is
// marked right-to-left so it opens the same way the app reads. The formatting
// itself lives in export-format.js.
//
// Rows honor whatever the current user can already see on screen: getPatients
// applies the section RLS scope server-side the same way the table listing
// does, so a section user exports only their patients and an admin exports
// everyone. The caller can pass explicit ids (the rows a user ticked) instead
// of filters; the same scope still applies.
import * as XLSX from 'xlsx';
import { getPatients, getPatientsByIds } from './patients.js';
import { allOptions } from './options.js';
import { EXPORT_FIELD_KEYS } from './export-fields.js';
import { buildExportTable, exportLanguage, label } from './export-format.js';

// The label of a stored option key in the export language. The cache holds
// both labels, so the choice does not depend on the interface language.
function optionLabel(kind, key, language) {
    const option = allOptions(kind).find((entry) => entry.key === key);
    if (!option) return String(key);
    const text = language === 'ar'
        ? (option.label_ar || option.label_en)
        : (option.label_en || option.label_ar);
    return text || String(key);
}

/**
 * Write the patients workbook and return its file name.
 *
 * @param {object} options
 * @param {object} [options.filters]   the filters of the table (empty = all)
 * @param {string[]} [options.ids]     explicit rows; wins over the filters
 * @param {string[]} [options.fields]  export field keys; defaults to all
 * @param {'ar'|'en'} [options.language] the language of the sheet; 'ar'
 */
export async function exportPatientsToExcel({
    filters = {},
    ids = null,
    fields = EXPORT_FIELD_KEYS,
    language = 'ar',
} = {}) {
    const lang = exportLanguage(language);
    // Reject an empty column selection before querying: there is nothing to
    // write for zero columns.
    buildExportTable({ fields, language: lang });

    const rows = Array.isArray(ids)
        ? await getPatientsByIds(ids)
        : await getPatients(filters ?? {});
    if (!rows.length) throw new Error(label(lang, 'No patients recorded yet.'));

    const table = buildExportTable({ rows, fields, language: lang, optionLabel });
    const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.body]);
    sheet['!cols'] = table.columns.map((field) => ({ wch: field.width }));
    const workbook = XLSX.utils.book_new();
    // The reader of an Arabic sheet expects its first column on the right.
    workbook.Workbook = { Views: [{ RTL: table.language === 'ar' }] };
    XLSX.utils.book_append_sheet(workbook, sheet, table.sheetName);

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `patients-${stamp}-${table.language}.xlsx`;
    XLSX.writeFile(workbook, filename);
    return filename;
}
