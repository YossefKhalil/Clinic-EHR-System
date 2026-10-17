// Intake validation (spec §5.2–5.3): the fast gate in front of the readers.
//
// The browser runs this for immediate feedback and the functions re-run the
// same checks as the real gate. It rejects empty files, oversized files,
// unsupported content, legacy `.doc`, encrypted PDFs and zip bombs — every
// rejection carries a message code and its parameters. Accepted files get a
// SHA-256 so a file imported before can be flagged (spec §5.2).

import { LIMITS } from '@import-core/limits.js';
import { asciiIndexOf, isZipBomb, sniffKind } from './readers/index.js';

/** Human size for message parameters, e.g. `8 MB`. */
export function formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
    const kb = bytes / 1024;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
}

/**
 * Check one file at intake.
 *
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {typeof LIMITS} [limits]
 * @returns {{ ok: true, kind: string, detail?: string }
 *   | { ok: false, code: string, params: object }}
 */
export function validateIntake(bytes, name, limits = LIMITS) {
    if (bytes.length === 0) return { ok: false, code: 'EMPTY_FILE', params: { name } };
    if (bytes.length > limits.MAX_FILE_BYTES) {
        return {
            ok: false,
            code: 'FILE_TOO_LARGE',
            params: { name, limit: formatBytes(limits.MAX_FILE_BYTES), size: formatBytes(bytes.length) },
        };
    }

    const sniffed = sniffKind(bytes);
    switch (sniffed.kind) {
        case 'xlsx':
        case 'docx':
            if (isZipBomb(sniffed.zip, limits)) {
                return {
                    ok: false,
                    code: 'ZIP_BOMB',
                    params: { name, limitMb: formatBytes(limits.MAX_ZIP_UNCOMPRESSED_BYTES) },
                };
            }
            return { ok: true, kind: sniffed.kind };
        case 'xls':
            return { ok: true, kind: 'xls' };
        case 'pdf':
            if (asciiIndexOf(bytes, '/Encrypt') !== -1) {
                return { ok: false, code: 'PDF_ENCRYPTED', params: { name } };
            }
            return { ok: true, kind: 'pdf' };
        case 'image':
            return { ok: true, kind: 'image', detail: sniffed.detail };
        case 'text':
            return { ok: true, kind: 'text' };
        case 'doc':
            return { ok: false, code: 'DOC_LEGACY', params: { name } };
        case 'zip':
            return sniffed.detail === 'unreadable'
                ? { ok: false, code: 'ZIP_UNREADABLE', params: { name } }
                : { ok: false, code: 'UNSUPPORTED_TYPE', params: { name } };
        default:
            return { ok: false, code: 'UNSUPPORTED_TYPE', params: { name } };
    }
}

/** SHA-256 of the file, lowercase hex (spec §5.2 "same file uploaded again"). */
export async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate + hash one file. This is what the wizard calls when a file is
 * added, before the preview step.
 */
export async function analyzeFile({ bytes, name, limits = LIMITS }) {
    const verdict = validateIntake(bytes, name, limits);
    if (!verdict.ok) return verdict;
    const sha256 = await sha256Hex(bytes);
    return { ok: true, kind: verdict.kind, detail: verdict.detail, sha256, size: bytes.length };
}

/**
 * Warning shown when the same file hash was imported before. `seen` accepts
 * a Map, an array of `{ sha256, date }` or a plain object keyed by hash — as
 * long as it can be answered from the data the caller already has (usually a
 * query over `import_sources.sha256`).
 */
export function hashWarning(sha256, seen) {
    let date = null;
    if (seen instanceof Map) {
        const value = seen.get(sha256);
        date = typeof value === 'string' ? value : value?.date ?? null;
    } else if (Array.isArray(seen)) {
        const hit = seen.find((entry) => entry.sha256 === sha256);
        date = hit?.date ?? hit?.imported_at ?? null;
    } else if (seen && typeof seen === 'object') {
        const value = seen[sha256];
        date = typeof value === 'string' ? value : value?.date ?? null;
    }
    if (!date) return null;
    return { code: 'FILE_SEEN_BEFORE', params: { date: String(date).slice(0, 10) } };
}
