// Content sniffing and reader dispatch (spec §5.2, §5.4).
//
// The type is decided by CONTENT, never by extension: ZIP signatures plus the
// part names inside decide xlsx/docx, the OLE2 signature decides xls/doc,
// `%PDF-` decides pdf, image signatures decide image formats, and everything
// else that has only text-like bytes is text. Anything else is rejected at
// intake — there is no fall-through to "treat as text".
//
// The ZIP-bomb guard reads only the central directory (no decompression): a
// container is refused when the declared uncompressed size exceeds 100 MB or
// 50× the compressed size (spec §5.2).

import { LIMITS } from '@import-core/limits.js';
import { ReaderReject, readerReject } from './reader-error.js';
import { readWorkbook } from './spreadsheet.js';
import { readDelimitedFile, readTextFile, readTypedText } from './text.js';
import { readDocx } from './docx.js';
import { readPdf } from './pdf.js';
import { readImageSource } from './image.js';

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EOCD_SIG = [0x50, 0x4b, 0x05, 0x06];
const ZIP_SPANNED_SIG = [0x50, 0x4b, 0x07, 0x08];
const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function startsWith(bytes, signature, offset = 0) {
    if (bytes.length < offset + signature.length) return false;
    return signature.every((byte, i) => bytes[offset + i] === byte);
}

/** ASCII read at an offset (signatures are ASCII). */
function asciiAt(bytes, offset, length) {
    if (bytes.length < offset + length) return '';
    let out = '';
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
    return out;
}

function indexOfBytes(haystack, needle) {
    outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
        if (haystack[i] !== needle[0]) continue;
        for (let j = 1; j < needle.length; j += 1) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

/** Index of an ASCII needle in bytes (for cheap content probes). */
export function asciiIndexOf(bytes, text) {
    const needle = Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));
    return indexOfBytes(bytes, needle);
}

// ---------------------------------------------------------------------------
// ZIP central directory
// ---------------------------------------------------------------------------

const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * Read a ZIP's central directory without decompressing anything. Returns
 * `null` for malformed archives and zip64 containers (which cannot appear
 * under the 8 MB file limit anyway).
 */
export function readZipIndex(bytes) {
    if (bytes.length < 22) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let eocd = -1;
    const minEocd = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= minEocd; i -= 1) {
        if (view.getUint32(i, true) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) return null;

    const count = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) return null; // zip64

    const entries = [];
    let totalUncompressed = 0;
    let totalCompressed = 0;
    let pos = cdOffset;
    for (let i = 0; i < count; i += 1) {
        if (pos + 46 > bytes.length || view.getUint32(pos, true) !== CDH_SIG) return null;
        const compressed = view.getUint32(pos + 20, true);
        const uncompressed = view.getUint32(pos + 24, true);
        const nameLen = view.getUint16(pos + 28, true);
        const extraLen = view.getUint16(pos + 30, true);
        const commentLen = view.getUint16(pos + 32, true);
        if (compressed === 0xffffffff || uncompressed === 0xffffffff) return null; // zip64
        const name = new TextDecoder('utf-8').decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
        entries.push({ name, compressed, uncompressed });
        totalUncompressed += uncompressed;
        totalCompressed += compressed;
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, totalUncompressed, totalCompressed };
}

/** True when the declared sizes break the zip-bomb guard (spec §5.2). */
export function isZipBomb(index, limits = LIMITS) {
    if (index.totalUncompressed > limits.MAX_ZIP_UNCOMPRESSED_BYTES) return true;
    return index.totalCompressed > 0
        && index.totalUncompressed > index.totalCompressed * limits.MAX_ZIP_RATIO;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

function utf16leBytes(name) {
    const out = new Uint8Array(name.length * 2);
    for (let i = 0; i < name.length; i += 1) {
        out[i * 2] = name.charCodeAt(i);
        out[i * 2 + 1] = 0;
    }
    return out;
}

const OLE_WORKBOOK = utf16leBytes('Workbook');
const OLE_BOOK = utf16leBytes('Book');
const OLE_WORD = utf16leBytes('WordDocument');

/** OLE2 stream names decide xls vs doc (a Word file must be saved as .docx). */
function oleStreamKind(bytes) {
    if (indexOfBytes(bytes, OLE_WORD) !== -1) return 'doc';
    if (indexOfBytes(bytes, OLE_WORKBOOK) !== -1) return 'xls';
    if (indexOfBytes(bytes, OLE_BOOK) !== -1) return 'xls';
    return null;
}

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];

