// The username-or-email login (issue #12 workaround). The username is the
// email local part, so these helpers decide what the login form accepts and
// how the `login` Edge Function looks that username up.

import { describe, expect, it } from 'vitest';
import {
    escapeLike,
    isUsername,
    looksLikeEmail,
    MAX_IDENTIFIER_LENGTH,
    normalizeIdentifier,
    usernameEmailPattern,
} from '../../supabase/functions/_shared/login-identifier.ts';

describe('login identifiers', () => {
    it('trims and lowercases what the form sends', () => {
        expect(normalizeIdentifier('  YossefComx ')).toBe('yossefcomx');
        expect(normalizeIdentifier(null)).toBe('');
        expect(normalizeIdentifier(undefined)).toBe('');
        expect(normalizeIdentifier(42)).toBe('42');
    });

    it('recognises an email so it can be signed in directly', () => {
        expect(looksLikeEmail('yossefcomx@gmail.com')).toBe(true);
        expect(looksLikeEmail('a@b.co')).toBe(true);
        expect(looksLikeEmail('yossefcomx')).toBe(false);
        expect(looksLikeEmail('yossefcomx@localhost')).toBe(false);
        expect(looksLikeEmail('a b@c.com')).toBe(false);
        expect(looksLikeEmail('')).toBe(false);
    });

    it('accepts the local part of an email as a username', () => {
        expect(isUsername('a')).toBe(true);
        expect(isUsername('yossefcomx')).toBe(true);
        expect(isUsername('dr.sara')).toBe(true);
        expect(isUsername('front_desk-2')).toBe(true);
        expect(isUsername('sara@clinic.com')).toBe(false);
        expect(isUsername('sara smith')).toBe(false);
        expect(isUsername('-sara')).toBe(false);
        expect(isUsername('.sara')).toBe(false);
        expect(isUsername('أحمد')).toBe(false);
        expect(isUsername('')).toBe(false);
    });

    it('escapes LIKE wildcards so a username cannot match another account', () => {
        expect(usernameEmailPattern('sara')).toBe('sara@%');
        expect(usernameEmailPattern('a_b')).toBe('a\\_b@%');
        expect(usernameEmailPattern('100%')).toBe('100\\%@%');
        expect(escapeLike('back\\slash')).toBe('back\\\\slash');
    });

    it('keeps a bounded identifier length', () => {
        expect(MAX_IDENTIFIER_LENGTH).toBe(320);
    });
});
