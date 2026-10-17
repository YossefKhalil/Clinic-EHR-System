// M3: pooling and chunking — ids and canonical copies, record boundaries,
// size targets, the no-boundary fallback with overlap, sheet chunks and the
// chunk cap (spec §6.2–6.4).
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@import-core/limits.js';
import {
    chunkPool,
    poolSources,
    prepareSources,
    splitRecords,
} from '../../src/features/import-agent/chunker.js';

const limit = (overrides) => ({ ...LIMITS, ...overrides });
const ln = (id, text) => ({ id, text });
const textSource = (lines, name = 'Typed text') => ({
    kind: 'text',
    layout: 'text',
    name,
    header: null,
    lines,
    meta: {},
    warnings: [],
    stats: { lines: lines.length },
});

describe('poolSources', () => {
    it('assigns S-ids and composes the lines the model will see', () => {
        const { sources } = poolSources([textSource([
            ln('L001', 'مريض 1: احمد'),
            ln('L002', ''),
            ln('L003', 'الرقم ٢٩٨٠٥١٥١٢٠١٢٣٤'),
        ])]);
        const [pooled] = sources;
        expect(pooled.id).toBe('S1');
        expect(pooled.lines[0]).toEqual({ id: 'S1:L001', text: 'S1:L001 | مريض 1: احمد' });
        expect(pooled.lines[1]).toEqual({ id: 'S1:L002', text: 'S1:L002', blank: true });
        // The canonical copy converts Arabic-Indic digits; the payload uses it.
        expect(pooled.lines[2].text).toBe('S1:L003 | الرقم ٢٩٨٠٥١٥١٢٠١٢٣٤');
        expect(pooled.lines[2].canonical).toBe('S1:L003 | الرقم 29805151201234');
    });

    it('pools a rows header like a line', () => {
        const rows = {
            kind: 'sheet',
            layout: 'rows',
            name: 'sheet',
            header: { id: 'R1', cells: ['Name', 'ID'], text: 'Name | ID' },
            lines: [{ id: 'R2', cells: ['a', 'b'], text: 'a | b' }],
            meta: {},
            warnings: [],
            stats: { dataRows: 1 },
        };
        const { sources } = poolSources([rows]);
        expect(sources[0].header).toEqual({ id: 'S1:R1', text: 'S1:R1 | Name | ID' });
        expect(sources[0].lines[0].id).toBe('S1:R2');
    });
});

describe('splitRecords (spec §6.2 boundaries)', () => {
    const recordTexts = (lines) => splitRecords(lines).map((record) => record.map((l) => l.id));

    it('breaks at blank lines', () => {
        expect(recordTexts([ln('a', 'one'), ln('b', ''), ln('c', 'two')])).toEqual([['a', 'b'], ['c']]);
    });

    it('breaks at numbered items', () => {
        expect(recordTexts([ln('a', 'notes'), ln('b', '2- Mona')])).toEqual([['a'], ['b']]);
        expect(recordTexts([ln('a', 'notes'), ln('b', 'مريض 3: سارة')])).toEqual([['a'], ['b']]);
    });

    it('breaks when a 14-digit id follows a line with one', () => {
        expect(recordTexts([ln('a', 'x 29805151201234'), ln('b', 'y 29903220201567')])).toEqual([['a'], ['b']]);
        expect(recordTexts([ln('a', 'no id here'), ln('b', 'y 29903220201567')])).toEqual([['a', 'b']]);
    });

    it('uses the canonical text so Arabic-Indic ids still split records', () => {
        const lines = [
            { id: 'a', text: 'x ٢٩٨٠٥١٥١٢٠١٢٣٤', canonical: 'a | x 29805151201234' },
            { id: 'b', text: 'y ٢٩٩٠٣٢٢٠٢٠١٥٦٧', canonical: 'b | y 29903220201567' },
        ];
        expect(recordTexts(lines)).toEqual([['a'], ['b']]);
    });
});

