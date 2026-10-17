// DOCX reader (spec §5.4): mammoth (lazy-loaded) converts the document to
// HTML, which is then turned into lines: headings and paragraphs one line
// each, list items prefixed `- `, tables pipe-separated rows treated like
// spreadsheet rows for chunking. Embedded images are ignored and the user is
// told; the accepted view of tracked changes is what mammoth reads.
//
// The HTML is parsed with a tiny scanner instead of the DOM so this module
// stays runnable without a browser (and in tests).

import { LIMITS } from '@import-core/limits.js';
import { collapseSpaces } from '@import-core/canonicalize.js';
import { readerReject } from './reader-error.js';
import { buildTableSource } from './table.js';

let mammothPromise = null;

/** Lazy-load mammoth (§14.5). */
function loadMammoth() {
    mammothPromise ||= import('mammoth');
    return mammothPromise;
}

const ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

/** Decode the entities mammoth can emit in text nodes. */
export function decodeEntities(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
        if (body[0] === '#') {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return ENTITIES[body.toLowerCase()] ?? match;
    });
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const HEADING = /^h[1-6]$/;

/**
 * Turn mammoth's HTML into blocks:
 * `{type:'text'|'heading'|'list', text}` and `{type:'table', rows: string[][]}`.
 * Images are dropped and counted.
 */
export function parseDocxHtml(html) {
    const blocks = [];
    const state = { text: '', table: null, row: null, inCell: false, images: 0 };
    let lastIndex = 0;

    const clean = (value) => collapseSpaces(value);
    const flushText = (type) => {
        const text = clean(state.text);
        state.text = '';
        if (text !== '') blocks.push({ type, text });
    };

    TAG.lastIndex = 0;
    let match;
    while ((match = TAG.exec(html)) !== null) {
        const between = html.slice(lastIndex, match.index);
        if (between) state.text += decodeEntities(between);
        lastIndex = TAG.lastIndex;

        const [, closing, rawTag] = match;
        const tag = rawTag.toLowerCase();
        const isClose = closing === '/';

        if (tag === 'img') {
            state.images += 1;
        } else if (tag === 'br') {
            state.text += ' ';
        } else if (tag === 'p') {
            // mammoth emits paragraphs inside table cells; those must stay in
            // the cell text instead of becoming blocks of their own.
            if (isClose) {
                if (state.inCell) state.text += ' ';
                else flushText('text');
            }
        } else if (HEADING.test(tag)) {
            if (isClose && !state.inCell) flushText('heading');
        } else if (tag === 'li') {
            if (isClose) {
                const text = clean(state.text);
                state.text = '';
                if (text !== '') blocks.push({ type: 'list', text: `- ${text}` });
            }
        } else if (tag === 'td' || tag === 'th') {
            if (!isClose) {
                state.inCell = true;
                state.text = '';
            } else {
                if (state.row) state.row.push(clean(state.text));
                state.text = '';
                state.inCell = false;
            }
        } else if (tag === 'tr') {
            if (isClose && state.table && state.row) state.table.push(state.row);
            state.row = isClose ? null : [];
        } else if (tag === 'table') {
            if (isClose && state.table) blocks.push({ type: 'table', rows: state.table });
            state.table = isClose ? null : [];
        }
    }
    const rest = html.slice(lastIndex);
    if (rest) state.text += decodeEntities(rest);
    flushText('text');

    return { blocks, images: state.images };
}

function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * mammoth's Node build reads `{buffer}` and its browser build reads
 * `{arrayBuffer}` (the package's `browser` field swaps the unzip module);
 * pass whichever fits the runtime.
 */
function mammothInput(bytes) {
    const NodeBuffer = globalThis.Buffer;
    if (typeof NodeBuffer !== 'undefined') {
        return { buffer: NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    }
    return { arrayBuffer: toArrayBuffer(bytes) };
}

/**
 * Read a `.docx` file into sources: alternating text segments (paragraphs,
 * headings, lists) and one source per table (rows layout, so tables chunk
 * like spreadsheet rows — spec §5.4).
 */
export async function readDocx(bytes, { name, limits = LIMITS, maxRows = limits.MAX_ROWS } = {}) {
    const mammoth = await loadMammoth();

    const images = [];
    let result;
    try {
        result = await mammoth.convertToHtml(
            mammothInput(bytes),
            {
                convertImage: mammoth.images.imgElement((image) => {
                    images.push(image.contentType || 'image');
                    return Promise.resolve({ src: 'import-agent:image' });
                }),
            },
        );
    } catch (error) {
        if (/password|encrypt/i.test(String(error?.message || error))) {
            throw readerReject('DOCX_ENCRYPTED', { name });
        }
        throw readerReject('DOCX_UNREADABLE', { name });
    }

    const { blocks, images: htmlImages } = parseDocxHtml(result.value ?? '');
    const imageCount = Math.max(images.length, htmlImages);
    const warnings = [];
    if (imageCount > 0) warnings.push({ code: 'DOCX_IMAGES_IGNORED', params: { count: imageCount } });
    if ((result.messages || []).length > 0) {
        warnings.push({ code: 'DOCX_WARNINGS', params: { count: result.messages.length } });
    }

    const sources = [];
    let textBuffer = [];
    let textSegments = 0;
    let tables = 0;
    let remaining = maxRows;

    const flushText = () => {
        if (textBuffer.length === 0) return;
        textSegments += 1;
        sources.push({
            kind: 'docx',
            name: textSegments === 1 ? name : `${name} › text ${textSegments}`,
            layout: 'text',
            header: null,
            lines: textBuffer,
            meta: { file: name },
            warnings: [],
            stats: { lines: textBuffer.length },
        });
        textBuffer = [];
    };

    for (const block of blocks) {
        if (block.type === 'table') {
            flushText();
            if (remaining <= 0 || block.rows.length === 0) continue;
            tables += 1;
            const { source } = buildTableSource({
                grid: block.rows,
                rowNumbers: block.rows.map((_, i) => i + 1),
                name: `${name} › table ${tables}`,
                kind: 'docx',
                maxRows: remaining,
                meta: { file: name, table: tables },
            });
            sources.push(source);
            remaining -= source.stats.dataRows;
            continue;
        }
        const id = `L${String(textBuffer.length + 1).padStart(3, '0')}`;
        textBuffer.push({ id, text: block.text });
    }
    flushText();

    return { sources, warnings };
}
