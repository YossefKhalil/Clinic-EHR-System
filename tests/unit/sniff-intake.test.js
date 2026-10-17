// M3: content sniffing, the zip-bomb guard and intake validation (spec §5.2).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    analyzeFile,
    formatBytes,
    hashWarning,
    sha256Hex,
    validateIntake,
} from '../../src/features/import-agent/intake.js';
import {
    isTextLike,
    isZipBomb,
    readZipIndex,
    sniffKind,
} from '../../src/features/import-agent/readers/index.js';
import { buildZip } from '../helpers/zip-writer.mjs';

const bytesOf = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/readers/${name}`, import.meta.url)));
const encode = (text) => new TextEncoder().encode(text);

const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const utf16le = (text) => Uint8Array.from([...text].flatMap((ch) => [ch.charCodeAt(0), 0]));

function oleBytes(streamName) {
    return Uint8Array.from([...OLE_SIG, ...new Uint8Array(32), ...utf16le(streamName), 0, 0]);
}

function zipWithWorkbook(entries = [], options = {}) {
    return buildZip([
        { name: 'xl/workbook.xml', data: '<workbook/>', ...options },
        { name: '[Content_Types].xml', data: '<Types/>' },
        ...entries,
    ]);
}

describe('sniffKind', () => {
    it('recognizes the committed fixtures by content', () => {
        expect(sniffKind(bytesOf('patients.xlsx')).kind).toBe('xlsx');
        expect(sniffKind(bytesOf('report.docx')).kind).toBe('docx');
        expect(sniffKind(bytesOf('notes.pdf')).kind).toBe('pdf');
        expect(sniffKind(bytesOf('arabic.csv')).kind).toBe('text');
        expect(sniffKind(bytesOf('announcement.txt')).kind).toBe('text');
        expect(sniffKind(bytesOf('legacy-1256.csv')).kind).toBe('text');
    });

    it('classifies OLE2 containers by their stream names', () => {
        expect(sniffKind(oleBytes('Workbook'))).toEqual({ kind: 'xls' });
        expect(sniffKind(oleBytes('Book'))).toEqual({ kind: 'xls' });
        expect(sniffKind(oleBytes('WordDocument'))).toEqual({ kind: 'doc' });
        expect(sniffKind(oleBytes('PowerPoint Document')).kind).toBe('ole');
    });

    it('recognizes image signatures', () => {
        expect(sniffKind(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2))).toEqual({ kind: 'image', detail: 'png' });
        expect(sniffKind(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2))).toEqual({ kind: 'image', detail: 'jpeg' });
        expect(sniffKind(encode('GIF89a....'))).toEqual({ kind: 'image', detail: 'gif' });
        expect(sniffKind(encode('RIFF????WEBPVP8 '))).toEqual({ kind: 'image', detail: 'webp' });
        const heic = new Uint8Array(16);
        heic.set(encode('ftypheic'), 4);
        expect(sniffKind(heic)).toEqual({ kind: 'image', detail: 'heic' });
    });

    it('does not fall through to text for binary bytes', () => {
        expect(sniffKind(Uint8Array.of(0x00, 0xff, 0x10, 0x00)).kind).toBe('unknown');
        expect(sniffKind(Uint8Array.of(0x42, 0x4e, 0x00, 0x01, 0x02)).kind).toBe('unknown');
    });

    it('flags unreadable and unrecognized zips', () => {
        expect(sniffKind(encode('PK\u0003\u0004not really a zip'))).toEqual({ kind: 'zip', detail: 'unreadable' });
        const plainZip = buildZip([{ name: 'notes.txt', data: 'hello' }]);
        expect(sniffKind(plainZip)).toEqual({ kind: 'zip', detail: 'unknown' });
    });
});

describe('zip-bomb guard (central directory only)', () => {
    it('reads the directory of a real workbook without decompressing', () => {
        const index = readZipIndex(bytesOf('patients.xlsx'));
        expect(index).not.toBeNull();
        expect(index.entries.map((e) => e.name)).toContain('xl/workbook.xml');
        expect(index.totalUncompressed).toBeGreaterThan(index.totalCompressed); // deflated
        expect(isZipBomb(index)).toBe(false);
    });

    it('rejects an absolute-size bomb', () => {
        const bomb = zipWithWorkbook([], { declaredUncompressed: 101 * 1024 * 1024 });
        const index = readZipIndex(bomb);
        expect(isZipBomb(index)).toBe(true);
        expect(validateIntake(bomb, 'bomb.xlsx')).toEqual({
            ok: false,
            code: 'ZIP_BOMB',
            params: { name: 'bomb.xlsx', limitMb: '100 MB' },
        });
    });

    it('rejects a ratio bomb', () => {
        const bomb = zipWithWorkbook([{ name: 'xl/sharedStrings.xml', data: new Uint8Array(200) }], { declaredUncompressed: 200000 });
        expect(isZipBomb(readZipIndex(bomb))).toBe(true);
    });

    it('rejects malformed zips at intake', () => {
        expect(validateIntake(encode('PK\u0003\u0004broken'), 'broken.xlsx')).toEqual({
            ok: false,
            code: 'ZIP_UNREADABLE',
            params: { name: 'broken.xlsx' },
        });
    });
});

describe('validateIntake', () => {
    it('rejects empty files', () => {
        expect(validateIntake(new Uint8Array(0), 'empty.csv').code).toBe('EMPTY_FILE');
    });

    it('rejects files over the size limit with a human limit', () => {
        const huge = new Uint8Array(8 * 1024 * 1024 + 1);
        const verdict = validateIntake(huge, 'huge.xlsx');
        expect(verdict.code).toBe('FILE_TOO_LARGE');
        expect(verdict.params.limit).toBe('8 MB');
    });

    it('accepts the supported fixtures', () => {
        expect(validateIntake(bytesOf('patients.xlsx'), 'patients.xlsx')).toEqual({ ok: true, kind: 'xlsx' });
        expect(validateIntake(oleBytes('Workbook'), 'old.xls')).toEqual({ ok: true, kind: 'xls' });
        expect(validateIntake(bytesOf('report.docx'), 'report.docx')).toEqual({ ok: true, kind: 'docx' });
        expect(validateIntake(bytesOf('notes.pdf'), 'notes.pdf')).toEqual({ ok: true, kind: 'pdf' });
        expect(validateIntake(bytesOf('arabic.csv'), 'arabic.csv')).toEqual({ ok: true, kind: 'text' });
        const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
        expect(validateIntake(png, 'x.png')).toEqual({ ok: true, kind: 'image', detail: 'png' });
    });

    it('rejects legacy .doc and unknown containers', () => {
        expect(validateIntake(oleBytes('WordDocument'), 'letter.doc')).toMatchObject({ ok: false, code: 'DOC_LEGACY' });
        expect(validateIntake(oleBytes('PowerPoint Document'), 'slides.ppt')).toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE' });
        expect(validateIntake(buildZip([{ name: 'notes.txt', data: 'hello' }]), 'archive.zip'))
            .toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE' });
        expect(validateIntake(Uint8Array.of(0x00, 0xff, 0x10), 'blob.bin'))
            .toMatchObject({ ok: false, code: 'UNSUPPORTED_TYPE' });
    });

    it('probes PDFs for encryption', () => {
        const encrypted = encode('%PDF-1.4\n1 0 obj <</Encrypt 2 0 R>>\n%%EOF');
        expect(validateIntake(encrypted, 'locked.pdf')).toEqual({
            ok: false,
            code: 'PDF_ENCRYPTED',
            params: { name: 'locked.pdf' },
        });
    });
});

describe('analyzeFile and hashing', () => {
    it('hashes the file and reports its kind', async () => {
        const bytes = bytesOf('patients.xlsx');
        const verdict = await analyzeFile({ bytes, name: 'patients.xlsx' });
        expect(verdict.ok).toBe(true);
        expect(verdict.kind).toBe('xlsx');
        expect(verdict.size).toBe(bytes.length);
        expect(verdict.sha256).toBe(createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
    });

    it('matches the SHA-256 test vector', async () => {
        expect(await sha256Hex(encode('abc')))
            .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('returns rejections instead of throwing', async () => {
        const verdict = await analyzeFile({ bytes: new Uint8Array(0), name: 'empty.csv' });
        expect(verdict).toMatchObject({ ok: false, code: 'EMPTY_FILE' });
    });

    it('warns about a hash seen before, whatever shape the lookup takes', () => {
        const hash = 'a'.repeat(64);
        expect(hashWarning(hash, null)).toBeNull();
        expect(hashWarning(hash, new Map([[hash, '2026-10-01T09:00:00Z']]))).toEqual({
            code: 'FILE_SEEN_BEFORE',
            params: { date: '2026-10-01' },
        });
        expect(hashWarning(hash, [{ sha256: hash, date: '2026-09-30' }])).toEqual({
            code: 'FILE_SEEN_BEFORE',
            params: { date: '2026-09-30' },
        });
        expect(hashWarning(hash, { [hash]: { date: '2026-09-30T12:00:00Z' } })).toEqual({
            code: 'FILE_SEEN_BEFORE',
            params: { date: '2026-09-30' },
        });
        expect(hashWarning(hash, new Map([['other', '2026-10-01']]))).toBeNull();
    });

    it('formats sizes for messages', () => {
        expect(formatBytes(8 * 1024 * 1024)).toBe('8 MB');
        expect(formatBytes(512 * 1024)).toBe('512 KB');
        expect(formatBytes(1536)).toBe('1.5 KB');
    });
});

describe('text-like detection', () => {
    it('accepts UTF-8 and Windows-1256 text', () => {
        expect(isTextLike(bytesOf('arabic.csv'))).toBe(true);
        expect(isTextLike(bytesOf('legacy-1256.csv'))).toBe(true);
        expect(isTextLike(encode('plain\ttabbed\r\nline'))).toBe(true);
    });

    it('rejects bytes with control characters', () => {
        expect(isTextLike(Uint8Array.of(0x61, 0x00, 0x62))).toBe(false);
        expect(isTextLike(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x1a, 0x0a))).toBe(false);
    });
});
