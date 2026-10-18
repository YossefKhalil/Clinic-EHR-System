// Bilingual message completeness (spec 10.10, M5 exit criteria): every issue
// code the rules engine can produce — plus every function error code and M5
// UI key — resolves to a real translation in BOTH locales. Driven by
// SEVERITY_BY_CODE, so a new issue code without messages fails the suite.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEVERITY_BY_CODE } from '@import-core/issues.js';

const LOCALES_DIR = fileURLToPath(new URL('../../src/locales/', import.meta.url));

const locales = Object.fromEntries(['en', 'ar'].map((locale) => [
    locale,
    JSON.parse(readFileSync(`${LOCALES_DIR}${locale}.json`, 'utf8')),
]));

const FUNCTION_CODES = [
    'BAD_REQUEST', 'FEATURE_DISABLED', 'NOT_FOUND', 'FORBIDDEN', 'JOB_STATE',
    'NO_CHUNKS', 'CHUNK_CAP', 'ROW_CAP', 'INTERNAL', 'CONFLICT', 'HINTS_TOO_LONG',
    'TOO_MANY_JOBS', 'JOBS_PER_DAY', 'UNAUTHORIZED', 'NOT_CONFIGURED',
    'DECRYPT_FAILED', 'PROVIDER_NOT_READY', 'UPLOAD_FAILED', 'LOAD_FAILED',
    'SAVE_CONFLICT', 'SAVE_FAILED', 'OFFLINE',
];

const CHUNK_CODES = [
    'PROVIDER_ERROR', 'PROVIDER_REJECTED', 'PROVIDER_BAD_RESPONSE',
    'IMAGES_UNSUPPORTED', 'PARSE_FAILED', 'MAX_ATTEMPTS', 'TIMEOUT',
];

const UI_KEYS = [
    'importAgent.wizard.title', 'importAgent.wizard.step.add',
    'importAgent.wizard.step.extracting', 'importAgent.wizard.step.review',
    'importAgent.wizard.addTitle', 'importAgent.wizard.files',
    'importAgent.wizard.dropHere', 'importAgent.wizard.chooseFiles',
    'importAgent.wizard.noFiles', 'importAgent.wizard.removeFile',
    'importAgent.wizard.pasteTitle', 'importAgent.wizard.pasteHint',
    'importAgent.wizard.hints', 'importAgent.wizard.hintsHint',
    'importAgent.wizard.limits', 'importAgent.wizard.sectionHint',
    'importAgent.wizard.send', 'importAgent.wizard.sending',
    'importAgent.wizard.back', 'importAgent.wizard.cancel',
    'importAgent.wizard.resume', 'importAgent.wizard.resumeHint',
    'importAgent.wizard.startNew', 'importAgent.wizard.status.uploaded',
    'importAgent.wizard.status.extracting', 'importAgent.wizard.status.review',
    'importAgent.wizard.status.failed',
    'importAgent.progress.chunks', 'importAgent.progress.next',
    'importAgent.progress.rows', 'importAgent.progress.tokens',
    'importAgent.progress.working',
    'importAgent.review.title', 'importAgent.review.counts',
    'importAgent.review.loading', 'importAgent.review.loadError',
    'importAgent.review.pill.all', 'importAgent.review.pill.attention',
    'importAgent.review.pill.errors', 'importAgent.review.pill.duplicates',
    'importAgent.review.pill.edited', 'importAgent.review.pill.removed',
    'importAgent.review.banner.truncated', 'importAgent.review.banner.failed',
    'importAgent.review.retryChunk', 'importAgent.review.banner.rejected',
    'importAgent.review.defaults.title', 'importAgent.review.defaults.hint',
    'importAgent.review.defaults.apply', 'importAgent.review.addRow',
    'importAgent.review.deleteSelected', 'importAgent.review.restoreSelected',
    'importAgent.review.setValue', 'importAgent.review.markReviewed',
    'importAgent.review.undo', 'importAgent.review.redo',
    'importAgent.review.selected', 'importAgent.review.bulk.title',
    'importAgent.review.bulk.field', 'importAgent.review.bulk.value',
    'importAgent.review.bulk.blanks', 'importAgent.review.bulk.overwrite',
    'importAgent.review.bulk.apply', 'importAgent.review.cell.revert',
    'importAgent.review.cell.edited', 'importAgent.review.cell.snapped',
    'importAgent.review.cell.derived', 'importAgent.review.cell.default',
    'importAgent.review.cell.uncertain', 'importAgent.review.cell.notesCount',
    'importAgent.review.chip.error', 'importAgent.review.chip.review',
    'importAgent.review.chip.ready', 'importAgent.review.chip.removed',
    'importAgent.review.dup.inBatch', 'importAgent.review.dup.existing',
    'importAgent.review.dup.hidden', 'importAgent.review.dup.possible',
    'importAgent.review.dup.nameDob', 'importAgent.review.dup.collapsed',
    'importAgent.review.dup.keepThis', 'importAgent.review.dup.keepOther',
    'importAgent.review.dup.fill', 'importAgent.review.dup.skip',
    'importAgent.review.dup.open', 'importAgent.review.dup.partner',
    'importAgent.review.tray.rejected', 'importAgent.review.tray.removed',
    'importAgent.review.tray.restore', 'importAgent.review.tray.moveTo',
    'importAgent.review.tray.empty', 'importAgent.review.tray.reason.UNMAPPED',
    'importAgent.review.tray.reason.PARSE_FAILED',
    'importAgent.review.tray.reason.PHANTOM_RECORD',
    'importAgent.review.tray.reason.REJECTED',
    'importAgent.review.source.title', 'importAgent.review.source.manual',
    'importAgent.review.drawer.title', 'importAgent.review.drawer.openSource',
    'importAgent.review.drawer.backToGrid', 'importAgent.review.kbdHint',
    'importAgent.review.autosave.saving', 'importAgent.review.autosave.saved',
    'importAgent.review.autosave.failed', 'importAgent.review.confirm.title',
    'importAgent.review.confirm.summary', 'importAgent.review.confirm.new',
    'importAgent.review.confirm.fill', 'importAgent.review.confirm.skipped',
    'importAgent.review.confirm.unreviewed', 'importAgent.review.confirm.import',
    'importAgent.review.confirm.reviewFirst',
    'importAgent.review.confirm.commitPlaceholder',
];

