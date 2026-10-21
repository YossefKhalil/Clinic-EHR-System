import { readFileSync, writeFileSync } from 'node:fs';

const path = 'index.html';
const raw = readFileSync(path, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.replace(/\r\n/g, '\n').split('\n');

function matchingClose(list, start) {
    let depth = 0;
    for (let i = start; i < list.length; i += 1) {
        const line = list[i];
        depth += (line.match(/<div\b/g) || []).length - (line.match(/<\/div>/g) || []).length;
        if (depth === 0) return i;
    }
    throw new Error('no matching close');
}

// The filter toolbar block.
const toolbarStart = lines.findIndex((line) => line.includes('class="filter-toolbar mb-4"'));
if (toolbarStart < 0) throw new Error('the filter toolbar not found');
const toolbarEnd = matchingClose(lines, toolbarStart);
const toolbar = lines.slice(toolbarStart, toolbarEnd + 1);

const chipsStart = toolbar.findIndex((line) => line.includes('class="filter-chips'));
const chipsEnd = matchingClose(toolbar, chipsStart);
const chips = toolbar.slice(chipsStart, chipsEnd + 1);
// The wrapper keeps the buttons, the scrim and the panel; only the chips move
// under the toolbar row.
const kept = [...toolbar.slice(0, chipsStart), ...toolbar.slice(chipsEnd + 1)];

// The row: the filter control joins the other two buttons.
const rowStart = lines.findIndex((line) => line.includes('class="row mb-4 align-items-center"'));
if (rowStart < 0) throw new Error('the patients toolbar row not found');
const rowEnd = matchingClose(lines, rowStart);
const colStart = lines.findIndex((line, index) => index > rowStart && index < rowEnd && line.includes('<div class="col-md-6 text-end">'));
const colEnd = matchingClose(lines, colStart);
const excelLine = lines.findIndex((line, index) => index > colStart && index < colEnd && line.includes('exportPatients()'));
if (excelLine < 0) throw new Error('the excel button not found');

const next = [
    ...lines.slice(0, rowStart),
    '                <div class="row mb-4 align-items-center">',
    ...lines.slice(rowStart + 1, colStart),
    '                    <div class="col-md-6 text-end d-flex flex-wrap justify-content-end align-items-center gap-2">',
    '                        <!-- The filter control (issue #13) lives in the toolbar row:',
    '                             its panel is anchored to it, the applied-filter chips',
    '                             stay under the toolbar. -->',
    ...kept,
    ...lines.slice(colStart + 1, excelLine),
    ...lines.slice(excelLine, colEnd + 1),
    ...lines.slice(colEnd + 1, rowEnd + 1),
    // The applied-filter chips, under the row.
    ...chips.map((line) => line.replace('mt-2', 'mb-4')),
    ...lines.slice(toolbarEnd + 1),
];

const withLabel = next.map((line) => (line.includes("t('Excel')") ? line.replace("t('Excel')", "t('Excel export')") : line));

writeFileSync(path, withLabel.join('\n').replace(/\n/g, eol), 'utf8');
console.log('the filter control moved into the toolbar row');
