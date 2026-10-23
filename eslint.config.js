import globals from 'globals';

// The app shell, the Edge Function helpers and the build scripts all ship
// JavaScript; the test suite is JavaScript too. They share the same rules so
// a mistake in a shared import-core module is caught next to a browser bug.
const sharedGlobals = { ...globals.browser, ...globals.node };
const files = [
    'src/**/*.js',
    'supabase/functions/**/*.js',
    'scripts/**/*.js',
    'tests/**/*.js',
];

const rules = {
    'no-undef': 'error',
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    'no-dupe-keys': 'error',
    'no-redeclare': 'error',
    'no-unsafe-negation': 'error',
    'no-constant-condition': 'error',
};

export default [
    {
        files,
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: sharedGlobals,
        },
        rules,
    },
    {
        files: ['supabase/functions/**/*.js'],
        languageOptions: {
            globals: { ...sharedGlobals, ...globals.denoBuiltin },
        },
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: { ...sharedGlobals, ...globals.vitest },
        },
    },
];