// DATE_RANGE's reason is part of the key (5.10.10 message policy).
const DATE_RANGE_VARIANTS = ['future', 'too_old', 'before_dob'];

function requireAll(keys, what) {
    for (const locale of ['en', 'ar']) {
        const missing = keys.filter((key) => typeof locales[locale][key] !== 'string'
            || locales[locale][key].length === 0);
        expect(missing, `${what} missing in ${locale}`).toEqual([]);
    }
}

describe('bilingual import-agent messages', () => {
    it('every issue code has a message in both locales', () => {
        const codes = Object.keys(SEVERITY_BY_CODE).concat('VALUE_NOT_IN_SOURCE');
        requireAll(codes.map((code) => `importAgent.issue.${code}`), 'issue keys');
    });

    it('every DATE_RANGE reason variant has both messages', () => {
        requireAll(DATE_RANGE_VARIANTS.map((reason) => `importAgent.issue.DATE_RANGE_${reason}`), 'DATE_RANGE variants');
    });

    it('every function error code has a message in both locales', () => {
        requireAll(FUNCTION_CODES.map((code) => `importAgent.error.${code}`), 'error keys');
    });

    it('every chunk failure code has a message in both locales', () => {
        requireAll(CHUNK_CODES.map((code) => `importAgent.chunkError.${code}`), 'chunk error keys');
    });

    it('every M5 UI key exists in both locales', () => {
        requireAll(UI_KEYS, 'UI keys');
    });

    it('the two locales define exactly the same importAgent key set', () => {
        const pick = (locale) => Object.keys(locales[locale])
            .filter((key) => key.startsWith('importAgent.')).sort();
        expect(pick('en')).toEqual(pick('ar'));
    });

    it('interpolation placeholders match between locales', () => {
        // Same :param set in both languages, so a missing param fails loudly.
        const paramsOf = (text) => [...String(text).matchAll(/:([a-zA-Z]+)/g)]
            .map((match) => match[1]).sort().join(',');
        for (const key of Object.keys(locales.en).filter((key) => key.startsWith('importAgent.'))) {
            expect(paramsOf(locales.en[key]), `placeholders of ${key}`)
                .toBe(paramsOf(locales.ar[key]));
        }
    });
});
