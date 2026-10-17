// Reader rejection: a typed error every reader can throw when a file must be
// refused after it was already accepted at intake (spec §5.2 — password-
// protected, corrupt or oversized content). `readFile` in ./index.js turns
// these into `{ ok: false, code, params }` results; nothing else is thrown to
// the caller.

export class ReaderReject extends Error {
    /**
     * @param {string} code message code, e.g. `PDF_ENCRYPTED`
     * @param {Record<string, unknown>} [params] message placeholders
     */
    constructor(code, params = {}) {
        super(`Reader rejected the file: ${code}`);
        this.name = 'ReaderReject';
        this.code = code;
        this.params = params;
    }
}

/** Shorthand used by the readers. */
export function readerReject(code, params = {}) {
    return new ReaderReject(code, params);
}
