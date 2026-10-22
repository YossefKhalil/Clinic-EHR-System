// Raw Postgres errors must never reach the UI (issue #34): the mapper
// turns the SQLSTATE codes the app actually hits into short translated
// text, passes the app's own errors through, and falls back to a generic
// line when there is nothing to show.

import { describe, expect, it } from 'vitest';
import { dbErrorMessage } from '../../src/services/error-message.js';

// The default translator returns the key itself, which is the English
// source text — enough to assert the exact user-facing string.
const tr = (key) => key;

describe('dbErrorMessage', () => {
    it('maps a unique violation on the national id to the precise message', () => {
        const error = {
            code: '23505',
            message: 'duplicate key value violates unique constraint "patients_national_id_key"',
        };
        expect(dbErrorMessage(error, tr)).toBe('A patient with this National ID already exists.');
    });

    it('maps any other unique violation to the generic already-exists message', () => {
        const error = { code: '23505', message: 'duplicate key value violates unique constraint "options_kind_key_key"' };
        expect(dbErrorMessage(error, tr)).toBe('This record already exists.');
    });

    it('maps an expired session (PGRST301) to the sign-in-again message', () => {
        expect(dbErrorMessage({ code: 'PGRST301', message: 'JWT expired' }, tr))
            .toBe('Your session has expired. Please sign in again.');
    });

    it('maps RLS denials (42501) to the permission message', () => {
        expect(dbErrorMessage({ code: '42501', message: 'permission denied for table patients' }, tr))
            .toBe("You don't have permission to do this.");
    });

    it('maps invalid input syntax (22xxx) to the format message', () => {
        expect(dbErrorMessage({ code: '22P02', message: 'invalid input syntax for type date: ""' }, tr))
            .toBe('Some of the values you entered are not in the right format.');
    });

    it('maps foreign key violations to the still-in-use message', () => {
        expect(dbErrorMessage({ code: '23503', message: 'update or delete on table violates foreign key' }, tr))
            .toBe('This record is still used by other data, so it cannot be removed.');
    });

    it('maps check violations to the not-allowed message', () => {
        expect(dbErrorMessage({ code: '23514', message: 'new row violates check constraint' }, tr))
            .toBe('One of the values you entered is not allowed.');
    });

    it('passes the app\'s own error messages through untouched', () => {
        const error = new Error('The file is larger than 10 MB (12 MB).');
        expect(dbErrorMessage(error, tr)).toBe('The file is larger than 10 MB (12 MB).');
    });

    it('replaces network failures (TypeError) with the generic translated line', () => {
        expect(dbErrorMessage(new TypeError('Failed to fetch'), tr))
            .toBe('Something went wrong. Please try again.');
    });

    it('falls back to the generic message when there is nothing to show', () => {
        expect(dbErrorMessage(null, tr)).toBe('Something went wrong. Please try again.');
        expect(dbErrorMessage({}, tr)).toBe('Something went wrong. Please try again.');
        expect(dbErrorMessage({ code: 'XX000', message: '' }, tr)).toBe('Something went wrong. Please try again.');
    });

    it('works without a translator (defaults to the key)', () => {
        expect(dbErrorMessage({ code: '23514', message: 'check constraint' }))
            .toBe('One of the values you entered is not allowed.');
    });
});
