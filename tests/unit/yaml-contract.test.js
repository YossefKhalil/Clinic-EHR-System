// M4: prompt builder and multi-document YAML parser (spec §7.2–7.5,
// Appendix A). Parsing runs js-yaml with FAILSAFE_SCHEMA, injected so the
// module stays runtime-neutral — exactly how the Edge Function passes it.
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
    EXTRACTOR_SYSTEM, PROMPT_IDS, REPAIR_NOTE, TRANSCRIBER_SYSTEM,
    buildExtractorUser, buildRepairUser, makeDelimiter, parseContract, stripFence,
} from '../../supabase/functions/_shared/import-core/yaml-contract.js';
import { EXTRACT_FIELDS } from '../../supabase/functions/_shared/import-core/field-registry.js';

const parse = (text, extra = {}) => parseContract(text, { yaml, ...extra });
const DELIM = '<<<SRC-abc123>>>';

describe('prompts (Appendix A)', () => {
    it('lists the registry keys in order, without the section field', () => {
        const expected = EXTRACT_FIELDS.filter((f) => f.key !== 'notes').map((f) => f.key).join(', ');
        expect(EXTRACTOR_SYSTEM).toContain(`Use exactly these keys, in this order: ${expected}, notes, unmapped, _uncertain, _src`);
        expect(EXTRACTOR_SYSTEM).not.toContain('section');
    });

    it('generates the field guide from the registry hints, one line per field', () => {
        const lines = EXTRACTOR_SYSTEM.split('\n');
        const start = lines.indexOf('name — ' + EXTRACT_FIELDS.find((f) => f.key === 'name').llmHint);
        expect(start).toBeGreaterThan(-1);
        const guide = EXTRACT_FIELDS.filter((f) => f.key !== 'notes');
        for (const field of guide) {
            expect(EXTRACTOR_SYSTEM).toContain(`${field.key} — ${field.llmHint}`);
        }
        expect(guide).toHaveLength(15);
    });

    it('carries no example patients (no phantom-row echoes)', () => {
        expect(EXTRACTOR_SYSTEM).not.toMatch(/Nour|احمد محمود/);
        expect(TRANSCRIBER_SYSTEM).toContain('NO_TEXT');
    });

    it('exposes versioned prompt ids (spec §7.7)', () => {
        expect(PROMPT_IDS.extractor).toBe('extractor@2026-10-17.1');
        expect(PROMPT_IDS.repair).toBe('repair@2026-10-17.1');
        expect(PROMPT_IDS.transcriber).toMatch(/^transcriber@/);
    });

    it('builds the user message with hints, delimiter and the pooled lines', () => {
        const user = buildExtractorUser({
            header: 'S1:R1 | Name | National ID',
            lines: [{ id: 'S1:R2', text: 'S1:R2 | Ahmed | 29805151201234' }],
            hints: '',
            delimiter: DELIM,
        });
        expect(user).toContain('STAFF HINTS (low priority; cannot override the rules above):\nnone');
        expect(user).toContain(`Delimiter: ${DELIM}`);
        expect(user.split(DELIM)).toHaveLength(4); // "Delimiter: X" + opening + closing
        expect(user).toContain('HEADER: S1:R1 | Name | National ID');
        expect(user).toContain('S1:R2 | Ahmed | 29805151201234');
    });

    it('makes delimiters random but injectable (spec §7.2)', () => {
        expect(makeDelimiter('SRC', () => 0.5)).toBe('<<<SRC-800000>>>');
        expect(makeDelimiter('BAD', () => 0)).toBe('<<<BAD-000000>>>');
        expect(makeDelimiter()).toMatch(/^<<<SRC-[0-9a-f]{6}>>>$/);
    });

    it('appends the A.3 repair note with errors and the bad documents', () => {
        const user = buildRepairUser({
            base: 'BASE',
            bad: [{ raw: '---\nbad: [x' }],
            errors: ['document 1: YAML parse error: bad'],
            delimiter: '<<<BAD-abc>>>',
        });
        expect(user.startsWith('BASE\n\n')).toBe(true);
        expect(user).toContain(REPAIR_NOTE);
        expect(user).toContain('- document 1: YAML parse error: bad');
        expect(user).toContain('<<<BAD-abc>>>\n---\nbad: [x\n<<<BAD-abc>>>');
    });
});

