import { describe, expect, it } from 'vitest';
import { countStatuses, deriveStatus, issueAckKey, ROW_STATUSES } from '@import-core/status.js';

const issue = (code, severity, field = null) => ({ code, severity, field, detail: null });

describe('deriveStatus', () => {
    it('is ready with no issues or with info issues only', () => {
        expect(deriveStatus([])).toBe('ready');
        expect(deriveStatus([issue('AGE_DERIVED', 'info', 'age')])).toBe('ready');
    });

    it('is review with an unacknowledged warning, error as soon as one error exists', () => {
        expect(deriveStatus([issue('MOBILE_FORMAT', 'warn', 'mobile')])).toBe('review');
        expect(deriveStatus([
            issue('MOBILE_FORMAT', 'warn', 'mobile'),
            issue('NID_LENGTH', 'error', 'national_id'),
        ])).toBe('error');
    });

    it('an error can never be acknowledged away', () => {
        const error = issue('NID_REQUIRED', 'error', 'national_id');
        expect(deriveStatus([error], { acknowledged: [issueAckKey(error, '')] })).toBe('error');
    });
});

describe('issueAckKey', () => {
    it('binds the code, the field and the cell value', () => {
        const warn = issue('MOBILE_FORMAT', 'warn', 'mobile');
        expect(issueAckKey(warn, '0111234567'))
            .toBe('MOBILE_FORMAT\u0000mobile\u00000111234567');
    });

    it('joins list values and leaves a missing value empty', () => {
        expect(issueAckKey(issue('TEXT_TOO_LONG', 'warn', 'notes'), ['a', 'b']))
            .toBe('TEXT_TOO_LONG\u0000notes\u0000a\nb');
        expect(issueAckKey(issue('SRC_REF_INVALID', 'warn'), undefined))
            .toBe('SRC_REF_INVALID\u0000\u0000');
    });
});

describe('acknowledged warnings', () => {
    it('drops a row back to ready while the value is unchanged', () => {
        const warn = issue('MOBILE_FORMAT', 'warn', 'mobile');
        const values = { mobile: '0111234567' };
        const acknowledged = [issueAckKey(warn, values.mobile)];
        expect(deriveStatus([warn], { acknowledged, values })).toBe('ready');
    });

    it('editing the cell invalidates the acknowledgement', () => {
        const warn = issue('MOBILE_FORMAT', 'warn', 'mobile');
        const acknowledged = [issueAckKey(warn, '0111234567')];
        expect(deriveStatus([warn], { acknowledged, values: { mobile: '01099999999' } }))
            .toBe('review');
    });

    it('acknowledges row-level issues through the empty value', () => {
        const warn = issue('ROW_MISSING', 'warn');
        const acknowledged = [issueAckKey(warn, undefined)];
        expect(deriveStatus([warn], { acknowledged, values: { mobile: '0111234567' } }))
            .toBe('ready');
    });

    it('still needs every warning on the row to be acknowledged', () => {
        const one = issue('MOBILE_FORMAT', 'warn', 'mobile');
        const two = issue('NAME_SINGLE_TOKEN', 'warn', 'name');
        const values = { mobile: '0111234567', name: 'Sara' };
        expect(deriveStatus([one, two], {
            acknowledged: [issueAckKey(one, values.mobile)],
            values,
        })).toBe('review');
    });
});

describe('countStatuses', () => {
    it('counts the three statuses and ignores anything else', () => {
        const rows = [
            { status: 'ready' }, { status: 'review' }, { status: 'error' },
            { status: 'error' }, { status: 'something-else' },
        ];
        expect(countStatuses(rows)).toEqual({ ready: 1, review: 1, error: 2 });
        expect(countStatuses([])).toEqual({ ready: 0, review: 0, error: 0 });
    });

    it('names the statuses it knows about', () => {
        expect(ROW_STATUSES).toEqual(['ready', 'review', 'error']);
    });
});
