// Pooling and chunking (spec §6): the source pool gets stable `S{n}:{line}`
// ids and canonical copies, then the pool is cut into chunks — one chunk = one
// LLM call. Cuts happen only at record boundaries; a blob without boundaries
// is cut at line ends with a 2-line overlap and `boundary_uncertain = true`
// (spec §6.2). The chunk payload matches §6.3.
//
// Pooled line text is composed as `<id> | <content>`, the exact form the
// model sees in the request (spec §7.2). The `canonical` copy is present only
// when canonicalization changes the line; the payload's `text` is already the
// canonical copy so the extraction request can send it untouched.
//
// Lives in import-core (not src/features) because the Edge Function also
// chunks pasted text and splits truncated chunks (spec §7.4); the browser
// imports it through the `@import-core` alias and src/features re-exports it.

import { LIMITS } from './limits.js';
import { canonicalizeBlock } from './canonicalize.js';

// Record boundaries (spec §6.2): a numbered item, or a line with a 14-digit
// run when the previous line already had one. A blank line ends a record.
const NUMBERED_ITEM = /^\s*(?:\d{1,3}\s*[-.)]|مريض\s*\d+\s*:)/;
const FOURTEEN_DIGITS = /\d{14}/;

function lineForModel(line) {
    return { id: line.id, text: line.canonical ?? line.text };
}

/** A line is blank when its source text was empty (see `poolLine`). */
function isBlankLine(line) {
    return line.blank === true || lineForModel(line).text.trim() === '';
}

function composePooledText(sourceId, line) {
    const id = `${sourceId}:${line.id}`;
    if (!line.text) return id;
    return `${id} | ${line.text}`;
}

function poolLine(sourceId, line) {
    const text = composePooledText(sourceId, line);
    const canonical = canonicalizeBlock(text);
    const pooled = { id: `${sourceId}:${line.id}`, text };
    // Blankness is what record boundaries are made of (spec §6.2); the
    // composed text only holds the id, so carry the fact explicitly.
    if (!line.text) pooled.blank = true;
    if (canonical !== text) pooled.canonical = canonical;
    return pooled;
}

/**
 * Assign pooled ids and canonical copies to the rich reader output.
 * `sources` is what `readFile` returned; ids become `S1…Sn` in order.
 */
export function poolSources(sources) {
    const pooled = sources.map((source, index) => {
        const id = `S${index + 1}`;
        return {
            id,
            kind: source.kind,
            layout: source.layout,
            name: source.name,
            header: source.header ? poolLine(id, source.header) : null,
            lines: source.lines.map((line) => poolLine(id, line)),
            // A photo of a note carries its tiles with it: the model reads the
            // images, not text lines.
            images: source.images ?? [],
            meta: source.meta ?? {},
            warnings: source.warnings ?? [],
            stats: source.stats ?? {},
        };
    });
    return { sources: pooled };
}

/** Split pooled text lines into records at the spec §6.2 boundaries. */
export function splitRecords(lines) {
    const records = [];
    let current = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const text = lineForModel(line).text;
        const prev = i > 0 ? lines[i - 1] : null;
        const prevText = prev ? lineForModel(prev).text : null;
        const boundary = prev === null
            || isBlankLine(prev)
            || NUMBERED_ITEM.test(text)
            || (FOURTEEN_DIGITS.test(text) && FOURTEEN_DIGITS.test(prevText));
        if (boundary && current.length > 0) {
            records.push(current);
            current = [];
        }
        current.push(line);
    }
    if (current.length > 0) records.push(current);
    // A trailing blank line is a separator, not a record of its own.
    return records.filter((record) => record.some((line) => !isBlankLine(line)));
}

function recordSize(record) {
    return record.reduce((sum, line) => sum + lineForModel(line).text.length + 1, 0);
}

/** Cut an oversized record at line ends, with the §6.2 overlap. */
function splitOversize(record, limits) {
    const pieces = [];
    let current = [];
    let currentSize = 0;
    for (const line of record) {
        const size = lineForModel(line).text.length + 1;
        if (current.length > 0 && currentSize + size > limits.TEXT_CHUNK_MAX) {
            pieces.push(current);
            const overlap = Math.max(0, limits.TEXT_CHUNK_OVERLAP_LINES);
            current = overlap > 0 ? current.slice(-overlap) : [];
            currentSize = current.reduce((sum, l) => sum + lineForModel(l).text.length + 1, 0);
        }
        current.push(line);
        currentSize += size;
    }
    if (current.length > 0) pieces.push(current);
    return pieces;
}

/**
 * Cut pooled sources into chunk payloads (spec §6.2–6.3).
 *
 * @param {object[]} sources pooled sources from `poolSources`
 * @returns {{ chunks: object[], warnings: object[], stats: object }}
 */