function sniffImage(bytes) {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (asciiAt(bytes, 0, 4) === 'GIF8') return 'gif';
    if (startsWith(bytes, [0x42, 0x4d])) return 'bmp';
    if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'webp';
    if (asciiAt(bytes, 4, 4) === 'ftyp' && HEIF_BRANDS.includes(asciiAt(bytes, 8, 4))) return 'heic';
    return null;
}

/** Text-like bytes: no control characters except tab, newline and return. */
export function isTextLike(bytes) {
    const sample = bytes.subarray(0, 8192);
    for (const byte of sample) {
        if (byte === 9 || byte === 10 || byte === 13 || byte >= 32) continue;
        return false;
    }
    return true;
}

/**
 * Decide the content type of a byte string (spec §5.2).
 *
 * @returns {{ kind: 'xlsx'|'xls'|'docx'|'doc'|'pdf'|'image'|'text'|'zip'|'ole'|'unknown',
 *             detail?: string, zip?: object }}
 */
export function sniffKind(bytes) {
    if (startsWith(bytes, ZIP_SIG) || startsWith(bytes, ZIP_EOCD_SIG) || startsWith(bytes, ZIP_SPANNED_SIG)) {
        const index = readZipIndex(bytes);
        if (!index) return { kind: 'zip', detail: 'unreadable' };
        const names = new Set(index.entries.map((entry) => entry.name));
        if (names.has('xl/workbook.xml')) return { kind: 'xlsx', zip: index };
        if (names.has('word/document.xml')) return { kind: 'docx', zip: index };
        return { kind: 'zip', detail: 'unknown' };
    }
    if (startsWith(bytes, OLE_SIG)) {
        const ole = oleStreamKind(bytes);
        if (ole) return { kind: ole };
        return { kind: 'ole' };
    }
    if (startsWith(bytes, PDF_SIG)) return { kind: 'pdf' };
    const image = sniffImage(bytes);
    if (image) return { kind: 'image', detail: image };
    if (isTextLike(bytes)) return { kind: 'text' };
    return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function isDelimitedName(name) {
    return /\.(csv|tsv)$/i.test(name || '');
}

/**
 * Read an accepted file into sources (spec §5.4). A reader may still reject
 * the file (password-protected, corrupt, too many PDF pages) — those come
 * back as `{ ok: false, code, params }`, never as thrown errors.
 *
 * @param {{
 *   bytes: Uint8Array,
 *   name: string,
 *   limits?: typeof LIMITS,
 *   maxRows?: number,                      // remaining job row budget
 *   includeHiddenSheets?: string[],
 *   pdfjs?: object,                        // test injection for pdf.js
 * }} input
 * @returns {Promise<{ ok: true, kind: string, sources: object[], warnings: object[] }
 *   | { ok: false, code: string, params: object }>}
 */
export async function readFile({
    bytes,
    name,
    limits = LIMITS,
    maxRows = limits.MAX_ROWS,
    includeHiddenSheets = [],
    pdfjs = null,
}) {
    const sniffed = sniffKind(bytes);
    try {
        let result;
        switch (sniffed.kind) {
            case 'xlsx':
            case 'xls':
                result = await readWorkbook(bytes, { name, limits, maxRows, includeHiddenSheets });
                break;
            case 'docx':
                result = await readDocx(bytes, { name, limits, maxRows });
                break;
            case 'pdf':
                result = await readPdf(bytes, { name, limits, pdfjs });
                break;
            case 'image': {
                const { source } = readImageSource({ name, meta: { file: name, format: sniffed.detail } });
                result = { sources: [source], warnings: [] };
                break;
            }
            case 'text':
                result = isDelimitedName(name)
                    ? readDelimitedFile(bytes, { name, limits, maxRows })
                    : readTextFile(bytes, { name, limits });
                break;
            case 'doc':
                throw readerReject('DOC_LEGACY', { name });
            default:
                throw readerReject('UNSUPPORTED_TYPE', { name });
        }

        const warnings = [...result.warnings];
        const totalLines = result.sources.reduce((sum, source) => sum + source.lines.length, 0);
        const imagesOnly = result.sources.length > 0
            && result.sources.every((source) => source.kind === 'image');
        if (totalLines === 0 && !imagesOnly) warnings.push({ code: 'NO_TEXT', params: { name } });

        return { ok: true, kind: sniffed.kind, sources: result.sources, warnings };
    } catch (error) {
        if (error instanceof ReaderReject) {
            return { ok: false, code: error.code, params: error.params };
        }
        throw error;
    }
}

/** Pasted text is one `Typed text` source (spec §5.4). */
export function readPastedText(text, name = 'Typed text') {
    const source = readTypedText(text, { name, kind: 'text', meta: { typed: true } });
    return { ok: true, kind: 'text', sources: [source], warnings: [] };
}
