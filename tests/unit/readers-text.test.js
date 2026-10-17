// M3: text-like readers — encodings, delimiter sniffing, CSV parsing and
// typed text (spec §5.4, §15).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    decodeBytes,
    parseDelimited,
    readDelimitedFile,
    readTextFile,
    sniffDelimiter,
    textToLines,
} from '../../src/features/import-agent/readers/text.js';
import { readPastedText } from '../../src/features/import-agent/readers/index.js';

const bytesOf = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/readers/${name}`, import.meta.url)));

describe('decodeBytes', () => {
    it('reads UTF-8 with and without a BOM', () => {
        expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ text: 'a', encoding: 'utf-8' });
        expect(decodeBytes(new TextEncoder().encode('مرحبا'))).toEqual({ text: 'مرحبا', encoding: 'utf-8' });
    });

    it('falls back to Windows-1256 and reports it', () => {
        // 0xC7 0xCD 0xE3 0xCF = احمد in Windows-1256
        const result = decodeBytes(new Uint8Array([0xc7, 0xcd, 0xe3, 0xcf]));
        expect(result.encoding).toBe('windows-1256');
        expect(result.fallback).toBe(true);
        expect(result.text).toBe('احمد');
    });

    it('reads UTF-16 BOMs', () => {
        const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
        expect(decodeBytes(bytes)).toEqual({ text: 'hi', encoding: 'utf-16le' });
    });
});

describe('parseDelimited', () => {
    it('keeps quoted fields, escaped quotes and quoted newlines', () => {
        const text = 'a,b\n"x,1","line1\nline2"\n"he said ""hi""",z';
        const { rows, rowNumbers } = parseDelimited(text, ',');
        expect(rows).toEqual([['a', 'b'], ['x,1', 'line1\nline2'], ['he said "hi"', 'z']]);
        expect(rowNumbers).toEqual([1, 2, 4]);
    });

    it('treats CRLF as one line break', () => {
        const { rows, rowNumbers } = parseDelimited('a;b\r\nc;d\r\n', ';');
        expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
        expect(rowNumbers).toEqual([1, 2]);
    });
});

describe('sniffDelimiter', () => {
    it('picks the consistent delimiter', () => {
        expect(sniffDelimiter('a,b\n1,2\n3,4')).toBe(',');
        expect(sniffDelimiter('a;b\n1;2\n3;4')).toBe(';');
        expect(sniffDelimiter('a\tb\n1\t2\n3\t4')).toBe('\t');
    });

    it('returns null when nothing is consistent', () => {
        expect(sniffDelimiter('just prose\nwith no columns')).toBeNull();
        expect(sniffDelimiter('a,b\n1')).toBeNull();
    });

    it('prefers the delimiter that yields the most columns', () => {
        expect(sniffDelimiter('name;a,b;c\nx;1,2;3')).toBe(';');
    });
});

describe('textToLines', () => {
    it('assigns stable ids and drops the artifact of a trailing newline', () => {
        expect(textToLines('one\ntwo\n')).toEqual([
            { id: 'L001', text: 'one' },
            { id: 'L002', text: 'two' },
        ]);
        expect(textToLines('one\n\ntwo')).toEqual([
            { id: 'L001', text: 'one' },
            { id: 'L002', text: '' },
            { id: 'L003', text: 'two' },
        ]);
    });
});

describe('readDelimitedFile', () => {
    it('reads a UTF-8 BOM CSV with quotes and Arabic', () => {
        const { sources, warnings } = readDelimitedFile(bytesOf('arabic.csv'), { name: 'arabic.csv' });
        expect(warnings).toEqual([]);
        const source = sources[0];
        expect(source.kind).toBe('sheet');
        expect(source.meta).toEqual({ file: 'arabic.csv', encoding: 'utf-8', delimiter: ',' });
        expect(source.header.cells).toEqual(['الاسم', 'الرقم القومي', 'الموبايل', 'ملاحظات']);
        expect(source.lines.map((l) => l.id)).toEqual(['R2', 'R4']);
        expect(source.lines[0].cells).toEqual([
            'سارة عبد الرحمن',
            '29903220201567',
            '01223344556',
            'حساسية من البنسلين,\nمتابعة كل شهر',
        ]);
        // Record R4 keeps the trailing empty column trimmed away.
        expect(source.lines[1].cells).toEqual(['خالد إبراهيم', '3050101010101', '1012345679']);
    });

    it('reads a Windows-1256 file and says so', () => {
        const { sources, warnings } = readDelimitedFile(bytesOf('legacy-1256.csv'), { name: 'legacy-1256.csv' });
        expect(warnings).toEqual([{ code: 'CSV_ENCODING', params: { encoding: 'windows-1256' } }]);
        const source = sources[0];
        expect(source.meta.delimiter).toBe(';');
        expect(source.header.cells).toEqual(['الاسم', 'الرقم القومي', 'الموبايل', 'المحافظة']);
        expect(source.lines.map((l) => l.text)).toEqual([
            'أحمد محمود السيد | 29805151201234 | 01012345678 | الدقهلية',
            'منى حسن على | 29903220201567 | 01112345678 | القاهرة',
        ]);
    });

    it('falls back to plain text when there are no columns', () => {
        const { sources } = readDelimitedFile(bytesOf('single-column.csv'), { name: 'single-column.csv' });
        const source = sources[0];
        expect(source.kind).toBe('text');
        expect(source.warnings).toEqual([{ code: 'CSV_AS_TEXT', params: {} }]);
        expect(source.lines.map((l) => l.text)).toEqual(['ملاحظات العيادة', 'حساسية من البنسلين', 'متابعة كل شهر']);
    });
});

describe('readTextFile and pasted text', () => {
    it('reads a .txt file as typed lines', () => {
        const { sources, warnings } = readTextFile(bytesOf('announcement.txt'), { name: 'announcement.txt' });
        expect(warnings).toEqual([]);
        expect(sources[0].kind).toBe('text');
        expect(sources[0].lines).toHaveLength(3);
        expect(sources[0].lines[0].text).toBe('---- العيادة مغلقة الجمعة القادمة ----');
    });

    it('reads pasted text', () => {
        const result = readPastedText('مريض 1: احمد\nمريض 2: منى');
        expect(result.ok).toBe(true);
        expect(result.sources[0].name).toBe('Typed text');
        expect(result.sources[0].lines.map((l) => l.id)).toEqual(['L001', 'L002']);
    });
});
