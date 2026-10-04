const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = [
    { ignores: ['.claude/', 'node_modules/', 'frontend/node_modules/', 'frontend/dist/', 'frontend/dist-app/', 'dist_pack/', 'dist/', 'data/', 'data-dev/', 'pterodactyl-manga-shelf/', 'scratch/', 'screenshots/', '*_screenshots/', 'gemini_export/'] },
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
        files: ['frontend/*.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } }
    },
    {
        // classic worker script; __APP_VERSION__ is a string placeholder replaced in dist/sw.js
        files: ['frontend/public/sw.js'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.serviceworker } }
    },
    {
        files: ['frontend/src/**/*.{js,jsx}'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: { ...globals.browser, __APP_VERSION__: 'readonly' }
        },
        settings: { react: { version: '18.3' } },
        plugins: { react, 'react-hooks': reactHooks },
        rules: {
            ...react.configs.flat.recommended.rules,
            ...react.configs.flat['jsx-runtime'].rules,
            'react/prop-types': 'off',
            'react/jsx-uses-vars': 'error',
            // core no-undef ignores JSX tags, so a missing icon/component import would only crash at runtime
            'react/jsx-no-undef': 'error',
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
            'no-empty': 'off'
        }
    }
];
