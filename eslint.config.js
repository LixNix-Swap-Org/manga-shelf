const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');

module.exports = [
    { ignores: ['.claude/', 'node_modules/', 'frontend/node_modules/', 'frontend/dist/', 'frontend/public/', 'frontend/*.js', 'dist_pack/', 'dist/', 'data/', 'pterodactyl-manga-shelf/', 'scratch/', 'screenshots/', '*_screenshots/', 'gemini_export/'] },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
        rules: {
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-useless-escape': 'warn'
        }
    },
    {
        files: ['test-*.js', 'test/**/*.js', 'scripts/**/*.js'],
        languageOptions: { globals: { ...globals.node, ...globals.browser } }
    },
    {
        // Frontend: only catch undefined identifiers (the class of bug that lint-free builds let through,
        // e.g. handlers left behind when code was moved between components). Unused-var checks stay off
        // because JSX component usage is not tracked without the React plugin.
        files: ['frontend/src/**/*.{js,jsx}'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: { ...globals.browser, __APP_VERSION__: 'readonly' }
        },
        plugins: { react },
        // jsx-no-undef: core no-undef ignores JSX tags, so a missing icon/component import would only crash at runtime.
        rules: { 'no-unused-vars': 'off', 'no-empty': 'off', 'react/jsx-no-undef': 'error' }
    }
];
