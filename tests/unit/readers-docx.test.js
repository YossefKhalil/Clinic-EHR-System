// M3: DOCX reader — headings/paragraphs/lists as lines, tables as rows
// sources, embedded images counted and ignored (spec §5.4).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocxHtml, readDocx } from '../../src/features/import-agent/readers/docx.js';

const bytesOf = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/readers/${name}`, import.meta.url)));

describe('parseDocxHtml', () => {
    it('turns blocks into lines, lists into `- ` lines and tables into rows', () => {
        const html = '<h1>Title</h1><p>First para.</p><ul><li>One</li><li>Two</li></ul>'
            + '<table><tr><td><p>A</p></td><td><p>B</p></td></tr><tr><td><p>C</p></td><td><p>D</p></td></tr></table>'
            + '<p>After &amp; more&#33;</p>';
        const { blocks, images } = parseDocxHtml(html);
        expect(images).toBe(0);
        expect(blocks).toEqual([
            { type: 'heading', text: 'Title' },
            { type: 'text', text: 'First para.' },
            { type: 'list', text: '- One' },
            { type: 'list', text: '- Two' },
            { type: 'table', rows: [['A', 'B'], ['C', 'D']] },
            { type: 'text', text: 'After & more!' },
        ]);
    });

    it('drops images and turns <br> into a space', () => {
        const { blocks, images } = parseDocxHtml('<p><img src="x" />before<br/>after</p>');
        expect(images).toBe(1);
        expect(blocks).toEqual([{ type: 'text', text: 'before after' }]);
    });
});

describe('readDocx on report.docx', () => {
    it('builds alternating text and table sources in document order', async () => {
        const { sources, warnings } = await readDocx(bytesOf('report.docx'), { name: 'report.docx' });
        expect(warnings).toEqual([{ code: 'DOCX_IMAGES_IGNORED', params: { count: 1 } }]);
        expect(sources.map((s) => s.name)).toEqual([
            'report.docx',
            'report.docx › table 1',
            'report.docx › text 2',
        ]);

        const [text, table, closing] = sources;
        expect(text).toMatchObject({ kind: 'docx', layout: 'text' });
        expect(text.lines).toEqual([
            { id: 'L001', text: 'Patients report' },
            { id: 'L002', text: 'Old list from paper notes.' },
            { id: 'L003', text: '- See notes' },
        ]);

        expect(table).toMatchObject({ kind: 'docx', layout: 'rows' });
        expect(table.header.cells).toEqual(['Name', 'National ID', 'Mobile']);
        expect(table.lines).toEqual([
            { id: 'R2', cells: ['Ahmed Mahmoud', '29805151201234', '01012345678'], text: 'Ahmed Mahmoud | 29805151201234 | 01012345678' },
            { id: 'R3', cells: ['Mona Hassan', '29903220201567', '01112345678'], text: 'Mona Hassan | 29903220201567 | 01112345678' },
        ]);

        expect(closing.lines).toEqual([{ id: 'L001', text: 'Questions? Call the clinic.' }]);
    });
});
