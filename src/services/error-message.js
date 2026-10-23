// Turns PostgREST/Supabase database errors into short, translated,
// user-facing messages (issue #34). Raw Postgres strings ("duplicate key
// value violates unique constraint ...") are English internals that must
// never reach the screen of an Arabic clinic system.
//
// Pure and framework-free so it can be unit tested: the translate function
// is injected. The app passes its `t()`; the default returns the key itself
// (the English source text), which is also the fallback for logs/tests.

// SQLSTATE codes the app actually hits, with something specific and useful
// to say about each. https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_ERROR_MESSAGES = {
    '23503': 'This record is still used by other data, so it cannot be removed.', // foreign_key_violation
    '23514': 'One of the values you entered is not allowed.', // check_violation
    '42501': "You don't have permission to do this.", // insufficient_privilege (RLS)
};

// The manage-user Edge Function answers with short English messages. Translate
// the ones a Super Admin can actually reach; the rest pass through untouched.
const USER_SERVICE_MESSAGES = {
    'Only a Super Admin can manage users': "You don't have permission to do this.",
    'You cannot remove your own Super Admin access': 'You cannot remove your own Super Admin access.',
    'You cannot delete your own account': 'You cannot delete your own account.',
    'User not found': 'User not found.',
    'Full name is required': 'Full name is required',
    'A valid email address is required': 'A valid email address is required',
    'Password is required': 'Password is required',
    'Password must be at least 6 characters': 'Password must be at least 6 characters',
    'A user with this email address has already been registered': 'A user with this email address already exists.',
};

export function dbErrorMessage(error, t = (key) => key) {
    const code = String(error?.code ?? '');
    const message = String(error?.message ?? '');

    if (USER_SERVICE_MESSAGES[message]) return t(USER_SERVICE_MESSAGES[message]);

    // Session problems are not database problems: PGRST301 is PostgREST's
    // "JWT expired", 401/403 the auth/RLS wall. Say what the user can do
    // about it instead of showing the technical string.
    if (code === 'PGRST301' || code === '401' || code === '403') {
        return t('Your session has expired. Please sign in again.');
    }
    // A unique violation on the national id deserves the precise message:
    // that is the constraint a receptionist actually understands.
    if (code === '23505') {
        if (/national_id/i.test(message)) return t('A patient with this National ID already exists.');
        return t('This record already exists.');
    }
    if (PG_ERROR_MESSAGES[code]) return t(PG_ERROR_MESSAGES[code]);
    // The whole 22xxx class is bad input syntax ("invalid input syntax for
    // type date: \"\"") — the form's problem, not the server's.
    if (code.startsWith('22')) return t('Some of the values you entered are not in the right format.');
    // A fetch() network failure is a TypeError with an English,
    // implementation-defined message; say something translatable instead.
    if (error instanceof TypeError) return t('Something went wrong. Please try again.');
    // Anything else — the app's own Errors (upload size, storage not
    // configured, ...) — passes through untouched; only fall back to the
    // generic line when there is nothing at all to show.
    return message || t('Something went wrong. Please try again.');
}
