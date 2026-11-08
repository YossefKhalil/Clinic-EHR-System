// A self-contained, printable patient record (issue #57).
//
// This module is deliberately lazy-loaded: opening the print dialog is rare,
// while the app shell loads on every visit. The report is built from the
// patient row that getPatient() already returned under RLS, so there is no
// new endpoint, table, or database read here.
//
// The browser's print dialog is the PDF writer. The print window receives a
// complete document with inline CSS and no app navigation, and its title is
// the suggested PDF filename.

const A4_CONTENT_HEIGHT_MM = 273; // 297mm page - 12mm top and bottom margins
const MM_TO_PX = 96 / 25.4;
const MIN_BODY_PT = 8;
const START_BODY_PT = 10;

const ARABIC_FONT_STACK = '"Segoe UI", Tahoma, "Noto Naskh Arabic", "Traditional Arabic", Arial, sans-serif';
const LATIN_FONT_STACK = '"Segoe UI", Arial, Helvetica, sans-serif';

// Every patient value is plain text. This runs before any value reaches the
// report markup so an imported name or note can never become HTML.
export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function clean(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function hasValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

function shortPatientId(patient) {
    const id = clean(patient?.id);
    return id ? id.slice(0, 8) : '';
}

function formatDateValue(value, locale) {
    const text = clean(value);
    if (!text) return '';
    // Date-only columns must not shift a day when the browser is west of UTC.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    const date = dateOnly
        ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
        : new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    }).format(date);
}

function formatDateTimeValue(value, locale) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

