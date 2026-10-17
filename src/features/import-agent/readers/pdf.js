// PDF reader (spec §5.4) — text layer only in this milestone. pdf.js
// (lazy-loaded, §14.5) extracts each page's text; pages without a usable text
// layer are skipped with a warning (the 2× rasterize → image reader fallback
// arrives with the vision milestone). The right-to-left sanity check flags
// pages whose Arabic looks reversed in the text layer — those keep their text
// but say so, until vision can re-read them.
//
// Every extracted line keeps a `L###` id and pages are separated by an empty
// line, which the chunker treats as a record boundary.

import { LIMITS } from '@import-core/limits.js';
import { foldForMatch } from '@import-core/canonicalize.js';
import { readerReject } from './reader-error.js';

let pdfjsPromise = null;

/**
 * Lazy-load pdf.js. The legacy build runs both in browsers and in Node
 * (pdf.js refuses its modern build outside the browser; tests run in Node),
 * so one code path serves both.
 *
 * In the browser, pdf.js falls back to a relative `./pdf.worker.mjs` URL that
 * a bundler never emits; point it at the copy Vite does emit instead. Node
 * uses pdf.js's built-in fake worker, so the asset pipeline stays out of the
 * test path.
 */
function loadPdfjs() {
    pdfjsPromise ||= (async () => {
        const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
        if (globalThis.window !== undefined) {
            const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url');
            mod.GlobalWorkerOptions.workerSrc = worker.default;
        }
        return mod;
    })();
    return pdfjsPromise;
}

// A page is text-bearing when it has ≥ 40 characters and < 5% replacement or
// private-use characters (spec §5.4).
const MIN_PAGE_CHARS = 40;
const MAX_REPLACEMENT_RATIO = 0.05;

// Small dictionary of common clinic words and name fragments (spec §5.4):
// a reversed tag like "دمحم" (محمد reversed), folded and reversed again,
// matches the dictionary and counts as a reversal hit.
const RTL_WORDS = [
    'محمد', 'احمد', 'محمود', 'علي', 'حسن', 'حسين', 'إبراهيم', 'ابراهيم',
    'السيد', 'سيد', 'عبدالله', 'عبد', 'الرحمن', 'رحمن', 'مصطفى', 'خالد',
    'رمضان', 'سعيد', 'سمير', 'سميرة', 'فاطمة', 'مريم', 'هدى', 'نور',
    'ياسمين', 'سارة', 'منى', 'أمل', 'آمال', 'شيماء', 'دعاء', 'رانيا',
    'هالة', 'نهى', 'عبير', 'سناء', 'إيمان', 'سلمى', 'جمال', 'كمال',
    'صابر', 'طارق', 'أشرف', 'شريف', 'مدحت', 'مجدي', 'عادل', 'سامي',
    'هاني', 'وليد', 'يوسف', 'زكريا', 'مروان', 'رامي', 'كريم', 'باسم',
    'تامر', 'أميرة', 'آية', 'حبيبة', 'ندى', 'ريم', 'فرح', 'حنان',
    'هبة', 'عزة', 'نجلاء', 'وفاء', 'سهام', 'عفاف', 'زينب', 'رقية',
    'أسماء', 'صفاء', 'عيادة', 'كشف', 'مريض', 'عنوان', 'ملاحظات',
    'تليفون', 'موبايل', 'الرقم', 'القومي', 'الدقهلية', 'القاهرة',
    'الإسكندرية', 'الجيزة', 'متابعة',
];
const RTL_FOLDED = new Set(RTL_WORDS.map((word) => foldForMatch(word)));

const ARABIC_TOKEN = /^[\u0621-\u064A\u0671-\u06D3]+$/;

/** How many tokens of `text` look like reversed dictionary words. */
export function reversedArabicHits(text) {
    let hits = 0;
    for (const token of String(text ?? '').split(/[^\u0621-\u06FF]+/)) {
        if (token.length < 3 || !ARABIC_TOKEN.test(token)) continue;
        const reversed = [...token].reverse().join('');
        if (RTL_FOLDED.has(foldForMatch(reversed))) hits += 1;
    }
    return hits;
}

/** Page-level RTL verdict (spec §5.4). */
export function isRtlSuspect(text, { minHits = 2 } = {}) {
    return reversedArabicHits(text) >= minHits;
}

