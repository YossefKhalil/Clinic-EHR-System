// The chunk payload the server accepts (the rule that rejected every photo
// of a note as "malformed" until it knew about image chunks).

import { describe, expect, it } from 'vitest';
import { isValidChunkPayload } from '@import-core/chunk-payload.ts';

describe('the chunk payload rule', () => {
    it('accepts a text chunk', () => {
        expect(isValidChunkPayload({
            kind: 'text',
            lines: [{ id: 'S1:L001', text: 'Fatma | 28811220501187' }],
        })).toBe(true);
        expect(isValidChunkPayload({
            kind: 'sheet',
            lines: [{ id: 'S1:R2', text: 'S1:R2 | Fatma | 28811220501187' }],
        })).toBe(true);
    });

    it('accepts an image chunk (a photo of a note has no text lines)', () => {
        expect(isValidChunkPayload({
            kind: 'image',
            lines: [],
            images: [{ id: 'img-1', dataUrl: 'data:image/jpeg;base64,AAA' }],
        })).toBe(true);
    });

    it('rejects a chunk with neither lines nor images', () => {
        expect(isValidChunkPayload({ kind: 'text', lines: [] })).toBe(false);
        expect(isValidChunkPayload({ kind: 'image', lines: [], images: [] })).toBe(false);
        expect(isValidChunkPayload(null)).toBe(false);
    });

    it('rejects an image chunk whose tile is not an image', () => {
        expect(isValidChunkPayload({
            kind: 'image',
            images: [{ id: 'img-1', dataUrl: 'data:text/plain;base64,AAA' }],
        })).toBe(false);
        expect(isValidChunkPayload({
            kind: 'image',
            images: [{ id: 'img-1' }],
        })).toBe(false);
    });
});
