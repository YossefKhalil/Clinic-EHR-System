// M3: PDF reader — text layer only, page checks, the RTL sanity check and the
// page-limit rejection (spec §5.4, §15).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    isRtlSuspect,
    readPdf,
    reconstructLines,
    reversedArabicHits,
} from '../../src/features/import-agent/readers/pdf.js';
import { readFile } from '../../src/features/import-agent/readers/index.js';

const bytesOf = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/readers/${name}`, import.meta.url)));
const item = (str, y, hasEOL = false) => ({ str, transform: [1, 0, 0, 1, 72, y], hasEOL });

describe('reconstructLines', () => {
    it('joins items on one baseline and breaks on hasEOL or a baseline jump', () => {
        expect(reconstructLines([
            item('Hello', 760),
            item('world', 760, true),
            item('Next', 746),
        ])).toEqual(['Hello world', 'Next']);

        expect(reconstructLines([
            item('Above', 760),
            item('Below', 740),
        ])).toEqual(['Above', 'Below']);
    });

    it('is stable for empty input', () => {
        expect(reconstructLines([])).toEqual([]);
    });
});

describe('RTL sanity check', () => {
    it('counts reversed dictionary words', () => {
        expect(reversedArabicHits('محمد علي حسن')).toBe(0);
        expect(reversedArabicHits('دمحم يلع')).toBe(2); // محمد علي reversed
        expect(reversedArabicHits('Patients October دمحم')).toBe(1);
    });

    it('flags a page with two or more hits', () => {
        expect(isRtlSuspect('دمحم نسح')).toBe(true);
        expect(isRtlSuspect('محمد دحمأ')).toBe(false); // only one reversed word
        expect(isRtlSuspect('plain ascii text')).toBe(false);
    });
});

describe('readPdf on notes.pdf', () => {
    it('reads text pages into lines, separates pages and reports the empty one', async () => {
        const { sources, warnings } = await readPdf(bytesOf('notes.pdf'), { name: 'notes.pdf' });
        expect(warnings).toEqual([]);
        const source = sources[0];
        expect(source).toMatchObject({ kind: 'pdf', layout: 'text', name: 'notes.pdf' });
        expect(source.lines.map((l) => l.id)).toEqual(['L001', 'L002', 'L003', 'L004', 'L005', 'L006']);
        expect(source.lines[0].text).toBe('Patients October');
        expect(source.lines[1].text).toBe('Ahmed 29805151201234 01012345678');
        expect(source.lines[3].text).toBe(''); // page separator
        expect(source.lines[5].text).toBe('Nour El-Din 28512230101234 0123456789');
        expect(source.meta).toEqual({
            file: 'notes.pdf',
            pageCount: 3,
            skippedPages: [2],
            rtlPages: [],
        });
        expect(source.warnings).toEqual([{ code: 'PDF_PAGE_NO_TEXT', params: { page: 2 } }]);
    });

    it('rejects a PDF with too many pages through readFile', async () => {
        const result = await readFile({ bytes: bytesOf('long.pdf'), name: 'long.pdf' });
        expect(result).toEqual({ ok: false, code: 'PDF_TOO_MANY_PAGES', params: { pages: 21, limit: 20 } });
    });

    it('maps unreadable PDFs to a clear rejection', async () => {
        const broken = new TextEncoder().encode('%PDF-1.7\nthis is not a pdf at all');
        const result = await readFile({ bytes: broken, name: 'broken.pdf' });
        expect(result).toEqual({ ok: false, code: 'PDF_UNREADABLE', params: { name: 'broken.pdf' } });
    });
});
