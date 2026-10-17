// Generates the committed reader fixtures in tests/fixtures/readers/.
//
// Run: node scripts/generate-reader-fixtures.mjs
//
// The fixtures are deterministic: regenerating them on any machine produces
// the same bytes (dates are written in UTC, no randomness, no clock). The
// hostile cases (zip bombs, bad signatures) are synthesized inside the tests,
// not committed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { buildZip } from '../tests/helpers/zip-writer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tests', 'fixtures', 'readers');
mkdirSync(OUT, { recursive: true });

const write = (name, bytes) => {
    writeFileSync(join(OUT, name), bytes);
    console.log(`  ${name} (${bytes.length} bytes)`);
};

// ---------------------------------------------------------------------------
// patients.xlsx — the workhorse spreadsheet fixture
// ---------------------------------------------------------------------------

const HEADER = ['Serial No', 'Name', 'National ID', 'Mobile', 'DOB', 'Visit Date', 'Governorate', 'Paid', ''];

function patientRow(i) {
    return [
        i,
        `Patient ${i}`,
        `2900101${String(i).padStart(7, '0')}`,
        `010${String(i).padStart(8, '0')}`,
        new Date(Date.UTC(1990, 0, 1 + (i % 300))),
        '2026-10-12',
        i % 3 === 0 ? 'Cairo' : i % 3 === 1 ? 'Giza' : 'Dakahlia',
        i * 10,
        '',
    ];
}

{
    const rows = [HEADER];
    // Row 2: the quirk row — ID and phone as numbers, real date cell.
    rows.push([
        1,
        'Ahmed Mohamed Ali',
        29805151201234,
        1012345678,
        new Date(Date.UTC(1990, 4, 15)),
        new Date(Date.UTC(2026, 9, 12)),
        'Cairo',
        300,
        '',
    ]);
    for (let i = 2; i <= 148; i += 1) rows.push(patientRow(i));
    rows.push(HEADER.slice(0, 8));        // repeated header (no merge), excel row 150
    rows.push(new Array(HEADER.length).fill('')); // empty row, excel row 151
    rows.push([153, ...new Array(HEADER.length - 1).fill('')]); // serial-only row, excel row 152
    for (let i = 149; i <= 500; i += 1) rows.push(patientRow(i));

    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true, dateNF: 'yyyy-mm-dd' });
    ws['!merges'] = [{ s: { r: 0, c: 7 }, e: { r: 0, c: 8 } }]; // Paid spans into Currency

    const october = XLSX.utils.aoa_to_sheet([
        ['Name', 'National ID', 'Mobile'],
        ['منى حسن على', '29903220201567', '01112345678'],
        ['Nour El-Din', '28512230101234', '0123456789'],
    ]);
    const scratch = XLSX.utils.aoa_to_sheet([
        ['Name', 'National ID', 'Mobile'],
        ['Hidden Person', '29001010101010', '01098765432'],
    ]);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Patients');
    XLSX.utils.book_append_sheet(wb, october, 'October');
    XLSX.utils.book_append_sheet(wb, scratch, 'Scratch');
    wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] };

    write('patients.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', UTC: true, compression: true }));
}

// ---------------------------------------------------------------------------
// CSV fixtures
// ---------------------------------------------------------------------------

{
    // UTF-8 with BOM, comma delimiter, quoted newline and quoted comma.
    const body = [
        '﻿الاسم,الرقم القومي,الموبايل,ملاحظات',
        '"سارة عبد الرحمن",29903220201567,01223344556,"حساسية من البنسلين,',
        'متابعة كل شهر"',
        'خالد إبراهيم,3050101010101,1012345679,',
        '',
    ].join('\n');
    write('arabic.csv', new TextEncoder().encode(body));
}

{
    // Windows-1256 (legacy Arabic export), semicolon delimiter.
    const text = [
        'الاسم;الرقم القومي;الموبايل;المحافظة',
        'أحمد محمود السيد;29805151201234;01012345678;الدقهلية',
        'منى حسن على;29903220201567;01112345678;القاهرة',
        '',
    ].join('\r\n');
    write('legacy-1256.csv', encodeCp1256(text));
}

{
    // No delimiter at all: must fall back to plain text with a warning.
    const body = ['ملاحظات العيادة', 'حساسية من البنسلين', 'متابعة كل شهر', ''].join('\n');
    write('single-column.csv', new TextEncoder().encode(body));
}

// ---------------------------------------------------------------------------
// announcement.txt
// ---------------------------------------------------------------------------