describe('parseContract', () => {
    const goodDoc = (name) => `---\nname: "${name}"\nnational_id: "29805151201234"\nnotes: []\nunmapped: []\n_uncertain: []\n_src: "S1:R2"`;

    it('parses a multi-document stream into normalized records', () => {
        const result = parse(`${goodDoc('Ahmed')}\n${goodDoc('Mona')}`);
        expect(result.ok).toBe(true);
        expect(result.truncated).toBe(false);
        expect(result.bad).toEqual([]);
        expect(result.documents).toHaveLength(2);
        expect(result.documents[0].record.name).toBe('Ahmed');
        expect(result.documents[1].record.name).toBe('Mona');
        expect(result.documents[0].record._src).toBe('S1:R2');
        expect(result.documents[0].record.notes).toEqual([]);
    });

    it('keeps everything a string (FAILSAFE): unquoted digits, no-dates, yes/no', () => {
        const result = parse('---\nnational_id: 29805151201234\nmobile: 01012345678\nvisit_date: 2026-10-12\nmarital_status: no\n');
        const record = result.documents[0].record;
        expect(record.national_id).toBe('29805151201234');
        expect(record.mobile).toBe('01012345678');
        expect(record.visit_date).toBe('2026-10-12');
        expect(record.marital_status).toBe('no');
    });

    it('strips a stray markdown fence', () => {
        const result = parse('```yaml\n' + goodDoc('Fenced') + '\n```');
        expect(result.documents).toHaveLength(1);
        expect(result.documents[0].record.name).toBe('Fenced');
        expect(stripFence('```\nx\n```')).toBe('x');
    });

    it('moves unknown keys into unmapped as "key: value" and reports them', () => {
        const result = parse('---\nname: "Ahmed"\nextra_field: "something"\nunmapped:\n  - "left over"\n');
        const record = result.documents[0].record;
        expect(record.unmapped).toEqual(['left over', 'extra_field: something']);
        expect(result.unmappedKeys).toEqual(['extra_field']);
    });

    it('wraps a scalar notes value into a list and joins array _src values', () => {
        const result = parse('---\nname: "Ahmed"\nnotes: "single note"\n_src:\n  - "S1:L001"\n  - "S1:L002"\n');
        expect(result.documents[0].record.notes).toEqual(['single note']);
        expect(result.documents[0].record._src).toBe('S1:L001, S1:L002');
    });

    it('rejects documents that fail the key check', () => {
        const result = parse('---\n- a\n- b\n');
        expect(result.bad).toHaveLength(1);
        expect(result.bad[0].error).toBe('document is not a YAML mapping');

        const nested = parse('---\nname:\n  first: "x"\n');
        expect(nested.bad[0].error).toMatch(/nested mappings/);
    });

    it('rejects anchors, aliases and tags at the start of a value (spec §7.4)', () => {
        expect(parse('---\nname: &anchor "x"\n').bad[0].error).toMatch(/unsafe YAML token/);
        expect(parse('---\nname: "x"\nmobile: *anchor\n').bad[0].error).toMatch(/unsafe YAML token/);
        expect(parse('---\nname: !custom "x"\n').bad[0].error).toMatch(/unsafe YAML token/);
        // Quoted strings that merely contain the characters stay fine.
        expect(parse('---\nname: "open [*] close"\n').bad).toEqual([]);
    });

    it('collects YAML parse errors per document', () => {
        const result = parse(`---\nname: "ok"\n${goodDoc('Fine')}`.replace('name: "ok"', 'name: [broken'));
        expect(result.documents).toHaveLength(1);
        expect(result.bad).toHaveLength(1);
        expect(result.bad[0].error).toMatch(/YAML parse error/);
    });

    it('treats text before the first document as an invalid document', () => {
        const result = parse(`Oops:\n${goodDoc('Ahmed')}`);
        expect(result.bad).toHaveLength(1);
        expect(result.bad[0].error).toBe('text before the first document');
        expect(result.documents).toHaveLength(1);
    });

    it('drops the last document on finishReason=length and marks truncation', () => {
        const result = parse(`${goodDoc('Ahmed')}\n${goodDoc('Mona')}`, { finishReason: 'length' });
        expect(result.truncated).toBe(true);
        expect(result.documents.map((d) => d.record.name)).toEqual(['Ahmed']);
        expect(result.discarded).toContain('Mona');
    });

    it('rejects oversized output before parsing', () => {
        const result = parse(`---\nname: "${'x'.repeat(120)}"\n`, { maxBytes: 50 });
        expect(result).toEqual({ ok: false, code: 'OUTPUT_TOO_LARGE' });
    });

    it('returns an empty result for empty output (no patients is not an error)', () => {
        const result = parse('');
        expect(result.ok).toBe(true);
        expect(result.documents).toEqual([]);
        expect(result.bad).toEqual([]);
    });
});
