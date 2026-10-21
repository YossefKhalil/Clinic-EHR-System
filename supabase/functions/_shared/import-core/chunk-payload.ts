// The shape of a chunk payload the server accepts.
//
// The server validates every chunk the browser sends, because the payload is
// written to the database as-is. A text chunk carries lines; a photo of a
// note (spec §5.4) carries image tiles instead - it has no text lines at
// all, and a validator that only knows lines rejects it as malformed.

export interface ChunkLine {
    id: string;
    text: string;
}

export interface ChunkImage {
    id: string;
    dataUrl: string;
}

export interface ChunkPayload {
    kind?: string;
    lines?: ChunkLine[];
    images?: ChunkImage[];
    [key: string]: unknown;
}

/** True when the payload is a chunk the server may store. */
export function isValidChunkPayload(payload: unknown): payload is ChunkPayload {
    const chunk = payload as { kind?: unknown; lines?: unknown; images?: unknown } | null;
    if (!chunk) return false;

    if (chunk.kind === 'image') {
        if (!Array.isArray(chunk.images) || chunk.images.length === 0) return false;
        return chunk.images.every((image) => {
            const entry = image as { id?: unknown; dataUrl?: unknown };
            return entry
                && typeof entry.id === 'string'
                && typeof entry.dataUrl === 'string'
                && entry.dataUrl.startsWith('data:image/');
        });
    }

    if (!Array.isArray(chunk.lines) || chunk.lines.length === 0) return false;
    return chunk.lines.every((line) => {
        const entry = line as { id?: unknown; text?: unknown };
        return entry && typeof entry.id === 'string' && typeof entry.text === 'string';
    });
}