describe('chunkPool text chunks', () => {
    it('accumulates whole records up to the target', () => {
        const lines = [
            ln('r1a', 'x'.repeat(20)),
            ln('r1b', 'y'.repeat(18)),
            ln('sep', ''),
            ln('r2a', 'z'.repeat(20)),
            ln('r2b', 'w'.repeat(17)),
            ln('sep2', ''),
            ln('r3', 'short'),
        ];
        const { sources } = poolSources([textSource(lines)]);

        const tight = chunkPool(sources, limit({ TEXT_CHUNK_TARGET: 40, TEXT_CHUNK_MAX: 70 }));
        expect(tight.chunks.map((c) => c.lines.map((l) => l.id))).toEqual([
            ['S1:r1a', 'S1:r1b', 'S1:sep'],
            ['S1:r2a', 'S1:r2b', 'S1:sep2'],
            ['S1:r3'],
        ]);
        expect(tight.chunks.every((c) => c.kind === 'text' && c.header === null && c.image_ref === null)).toBe(true);
        expect(tight.chunks.every((c) => c.boundary_uncertain === false)).toBe(true);

        const loose = chunkPool(sources, limit({ TEXT_CHUNK_TARGET: 200, TEXT_CHUNK_MAX: 300 }));
        expect(loose.chunks).toHaveLength(1);
        expect(loose.chunks[0].lines).toHaveLength(7);
    });

    it('cuts a blob without boundaries at line ends with a 2-line overlap', () => {
        const lines = Array.from({ length: 6 }, (_, i) => ln(`q${i + 1}`, 'q'.repeat(30)));
        const { sources } = poolSources([textSource(lines)]);
        const { chunks } = chunkPool(sources, limit({
            TEXT_CHUNK_TARGET: 40,
            TEXT_CHUNK_MAX: 70,
            TEXT_CHUNK_OVERLAP_LINES: 1,
        }));

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[0].boundary_uncertain).toBe(false);
        for (let i = 1; i < chunks.length; i += 1) {
            expect(chunks[i].boundary_uncertain).toBe(true);
            // consecutive pieces share the overlap line
            const previous = chunks[i - 1].lines.at(-1);
            expect(chunks[i].lines[0]).toEqual({ id: previous.id, text: previous.text });
        }
        const seen = new Set(chunks.flatMap((c) => c.lines.map((l) => l.id)));
        for (let i = 1; i <= 6; i += 1) expect(seen.has(`S1:q${i}`)).toBe(true);
    });

    it('sends the canonical text to the model', () => {
        const lines = [{ id: 'L001', text: 'x ٢٩٨٠٥١٥١٢٠١٢٣٤' }];
        const { sources } = poolSources([textSource(lines)]);
        const { chunks } = chunkPool(sources, limit({ TEXT_CHUNK_TARGET: 10_000, TEXT_CHUNK_MAX: 20_000 }));
        expect(chunks[0].lines[0].text).toBe('S1:L001 | x 29805151201234');
    });
});

describe('chunkPool sheet chunks', () => {
    const sheet = (rows, header = 'S1:R1 | Name | ID') => ({
        id: 'S1',
        kind: 'sheet',
        layout: 'rows',
        name: 'sheet',
        header: { id: 'S1:R1', text: header },
        lines: Array.from({ length: rows }, (_, i) => ({ id: `S1:R${i + 2}`, text: `S1:R${i + 2} | row ${i + 1}` })),
        meta: {},
        warnings: [],
        stats: { dataRows: rows },
    });

    it('cuts every 15 rows and repeats the header', () => {
        const { chunks, stats } = chunkPool([sheet(32)], limit({ SHEET_CHUNK_ROWS: 15 }));
        expect(chunks.map((c) => c.lines.length)).toEqual([15, 15, 2]);
        expect(chunks.every((c) => c.header === 'S1:R1 | Name | ID')).toBe(true);
        expect(chunks.every((c) => c.kind === 'sheet' && c.boundary_uncertain === false)).toBe(true);
        expect(stats).toMatchObject({ chunks: 3, sources: 1, rows: 32 });
    });

    it('honours a custom row size and the chunk cap', () => {
        const { chunks, warnings } = chunkPool([sheet(7)], limit({ SHEET_CHUNK_ROWS: 3, MAX_CHUNKS: 2 }));
        expect(chunks.map((c) => c.lines.length)).toEqual([3, 3]);
        expect(warnings).toEqual([{ code: 'CHUNK_CAP', params: { limit: 2 } }]);
    });

    it('produces no chunks for empty sources', () => {
        const { chunks } = chunkPool([sheet(0)], limit({}));
        expect(chunks).toEqual([]);
        const image = { id: 'S1', kind: 'image', layout: 'image', header: null, lines: [], warnings: [], stats: {} };
        expect(chunkPool([image], limit({})).chunks).toEqual([]);
    });
});

describe('prepareSources', () => {
    it('pools and chunks in one call with sequential chunk ids', () => {
        const { chunks, pooled } = prepareSources([
            textSource([ln('L001', 'one')], 'a.txt'),
            textSource([ln('L001', 'two')], 'b.txt'),
        ], limit({ TEXT_CHUNK_TARGET: 10_000, TEXT_CHUNK_MAX: 20_000 }));
        expect(pooled.map((s) => s.id)).toEqual(['S1', 'S2']);
        expect(chunks.map((c) => c.chunk_id)).toEqual(['c1', 'c2']);
        expect(chunks.map((c) => c.source_id)).toEqual(['S1', 'S2']);
    });
});