{
    const body = [
        '---- العيادة مغلقة الجمعة القادمة ----',
        'Mona Hassan Ali, phone +20 111 234 5678, born 3/4/1985, single',
        'visit: 14 Oct. paid 250. dr amr follow up',
        '',
    ].join('\n');
    write('announcement.txt', new TextEncoder().encode(body));
}

// ---------------------------------------------------------------------------
// report.docx — headings, paragraph, list, table, embedded image
// ---------------------------------------------------------------------------

{
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

    const para = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const heading = (text) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const listItem = (text) => `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
    const row = (cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
    const image = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/>`
        + '<wp:docPr id="1" name="Picture 1"/><a:graphic>'
        + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        + '<pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        + '<pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>'
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';

    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>
${heading('Patients report')}
${para('Old list from paper notes.')}
${listItem('See notes')}
<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>
${row(['Name', 'National ID', 'Mobile'])}
${row(['Ahmed Mahmoud', '29805151201234', '01012345678'])}
${row(['Mona Hassan', '29903220201567', '01112345678'])}
</w:tbl>
${image}
${para('Questions? Call the clinic.')}
<w:sectPr/>
</w:body></w:document>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;

    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

    const png = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    ));

    write('report.docx', buildZip([
        { name: '[Content_Types].xml', data: contentTypes },
        { name: '_rels/.rels', data: rels },
        { name: 'word/document.xml', data: document },
        { name: 'word/_rels/document.xml.rels', data: docRels },
        { name: 'word/styles.xml', data: styles },
        { name: 'word/numbering.xml', data: numbering },
        { name: 'word/media/image1.png', data: png },
    ]));
}

// ---------------------------------------------------------------------------
// PDF fixtures (ASCII text layer — Arabic PDFs need embedded fonts)
// ---------------------------------------------------------------------------

{
    write('notes.pdf', buildPdf([
        ['Patients October', 'Ahmed 29805151201234 01012345678', 'Mona 29903220201567'],
        [],   // page 2 has no text layer
        ['Follow-up list', 'Nour El-Din 28512230101234 0123456789'],
    ]));
    write('long.pdf', buildPdf(
        Array.from({ length: 21 }, (_, i) => [`Page ${i + 1} of the long report`]),
    ));
}

console.log(`\nFixtures written to ${OUT}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Windows-1256 encoder via the reverse of the platform's decoder table. */
function encodeCp1256(text) {
    const decoder = new TextDecoder('windows-1256');
    const reverse = new Map();
    for (let byte = 0x80; byte <= 0xff; byte += 1) {
        const char = decoder.decode(Uint8Array.of(byte));
        if (char && char !== '\uFFFD') reverse.set(char, byte);
    }
    const out = [];
    for (const char of text) {
        const code = char.charCodeAt(0);
        if (code < 0x80) {
            out.push(code);
        } else if (reverse.has(char)) {
            out.push(reverse.get(char));
        } else {
            throw new Error(`No Windows-1256 code for ${JSON.stringify(char)} (U+${code.toString(16)})`);
        }
    }
    return Uint8Array.from(out);
}

/** Minimal single-font PDF writer; all text must be ASCII. */
function buildPdf(pages) {
    const objects = [];
    const kids = [];
    let num = 4;
    const pageEntries = pages.map((lines) => {
        const pageObj = num;
        const contentObj = num + 1;
        num += 2;
        kids.push(`${pageObj} 0 R`);
        return { pageObj, contentObj, lines };
    });

    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

    for (const { pageObj, contentObj, lines } of pageEntries) {
        objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] `
            + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
        const content = lines.length === 0
            ? ''
            : `BT /F1 12 Tf 14 TL 72 760 Td\n${lines.map((line) => `(${escapePdfText(line)}) Tj T*\n`).join('')}ET`;
        objects[contentObj] = { stream: content };
    }

    let out = '%PDF-1.4\n';
    const offsets = [];
    for (let i = 1; i < objects.length; i += 1) {
        const object = objects[i];
        if (object === undefined) continue;
        offsets[i] = out.length;
        if (typeof object === 'string') {
            out += `${i} 0 obj\n${object}\nendobj\n`;
        } else {
            out += `${i} 0 obj\n<< /Length ${object.stream.length} >>\nstream\n${object.stream}\nendstream\nendobj\n`;
        }
    }
    const xrefStart = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objects.length; i += 1) {
        out += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return new TextEncoder().encode(out);
}

function escapePdfText(text) {
    return text.replace(/[\\()]/g, (match) => `\\${match}`);
}
