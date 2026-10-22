// Login identifiers (issue #12 workaround).
//
// Supabase Auth has no username identifier: `signInWithPassword` only accepts
// an email or a phone. The clinic does not run mailboxes for staff, so the
// login form takes the account email or its username - the part before the @
// of that email - and the `login` Edge Function turns the latter into the
// former server-side. These helpers are pure so the function and its tests
// share one definition.

export const MAX_IDENTIFIER_LENGTH = 320;

export function normalizeIdentifier(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

export function looksLikeEmail(identifier: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
}

// A username has to be usable as an email local part: no '@', no spaces, and
// nothing that would change meaning inside a LIKE pattern.
export function isUsername(identifier: string): boolean {
    return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(identifier);
}

// PostgREST applies this as a LIKE pattern. `%` and `_` are wildcards there,
// so a username that contains them is escaped; otherwise `a_b` would also
// match `axb`.
export function usernameEmailPattern(identifier: string): string {
    return `${escapeLike(identifier)}@%`;
}

export function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
