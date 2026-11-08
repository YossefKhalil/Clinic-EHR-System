import { describe, expect, it } from 'vitest';
import {
    buildPatientReportHtml,
    escapeHtml,
    patientReportFilename,
} from '../../src/services/patient-report.js';

const NOW = new Date(2026, 10, 8, 9, 30);

const patient = {
    id: '5c2be669-32c5-48b8-86d1-ecc04ad66bf0',
    name: '<script>alert("x")</script>',
    national_id: '12345678901234',
    mobile: '01000000000',
    date_of_birth: '1990-01-02',
    age: 30,
    marital_status: 'married',
    children_count: 2,
    governorate: 'Cairo',
    address: '<b>Street & Co</b>',
    problem: 'Fever & <pain>',
    solution: 'Rest\nFollow up',
    notes: ['Note <one>', ''],
    visit_date: '2026-11-01',
    is_completed: true,
    price: '1234.5',
    follower: 'follower-key',
    section: 'agamy',
    source_of_money: 'cash',
    registered_by_name: 'Dr. A',
    created_at: '2026-11-01T10:30:00Z',
    record_type: 'patient',
    user_id: 'user-secret-uuid',
    import_batch_id: 'batch-secret-uuid',
    attachments: [{
        name: 'scan.pdf',
        mime: 'application/pdf',
        url: 'https://res.cloudinary.com/demo/raw/authenticated/scan.pdf',
        public_id: 'clinic-ehr/secret',
    }],
};

const t = (key) => key;

describe('patient report', () => {
    it('escapes every patient value before it reaches the document', () => {
        const html = buildPatientReportHtml(patient, { locale: 'en', t, now: NOW });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>Street');
        expect(html).not.toContain('<pain>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&lt;b&gt;Street &amp; Co&lt;/b&gt;');
        expect(escapeHtml('a & b < c > d "e" \'f\'')).toBe(
            'a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;',
        );
    });

    it('renders identity, visit, clinical, and attachment sections', () => {
        const html = buildPatientReportHtml(patient, { locale: 'en', t, now: NOW });
        expect(html).toContain('<h2>Patient Information</h2>');
        expect(html).toContain('<h2>Visit &amp; Administration</h2>');
        expect(html).toContain('<h2>Clinical Notes</h2>');
        expect(html).toContain('<h2>Attachments (1)</h2>');
        expect(html).toContain('Fever &amp; &lt;pain&gt;');
        expect(html).toContain('Rest\nFollow up');
        expect(html).toContain('Note &lt;one&gt;');
        expect(html).toContain('scan.pdf');
        expect(html).toContain('PDF');
        expect(html).toContain('1,234.50 EGP');
        expect(html).toContain('02 Jan 1990');
        expect(html).toContain('<span class="status completed">Completed</span>');
        expect(html).toContain('#5c2be669');
    });

    it('omits empty fields and empty sections', () => {
        const html = buildPatientReportHtml({
            id: 'abc12345-0000-0000-0000-000000000000',
            name: 'Only a name',
            is_completed: false,
        }, { locale: 'en', t, now: NOW });

        expect(html).toContain('Only a name');
        expect(html).not.toContain('Mobile Number');
        expect(html).not.toContain('Clinical Notes');
        expect(html).not.toContain('Attachments (');
        expect(html).not.toContain('undefined');
        expect(html).not.toContain('null');
    });

    it('localizes labels and switches to RTL for Arabic', () => {
        const arabic = {
            'Patient Record': 'سجل المريض',
            'Patient Information': 'بيانات المريض',
            'Presented Symptoms / Problem': 'الأعراض',
            'Completed': 'مكتمل',
            'Attachments (:count)': 'المرفقات (:count)',
            'EGP': 'ج.م',
        };
        const html = buildPatientReportHtml(patient, {
            locale: 'ar',
            t: (key) => arabic[key] || key,
            now: NOW,
        });

        expect(html).toContain('lang="ar" dir="rtl"');
        expect(html).toContain('سجل المريض');
        expect(html).toContain('بيانات المريض');
        expect(html).toContain('الأعراض');
        expect(html).toContain('مكتمل');
        expect(html).toContain('المرفقات (1)');
        expect(html).toContain('ج.م');
    });

    it('never prints attachment URLs, public IDs, raw UUIDs, or internal IDs', () => {
        const html = buildPatientReportHtml(patient, { locale: 'en', t, now: NOW });
        expect(html).not.toContain('https://');
        expect(html).not.toContain('clinic-ehr/secret');
        expect(html).not.toContain(patient.id);
        expect(html).not.toContain(patient.user_id);
        expect(html).not.toContain(patient.import_batch_id);
        expect(html).toContain('scan.pdf');
    });

    it('uses a safe print title and filename', () => {
        const html = buildPatientReportHtml(patient, { locale: 'en', t, now: NOW });
        expect(html).toContain('<title>Patient-12345678901234-2026-11-08</title>');
        expect(patientReportFilename(patient, NOW)).toBe('Patient-12345678901234-2026-11-08');
        expect(patientReportFilename({ id: patient.id }, NOW)).toBe('Patient-5c2be669-2026-11-08');
        expect(patientReportFilename({ national_id: '12/34' }, NOW)).toBe('Patient-12-34-2026-11-08');
        expect(patientReportFilename({ national_id: '../../etc/passwd' }, NOW)).not.toContain('/');
        expect(patientReportFilename({}, NOW)).toBe('Patient-record-2026-11-08');
    });

    it('includes a labelled continuation warning without truncating clinical text', () => {
        const longNote = 'Clinical note. '.repeat(500);
        const html = buildPatientReportHtml({
            ...patient,
            notes: [longNote],
        }, { locale: 'en', t, now: NOW });

        expect(html).toContain('Continued on next page');
        expect(html).toContain('This record is longer than one page; clinical text continues without truncation.');
        expect(html).toContain(longNote.trim());
    });
});