function formatMoneyValue(value) {
    if (!hasValue(value)) return '';
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return number.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function ageFromDateOfBirth(dateOfBirth, now) {
    const text = clean(dateOfBirth);
    if (!text) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (!match) return null;
    const dob = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (Number.isNaN(dob.getTime())) return null;
    let age = now.getFullYear() - dob.getFullYear();
    const month = now.getMonth() - dob.getMonth();
    if (month < 0 || (month === 0 && now.getDate() < dob.getDate())) age -= 1;
    return age >= 0 ? age : null;
}

const ATTACHMENT_TYPES = {
    'application/pdf': 'PDF',
    'application/msword': 'DOC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'image/jpeg': 'JPG',
    'image/png': 'PNG',
    'image/webp': 'WEBP',
    'image/gif': 'GIF',
    'image/bmp': 'BMP',
    'image/avif': 'AVIF',
    'image/heic': 'HEIC',
    'image/tiff': 'TIFF',
    'text/csv': 'CSV',
    'text/plain': 'TXT',
};

const ATTACHMENT_EXTENSIONS = {
    pdf: 'PDF',
    doc: 'DOC',
    docx: 'DOCX',
    xls: 'XLS',
    xlsx: 'XLSX',
    jpg: 'JPG',
    jpeg: 'JPG',
    png: 'PNG',
    webp: 'WEBP',
    gif: 'GIF',
    bmp: 'BMP',
    avif: 'AVIF',
    heic: 'HEIC',
    tif: 'TIFF',
    tiff: 'TIFF',
    csv: 'CSV',
    txt: 'TXT',
};

function attachmentType(attachment) {
    // A MIME value can carry parameters (text/plain; charset=utf-8); the
    // type map and the compact fallback want only the media type.
    const mime = clean(attachment?.mime).split(';')[0].trim().toLowerCase();
    if (ATTACHMENT_TYPES[mime]) return ATTACHMENT_TYPES[mime];
    const name = clean(attachment?.name);
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (ATTACHMENT_EXTENSIONS[extension]) return ATTACHMENT_EXTENSIONS[extension];
    // Unknown formats still get a compact, useful label rather than a long
    // vendor MIME subtype.
    if (mime.includes('/')) {
        const subtype = mime.split('/').pop().split('+')[0].split('.').pop();
        if (subtype) return subtype.toUpperCase();
    }
    return extension ? extension.toUpperCase() : '';
}

function field(label, value, className = '') {
    if (!hasValue(value)) return '';
    return `<div class="field${className ? ` ${className}` : ''}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function proseBlock(label, value) {
    if (!hasValue(value)) return '';
    return `<div class="clinical-block"><h3>${escapeHtml(label)}</h3><p class="prose">${escapeHtml(value)}</p></div>`;
}

function notesBlock(label, notes) {
    const list = (Array.isArray(notes) ? notes : [])
        .map((note) => clean(note))
        .filter(Boolean);
    if (!list.length) return '';
    return `<div class="clinical-block">
        <h3>${escapeHtml(label)}</h3>
        <ul class="notes">
            ${list.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}
        </ul>
    </div>`;
}

function attachmentsBlock(heading, attachments) {
    if (!attachments.length) return '';
    return `<section class="block attachments">
        <h2>${escapeHtml(heading)}</h2>
        <ul class="attachment-list">
            ${attachments.map((attachment) => {
                const type = attachmentType(attachment);
                return `<li><span class="attachment-name">${escapeHtml(attachment.name)}</span>${type ? `<span class="attachment-type">${escapeHtml(type)}</span>` : ''}</li>`;
            }).join('')}
        </ul>
    </section>`;
}

function wordmark(t) {
    // A plain black-and-white wordmark prints cleanly on any printer and
    // cannot turn into a grey box when a browser disables background colours.
    return `<div class="wordmark">${escapeHtml(t('Clinic EHR'))}</div>`;
}

function reportImagePages(images, { t, name, generated }) {
    if (!images.length) return '';
    const total = images.length;
    const confidentiality = clean(t('Confidential medical record'));
    return images.map((image, index) => {
        const type = attachmentType(image);
        const position = t('Image :index of :count')
            .replace(':index', String(index + 1))
            .replace(':count', String(total));
        return `<section class="sheet report-image-page" aria-label="${escapeHtml(position)}">
    <header class="masthead">
        <div>
            ${wordmark(t)}
            <div class="document-kind">${escapeHtml(t('Attachments (:count)').replace(':count', String(total)))}</div>
        </div>
        <div class="header-meta">
            <div>${escapeHtml(name || t('Patient'))}</div>
            <div>${escapeHtml(position)}</div>
        </div>
    </header>
    <figure class="attachment-figure">
        <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}">
        <div class="image-error">${escapeHtml(t('Image could not be loaded'))}</div>
        <figcaption>
            <span>${escapeHtml(image.name)}</span>
            ${type ? `<span class="attachment-type">${escapeHtml(type)}</span>` : ''}
        </figcaption>
    </figure>
    <footer class="report-footer">
        ${confidentiality ? `<span>${escapeHtml(confidentiality)}</span>` : ''}
        <span>${escapeHtml(t('Generated'))}: ${escapeHtml(generated)}</span>
    </footer>
</section>`;
    }).join('');
}

// The print dialog uses the document title as the suggested filename. Keep
// it to a predictable, path-safe value; the full patient ID never appears.
export function patientReportFilename(patient, now = new Date()) {
    const dateValue = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const id = clean(patient?.national_id) || shortPatientId(patient) || 'record';
    const date = `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, '0')}-${String(dateValue.getDate()).padStart(2, '0')}`;
    const title = `Patient-${id}-${date}`
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/-+/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 120);
    return title || 'Patient-record';
}

function styles(locale) {
    return `
        :root {
            --ink: #111;
            --muted: #555;
            --line: #c9c9c9;
            --soft: #f4f4f4;
            --accent: #111;
            --danger: #111;
            --success: #111;
            --report-body-size: ${START_BODY_PT}pt;
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #fff; color: var(--ink); }
        body {
            font-family: ${locale === 'ar' ? ARABIC_FONT_STACK : LATIN_FONT_STACK};
            font-size: var(--report-body-size);
            line-height: 1.42;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }
        .sheet {
            width: 186mm;
            min-height: ${A4_CONTENT_HEIGHT_MM}mm;
            margin: 0 auto;
            background: #fff;
            font-size: var(--report-body-size);
        }
        .masthead {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 8mm;
            border-bottom: 1pt solid #111;
            padding-bottom: 2.6mm;
        }
        .wordmark {
            color: #111;
            font-size: 18.5pt;
            font-weight: 800;
            letter-spacing: -0.015em;
            line-height: 1.08;
            white-space: nowrap;
        }
        /* Arabic is a connected script: negative tracking hurts legibility. */
        html[dir="rtl"] .wordmark {
            font-size: 18pt;
            letter-spacing: 0;
        }
        .document-kind {
            margin-top: 1.15mm;
            font-size: 8.5pt;
            font-weight: 700;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: #333;
        }
        .header-meta { text-align: end; color: var(--muted); font-size: 8pt; line-height: 1.55; }
        .patient-heading {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            gap: 6mm;
            padding: 4.5mm 0 3mm;
        }
        .patient-name {
            margin: 0;
            font-size: 18pt;
            line-height: 1.12;
            font-weight: 800;
            overflow-wrap: anywhere;
        }
        .patient-subtitle { margin-top: 1.2mm; color: var(--muted); font-size: 8.5pt; }
        .status {
            flex: 0 0 auto;
            border: 0.8pt solid currentColor;
            border-radius: 999px;
            padding: 1mm 3mm;
            font-size: 8pt;
            font-weight: 700;
            white-space: nowrap;
        }
        .status.completed { color: var(--success); background: #eeeeee; }
        .status.pending { color: var(--muted); background: var(--soft); }
        .block { margin-top: 3.4mm; break-inside: avoid; }
        .block h2 {
            margin: 0 0 1.8mm;
            padding-bottom: 0.9mm;
            border-bottom: 0.8pt solid var(--line);
            color: var(--accent);
            font-size: 11pt;
            line-height: 1.25;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 2.2mm 6mm;
            margin: 0;
        }
        /* Identity and visit details are short fields; three compact columns
           leave more vertical room for the clinical text on a busy record. */
        .grid.compact {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 1.5mm 5mm;
        }
        .grid.compact .field dt { font-size: 8pt; margin-bottom: 0.25mm; }
        .grid.compact .field dd { line-height: 1.32; }
        /* The address follows the governorate, so let it take the other two
           columns instead of starting a mostly-empty new row. */
        .field.wide { grid-column: span 2; }
        .field dt {
            margin: 0 0 0.4mm;
            color: var(--muted);
            font-size: 7.8pt;
            font-weight: 700;
            letter-spacing: 0.025em;
        }
        .field dd {
            margin: 0;
            font-size: var(--report-body-size);
            font-weight: 600;
            overflow-wrap: anywhere;
        }
        .clinical-block { margin-top: 3mm; break-inside: avoid; }
        .clinical-block:first-of-type { margin-top: 0; }
        .clinical-block h3 {
            margin: 0 0 1.2mm;
            color: var(--ink);
            font-size: 9.4pt;
            font-weight: 800;
        }
        .prose {
            margin: 0;
            padding: 2.2mm 2.8mm;
            border-inline-start: 2.2pt solid var(--line);
            background: var(--soft);
            white-space: pre-line;
            overflow-wrap: anywhere;
        }
        .notes { margin: 0; padding: 0; list-style: none; }
        .notes li {
            margin-top: 1.8mm;
            padding: 1.8mm 2.6mm;
            border-inline-start: 2pt solid var(--line);
            background: var(--soft);
            white-space: pre-line;
            overflow-wrap: anywhere;
            break-inside: avoid;
        }
        .notes li:first-child { margin-top: 0; }
        .attachment-list {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 1.2mm 5mm;
            margin: 0;
            padding: 0;
            list-style: none;
        }
        .attachment-list li {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 3mm;
            padding-bottom: 0.8mm;
            border-bottom: 0.5pt dotted var(--line);
            break-inside: avoid;
        }
        .attachment-name { overflow-wrap: anywhere; }
        .attachment-type { flex: 0 0 auto; color: var(--muted); font-size: 7.5pt; font-weight: 700; }
        .continuation { display: none; }
        .sheet.is-continued .continuation {
            display: flex;
            gap: 2mm;
            align-items: baseline;
            margin-top: 3mm;
            padding: 1.8mm 2.4mm;
            border: 0.8pt solid #111;
            background: #f2f2f2;
            color: #111;
            font-size: 8pt;
        }
        .report-footer {
            display: flex;
            justify-content: space-between;
            gap: 4mm;
            margin-top: 4mm;
            padding-top: 2mm;
            border-top: 0.8pt solid var(--line);
            color: var(--muted);
            font-size: 7.5pt;
        }
        /* Attached images are an optional appendix. Each one starts on a new
           page and is contained without cropping, so it never competes with
           the clinical record on page one. */
        .report-image-page {
            display: flex;
            flex-direction: column;
            break-before: page;
            page-break-before: always;
        }
        .attachment-figure {
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 205mm;
            margin: 5mm 0 0;
            text-align: center;
            break-inside: avoid;
        }
        .attachment-figure img {
            display: block;
            width: auto;
            height: auto;
            max-width: 100%;
            max-height: 205mm;
            object-fit: contain;
        }
        .attachment-figure figcaption {
            display: flex;
            justify-content: space-between;
            gap: 4mm;
            width: 100%;
            margin-top: 3mm;
            padding-top: 2mm;
            border-top: 0.8pt solid var(--line);
            color: var(--muted);
            font-size: 8pt;
            text-align: start;
        }
        .image-error {
            display: none;
            padding: 8mm;
            color: var(--muted);
            font-size: 9pt;
        }
        .attachment-figure.image-unavailable img { display: none; }
        .attachment-figure.image-unavailable .image-error { display: block; }
        @page { size: A4 portrait; margin: 12mm; }
        @media screen {
            body { background: #e8e8e8; padding: 12mm 0; }
            .sheet { box-shadow: 0 1pt 5pt rgba(23, 32, 51, 0.18); }
            .report-image-page { margin-top: 12mm; }
        }
        @media print {
            html, body { background: #fff; }
            body { padding: 0; }
            .sheet { width: auto; min-height: 0; box-shadow: none; }
            .report-image-page { margin: 0; }
        }
    `;
}

export function buildPatientReportHtml(patient, options = {}) {
    const locale = options.locale === 'ar' ? 'ar' : 'en';
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    const t = typeof options.t === 'function' ? options.t : (key) => key;
    const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
        ? options.now
        : new Date();
    const labels = options.labels || {};
    const generated = formatDateTimeValue(now, locale);
    const confidentiality = clean(t('Confidential medical record'));
    const name = clean(patient?.name);
    const shortId = shortPatientId(patient);
    const title = patientReportFilename(patient, now);

    const section = clean(labels.section);
    const follower = clean(labels.follower);
    const source = clean(labels.sourceOfMoney);
    const governorate = clean(labels.governorate);
    const maritalStatus = clean(labels.maritalStatus);

    const computedAge = ageFromDateOfBirth(patient?.date_of_birth, now);
    const age = computedAge !== null
        ? String(computedAge)
        : (hasValue(patient?.age) ? String(patient.age) : '');
    const price = formatMoneyValue(patient?.price);
    const priceText = price ? `${price} ${t('EGP')}` : '';

    const identityFields = [
        field(t('National ID'), patient?.national_id),
        field(t('Mobile Number'), patient?.mobile),
        field(t('Date of Birth'), formatDateValue(patient?.date_of_birth, locale)),
        field(t('Age'), age),
        field(t('Marital Status'), maritalStatus),
        field(t('Dependents / Children'), hasValue(patient?.children_count) ? String(patient.children_count) : ''),
        field(t('Governorate'), governorate),
        field(t('Home Address'), patient?.address, 'wide'),
    ].filter(Boolean).join('');

    const adminFields = [
        field(t('Visit Date'), formatDateValue(patient?.visit_date, locale)),
        field(t('Status'), t(patient?.is_completed ? 'Completed' : 'Pending')),
        field(t('Follower'), follower),
        field(t('Source of Money'), source),
        field(t('Price'), priceText),
        field(t('Registered by:'), patient?.registered_by_name || patient?.user_name),
        field(t('Registered Date'), formatDateTimeValue(patient?.created_at, locale)),
    ].filter(Boolean).join('');

    const clinical = [
        proseBlock(t('Presented Symptoms / Problem'), patient?.problem),
        proseBlock(t('Diagnosis & Treatment Plan'), patient?.solution),
        notesBlock(t('Internal Clinic Notes'), patient?.notes),
    ].filter(Boolean).join('');

    const attachmentItems = (Array.isArray(patient?.attachments) ? patient.attachments : [])
        .filter((attachment) => attachment && hasValue(attachment.name));
    const attachments = attachmentsBlock(
        t('Attachments (:count)').replace(':count', String(attachmentItems.length)),
        attachmentItems,
    );
    // Images are an explicit, opt-in appendix: the main record must stay
    // compact and printable on its own. Only HTTP(S) sources are accepted so
    // a malformed attachment cannot inject another scheme.
    const reportImages = options.includeImages === true && Array.isArray(options.images)
        ? options.images.filter((image) => image && hasValue(image.name) && /^https?:\/\//i.test(clean(image.url)))
        : [];

    return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles(locale)}</style>
</head>
<body>
<main class="sheet report-main">
    <header class="masthead">
        <div>
            ${wordmark(t)}
            <div class="document-kind">${escapeHtml(t('Patient Record'))}</div>
        </div>
        <div class="header-meta">
            ${section ? `<div>${escapeHtml(t('Section'))}: ${escapeHtml(section)}</div>` : ''}
            <div>${escapeHtml(t('Generated'))}: ${escapeHtml(generated)}</div>
        </div>
    </header>

    <div class="patient-heading">
        <div>
            <h1 class="patient-name">${escapeHtml(name || t('Patient'))}</h1>
            <div class="patient-subtitle">
                ${shortId ? `${escapeHtml(t('Patient ID:'))} #${escapeHtml(shortId)}` : ''}
            </div>
        </div>
        <span class="status ${patient?.is_completed ? 'completed' : 'pending'}">${escapeHtml(t(patient?.is_completed ? 'Completed' : 'Pending'))}</span>
    </div>

    <div class="continuation" role="note">
        <strong>${escapeHtml(t('Continued on next page'))}</strong>
        <span>${escapeHtml(t('This record is longer than one page; clinical text continues without truncation.'))}</span>
    </div>

    ${identityFields ? `<section class="block">
        <h2>${escapeHtml(t('Patient Information'))}</h2>
        <dl class="grid compact">${identityFields}</dl>
    </section>` : ''}

    ${adminFields ? `<section class="block">
        <h2>${escapeHtml(t('Visit & Administration'))}</h2>
        <dl class="grid compact">${adminFields}</dl>
    </section>` : ''}

    ${clinical ? `<section class="block">
        <h2>${escapeHtml(t('Clinical Notes'))}</h2>
        ${clinical}
    </section>` : ''}

    ${attachments}

    <footer class="report-footer">
        ${confidentiality ? `<span>${escapeHtml(confidentiality)}</span>` : ''}
        <span>${escapeHtml(t('Generated'))}: ${escapeHtml(generated)}</span>
    </footer>
</main>
${reportImagePages(reportImages, { t, name, generated })}
</body>
</html>`;
}

function waitForDocument(printWindow) {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        const afterFonts = () => {
            if (printWindow.closed) {
                done();
                return;
            }
            const fonts = printWindow.document.fonts;
            if (fonts && typeof fonts.ready?.then === 'function') {
                // System fonts normally resolve immediately; the race keeps a
                // stalled font promise from leaving the print tab blank.
                Promise.race([
                    fonts.ready,
                    new Promise((resolve) => setTimeout(resolve, 1500)),
                ]).then(done, done);
            } else {
                done();
            }
        };
        if (printWindow.closed) {
            done();
            return;
        }
        if (printWindow.document.readyState === 'complete') {
            afterFonts();
            return;
        }
        printWindow.addEventListener('load', afterFonts, { once: true });
        // A blocked or interrupted load must not leave the button spinning.
        setTimeout(afterFonts, 1500);
    });
}

function waitForImages(document, timeout = 5000) {
    const images = [...document.querySelectorAll('.report-image-page img')];
    if (!images.length) return Promise.resolve();
    return Promise.all(images.map((image) => new Promise((resolve) => {
        if (image.complete) {
            resolve();
            return;
        }
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        image.addEventListener('load', done, { once: true });
        image.addEventListener('error', done, { once: true });
        // A slow or blocked image must not hold the print dialog forever.
        setTimeout(done, timeout);
    }))).then(() => {
        images.forEach((image) => {
            if (!image.complete || image.naturalWidth === 0) {
                image.closest('.attachment-figure')?.classList.add('image-unavailable');
            }
        });
    });
}

function fitReportToPage(document) {
    // Only the clinical sheet is auto-fitted. The image appendix has its own
    // pages and must not trigger the continuation warning on page one.
    const sheet = document.querySelector('.report-main');
    if (!sheet) return;
    // The screen sheet has a 273mm min-height, so scrollHeight can never tell
    // us whether the content itself fits. Measure with that floor removed,
    // keeping a couple of pixels of print-rounding slack.
    const available = A4_CONTENT_HEIGHT_MM * MM_TO_PX - 2;
    const screenMinHeight = sheet.style.minHeight;
    sheet.style.minHeight = '0';
    try {
        const height = () => sheet.getBoundingClientRect().height;
        let size = START_BODY_PT;
        sheet.style.setProperty('--report-body-size', `${size}pt`);
        for (let step = 0; step < 8 && height() > available && size > MIN_BODY_PT; step += 1) {
            size = Math.max(MIN_BODY_PT, Number((size - 0.25).toFixed(2)));
            sheet.style.setProperty('--report-body-size', `${size}pt`);
        }
        sheet.classList.toggle('is-continued', height() > available);
    } finally {
        sheet.style.minHeight = screenMinHeight;
    }
}

function closeAfterPrint(printWindow) {
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        try { printWindow.close(); } catch { /* the window may already be gone */ }
    };
    printWindow.addEventListener('afterprint', () => setTimeout(close, 250), { once: true });
    setTimeout(close, 60000);
}

export async function openPatientReport(patient, options = {}) {
    // Callers normally open the window synchronously from the click so the
    // popup blocker sees a user gesture. The fallback keeps the function
    // usable on its own.
    const printWindow = options.printWindow || window.open('', '_blank');
    if (!printWindow) {
        const error = new Error('POPUP_BLOCKED');
        error.code = 'POPUP_BLOCKED';
        throw error;
    }

    try {
        printWindow.opener = null;
        const document = printWindow.document;
        document.open();
        document.write(buildPatientReportHtml(patient, options));
        document.close();
        await waitForDocument(printWindow);
        await waitForImages(document);
        fitReportToPage(document);
        printWindow.focus();
        closeAfterPrint(printWindow);
        printWindow.print();
    } catch (error) {
        try { printWindow.close(); } catch { /* ignore */ }
        throw error;
    }
}