export function chunkPool(sources, limits = LIMITS) {
    const chunks = [];
    const warnings = [];
    let capReached = false;
    let counter = 0;

    const push = (chunk) => {
        if (chunks.length >= limits.MAX_CHUNKS) {
            capReached = true;
            return false;
        }
        counter += 1;
        chunks.push({ chunk_id: `c${counter}`, ...chunk });
        return true;
    };

    for (const source of sources) {
        if (capReached) break;

        if (source.layout === 'image') {
            // A photo of a note is one chunk with the tiles attached: the
            // model reads the image and answers with the same YAML contract.
            const images = source.images ?? [];
            if (images.length === 0) continue;
            const ok = push({
                source_id: source.id,
                kind: 'image',
                header: null,
                lines: [],
                images,
                boundary_uncertain: false,
                image_ref: images[0].id,
            });
            if (!ok) break;
            continue;
        }

        if (source.layout === 'rows') {
            const header = source.header ? lineForModel(source.header).text : null;
            for (let i = 0; i < source.lines.length; i += limits.SHEET_CHUNK_ROWS) {
                const group = source.lines.slice(i, i + limits.SHEET_CHUNK_ROWS);
                const ok = push({
                    source_id: source.id,
                    kind: 'sheet',
                    header,
                    lines: group.map(lineForModel),
                    boundary_uncertain: false,
                    image_ref: null,
                });
                if (!ok) break;
            }
            continue;
        }

        if (source.layout === 'text') {
            const records = splitRecords(source.lines);
            let current = [];
            let currentSize = 0;
            const flush = () => {
                if (current.length === 0) return true;
                const ok = push({
                    source_id: source.id,
                    kind: 'text',
                    header: null,
                    lines: current.map(lineForModel),
                    boundary_uncertain: false,
                    image_ref: null,
                });
                current = [];
                currentSize = 0;
                return ok;
            };

            for (const record of records) {
                if (capReached) break;
                const size = recordSize(record);
                if (size > limits.TEXT_CHUNK_MAX) {
                    // No usable boundary in this record: cut at line ends with
                    // a 2-line overlap; the continuation pieces are uncertain.
                    flush();
                    const pieces = splitOversize(record, limits);
                    pieces.forEach((piece, index) => {
                        if (capReached) return;
                        push({
                            source_id: source.id,
                            kind: 'text',
                            header: null,
                            lines: piece.map(lineForModel),
                            boundary_uncertain: index > 0,
                            image_ref: null,
                        });
                    });
                    continue;
                }
                if (current.length > 0 && currentSize + size > limits.TEXT_CHUNK_TARGET) {
                    if (!flush()) break;
                }
                current.push(...record);
                currentSize += size;
            }
            if (!capReached) flush();
        }
    }

    if (capReached) warnings.push({ code: 'CHUNK_CAP', params: { limit: limits.MAX_CHUNKS } });

    return {
        chunks,
        warnings,
        stats: {
            chunks: chunks.length,
            sources: sources.length,
            rows: sources.reduce((sum, s) => sum + (s.stats?.dataRows ?? 0), 0),
        },
    };
}

/** Convenience: pool rich reader output, then chunk it. */
export function prepareSources(sources, limits = LIMITS) {
    const { sources: pooled } = poolSources(sources);
    const { chunks, warnings, stats } = chunkPool(pooled, limits);
    return { pooled, chunks, warnings, stats };
}

/**
 * Renumber a fresh, single-source pool (ids `S1:…`) to the job's next source
 * number. Sources are numbered in the order the employee adds them (spec
 * §6.2), so a pasted-text source added after an uploaded file must not reuse
 * `S1`. Returns the chunks unchanged for `newNumber <= 1`.
 */
export function shiftSourceIds(chunks, newNumber) {
    if (!Number.isInteger(newNumber) || newNumber <= 1) return chunks;
    const to = `S${newNumber}`;
    const rename = (text) => String(text).replace(/^S1(?=:)/, to);
    return chunks.map((chunk) => ({
        ...chunk,
        source_id: chunk.source_id === 'S1' ? to : chunk.source_id,
        header: chunk.header ? rename(chunk.header) : (chunk.header ?? null),
        lines: (chunk.lines ?? []).map((line) => ({
            ...line,
            id: rename(line.id),
            text: rename(line.text),
        })),
    }));
}

/**
 * Split one chunk payload in half for the truncation retry (spec §7.4) and
 * the reconciliation re-queue (spec §8.2.4). Rows chunks are cut at row
 * boundaries; the header line is kept. Returns null when the chunk cannot be
 * split (one data row or one text line).
 */
export function splitChunkPayload(chunk) {
    const lines = chunk.lines ?? [];
    if (lines.length < 2) return null;
    const half = Math.ceil(lines.length / 2);
    const cut = (part, index) => ({
        chunk_id: `${chunk.chunk_id}.${index + 1}`,
        source_id: chunk.source_id,
        kind: chunk.kind,
        header: chunk.header ?? null,
        lines: part,
        // The cut may be mid-record for text chunks: flag the continuation.
        boundary_uncertain: chunk.kind === 'sheet' ? false : index > 0,
        image_ref: chunk.image_ref ?? null,
    });
    return [cut(lines.slice(0, half), 0), cut(lines.slice(half), 1)];
}
