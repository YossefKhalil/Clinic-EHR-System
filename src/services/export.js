// Excel export for the patients directory.
//
// Rows honor whatever the current user can already see on screen: getPatients
// applies the section RLS scope server-side the same way the table listing
// does, so a section user exports only their patients and an admin exports
// everyone. Every patient column is included, one row per patient; notes are
// joined with newlines into a single cell.
import * as XLSX from 'xlsx';
import { getPatients } from './patients.js';
import { optionLabel } from './options.js';
import { t, getLocale } from './i18n.js';

function profileOf(patient) {
    return [
        patient.name,
        patient.national_id,
        patient.mobile ?? '',
        patient.governorate ?? '',
        patient.age ?? '',
        patient.marital_status ?? '',
        patient.children_count ?? '',
        patient.address ?? '',
        patient.problem ?? '',
        patient.solution ?? '',
        patient.follower ? optionLabel('follower', patient.follower) : '',
        patient.is_completed ? t('Completed') : t('Pending'),
        patient.source_of_money ? optionLabel('source', patient.source_of_money) : '',
        patient.section ? optionLabel('section', patient.section) : '',
        patient.price ?? '',
        (patient.visit_date ? String(patient.visit_date).slice(0, 10) : ''),
        (patient.created_at ? String(patient.created_at).slice(0, 10) : ''),
        Array.isArray(patient.notes) ? patient.notes.join('\n') : '',
    ];
}

// Match the patient-form page's own date format so exports read consistently.
const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;
function displayDate(value) {
    if (!value || !YYYYMMDD.test(value)) return value ?? '';
    return new Date(value).toLocaleDateString(getLocale() === 'ar' ? 'ar-EG' : 'en-GB',
        { day: '2-digit', month: 'short', year: 'numeric' });
}

export async function exportPatientsToExcel(filters, isSuperAdmin, userSection) {
    const rows = await getPatients(filters ?? {}, isSuperAdmin, userSection);
    if (!rows.length) throw new Error(t('No patients recorded yet.'));

    const headers = [
        t('Patient Name'), t('National ID'), t('Mobile'), t('Governorate'),
        t('Age'), t('Marital Status'), t('Number of Children'), t('Address'),
        t('Problem'), t('Solution'), t('Follower'), t('Status'),
        t('Source of Money'), t('Section'), t('Price') + ' (EGP)',
        t('Visit Date'), t('Registered Date'), t('Notes'),
    ];
    const body = rows.map((patient) => {
        const [name, nid, mobile, gov, age, marital, children, address, problem, solution,
            follower, status, source, section, price, visitDate, createdAt, notes] = profileOf(patient);
        return [name, nid, mobile, gov, age, marital, children, address, problem, solution,
            follower, status, source, section, price, displayDate(visitDate), displayDate(createdAt), notes];
    });

    const sheet = XLSX.utils.aoa_to_sheet([headers, ...body]);
    // Provider-friendly: keep fields on a single line inside each cell.
    sheet['!cols'] = [
        { wch: 22 }, { wch: 16 }, { wch: 13 }, { wch: 12 },
        { wch: 6 }, { wch: 12 }, { wch: 8 }, { wch: 28 },
        { wch: 24 }, { wch: 24 }, { wch: 16 }, { wch: 11 },
        { wch: 12 }, { wch: 10 }, { wch: 12 },
        { wch: 14 }, { wch: 14 }, { wch: 40 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, t('Patients'));

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `patients-${stamp}.xlsx`;
    XLSX.writeFile(workbook, filename);
    return filename;
}
