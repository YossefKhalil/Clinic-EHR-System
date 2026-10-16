import globals from 'globals';

export default [
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            'no-dupe-keys': 'error',
            'no-redeclare': 'error',
            'no-unsafe-negation': 'error',
            'no-constant-condition': 'error',
        },
    },
];