function isTextBearing(pageText) {
    const chars = pageText.replace(/\s+/g, '').length;
    if (chars < MIN_PAGE_CHARS) return false;
    const bad = (pageText.match(/[\uFFFD\uE000-\uF8FF]/g) || []).length;
    return bad / chars < MAX_REPLACEMENT_RATIO;
}

/**
 * Join helper: pdf.js merges contiguous text on a line into one item, so a
 * second item on the same baseline usually marks a gap (a space). One space is
 * inserted unless the text already provides the whitespace.
 */
function needsSpace(current, str) {
    return current !== '' && str !== '' && !/\s$/.test(current) && !/^\s/.test(str);
}

/**
 * Group pdf.js text items into visual lines. pdf.js reports `hasEOL` on items
 * that end a line; a baseline change also starts a new line.
 */
export function reconstructLines(items) {
    const lines = [];
    let current = '';
    let lastY = null;
    const flush = () => {
        const text = current.replace(/\s+$/, '');
        if (text !== '') lines.push(text);
        current = '';
        lastY = null;
    };

    for (const item of items) {
        const str = item.str ?? '';
        const y = item.transform?.[5] ?? null;
        if (y !== null && lastY !== null && Math.abs(y - lastY) > 2) flush();
        if (item.hasEOL) {
            if (needsSpace(current, str)) current += ' ';
            current += str;
            flush();
            continue;
        }
        if (needsSpace(current, str)) current += ' ';
        current += str;
        if (y !== null) lastY = y;
    }
    flush();
    return lines;
}

/**
 * Read the text layer of a PDF into one `text` source.
 *
 * @param {Uint8Array} bytes
 * @param {{ name: string, limits?: typeof LIMITS, pdfjs?: object }} options
 *   `pdfjs` injects a module for tests; the app lazy-loads `pdfjs-dist`.
 */
export async function readPdf(bytes, { name, limits = LIMITS, pdfjs = null } = {}) {
    const mod = pdfjs || await loadPdfjs();

    const loadingTask = mod.getDocument({
        // pdf.js transfers the buffer to its worker (detaching it), so it gets
        // a copy — the caller's bytes stay reusable.
        data: bytes.slice(),
        // No PDF-JS in our data; keep evaluation off (spec §13 hardening).
        isEvalSupported: false,
    });

    let doc;
    try {
        doc = await loadingTask.promise;
    } catch (error) {
        if (error?.name === 'PasswordException') throw readerReject('PDF_ENCRYPTED', { name });
        throw readerReject('PDF_UNREADABLE', { name });
    }

    try {
        if (doc.numPages > limits.MAX_PDF_PAGES) {
            throw readerReject('PDF_TOO_MANY_PAGES', { pages: doc.numPages, limit: limits.MAX_PDF_PAGES });
        }

        const warnings = [];
        const lines = [];
        const skippedPages = [];
        const rtlPages = [];
        let nextId = 1;

        for (let number = 1; number <= doc.numPages; number += 1) {
            const page = await doc.getPage(number);
            const content = await page.getTextContent();
            const pageLines = reconstructLines(content.items || []);
            const pageText = pageLines.join('\n');
            page.cleanup?.();

            if (!isTextBearing(pageText)) {
                // No usable text layer — the image fallback reads it later.
                skippedPages.push(number);
                warnings.push({ code: 'PDF_PAGE_NO_TEXT', params: { page: number } });
                continue;
            }
            if (isRtlSuspect(pageText)) {
                rtlPages.push(number);
                warnings.push({ code: 'RTL_SUSPECT', params: { page: number } });
            }

            if (lines.length > 0) {
                lines.push({ id: `L${String(nextId).padStart(3, '0')}`, text: '' });
                nextId += 1;
            }
            for (const text of pageLines) {
                lines.push({ id: `L${String(nextId).padStart(3, '0')}`, text });
                nextId += 1;
            }
        }

        return {
            sources: [{
                kind: 'pdf',
                name,
                layout: 'text',
                header: null,
                lines,
                meta: {
                    file: name,
                    pageCount: doc.numPages,
                    skippedPages,
                    rtlPages,
                },
                warnings,
                stats: { lines: lines.length },
            }],
            warnings: [],
        };
    } finally {
        await loadingTask.destroy?.().catch?.(() => {});
    }
}
