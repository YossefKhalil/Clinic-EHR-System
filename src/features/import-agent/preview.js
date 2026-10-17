// "What will be sent" preview (spec §5.3) — the model behind the wizard's
// preview step. Rendering is the review milestone's job; this module answers
// exactly what the user must see before anything leaves the browser: the
// sources, their character/image counts, the column headers of spreadsheets
// and the privacy note parameters. Nothing here sends anything.
//
// Counts are computed from the POOLED text — the exact strings the model
// would receive, prefixes included — so the numbers match the request.

import { LIMITS } from '@import-core/limits.js';
import { columnCount } from './readers/table.js';
import { hashWarning } from './intake.js';
import { poolSources } from './chunker.js';

/**
 * @param {{
 *   files: Array<{
 *     name: string, size?: number, kind?: string, sha256?: string,
 *     sources: object[],        // rich reader output (after any column masking)
 *     warnings?: object[],      // file-level warnings from readFile
 *   }>,
 *   provider?: string|null,     // shown in the privacy note
 *   retentionDays?: number,
 *   seenHashes?: Map|object|Array|null,  // hash → earlier import date
 * }} input
 */
export function buildPreview({
    files,
    provider = null,
    retentionDays = LIMITS.STAGING_TTL_DAYS,
    seenHashes = null,
}) {
    const flat = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        for (const source of files[fileIndex].sources ?? []) flat.push({ fileIndex, source });
    }
    const { sources: pooled } = poolSources(flat.map((item) => item.source));

    const fileRows = files.map((file) => ({
        name: file.name,
        size: file.size ?? null,
        kind: file.kind ?? null,
        sha256: file.sha256 ?? null,
        hashWarning: file.sha256 ? hashWarning(file.sha256, seenHashes) : null,
        warnings: file.warnings ?? [],
    }));

    const entries = flat.map((item, index) => {
        const pool = pooled[index];
        const sentText = [pool.header, ...pool.lines].filter(Boolean).map((line) => line.canonical ?? line.text);
        const chars = sentText.reduce((sum, text) => sum + text.length + 1, 0);
        const isRows = pool.layout === 'rows';
        return {
            fileIndex: item.fileIndex,
            sourceId: pool.id,
            name: pool.name,
            kind: pool.kind,
            layout: pool.layout,
            chars,
            images: pool.layout === 'image' ? 1 : 0,
            rows: isRows ? (pool.stats?.dataRows ?? pool.lines.length) : null,
            lines: isRows ? null : pool.lines.filter((line) => line.blank !== true).length,
            columns: isRows ? { headers: item.source.header?.cells ?? [], width: columnCount(item.source) } : null,
            warnings: pool.warnings,
        };
    });

    const totals = {
        files: files.length,
        sources: entries.length,
        chars: entries.reduce((sum, entry) => sum + entry.chars, 0),
        images: entries.reduce((sum, entry) => sum + entry.images, 0),
        rows: entries.reduce((sum, entry) => sum + (entry.rows ?? 0), 0),
    };

    return {
        files: fileRows,
        entries,
        totals,
        privacy: { provider, retentionDays },
    };
}
