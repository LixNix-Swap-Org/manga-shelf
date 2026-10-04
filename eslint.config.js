// Flat ESLint config; core/ is held to browser-safe code (no Node API) because it also runs inside the apps.
const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');

const CORE_NOT_ALLOWED = new Set(['fetch', 'crypto', 'Crypto', 'navigator', 'Navigator', 'WebSocket']);
// the Node globals the "**/*.js" block adds are switched off again; fetch and crypto come from ctx (ctx.http, ctx.randomId)
const CORE_GLOBALS = Object.fromEntries([
    ...Object.keys(globals.node).map(name => [name, 'off']),
    ...Object.entries(globals['shared-node-browser']).map(([name, value]) => [name, CORE_NOT_ALLOWED.has(name) ? 'off' : value]),
    ...Object.entries(globals.commonjs)
]);
const CORE_SYNTAX = [
    { selector: "CallExpression[callee.name='require'][arguments.0.type!='Literal']", message: 'core/: nur feste relative Pfade in require()' },
    { selector: "CallExpression[callee.name='require'][arguments.length!=1]", message: 'core/: require() mit genau einem festen Pfad' },
    { selector: "Identifier[name='require']:not(.callee)", message: 'core/: require nur direkt aufrufen (kein module.require, kein Alias)' },
    { selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='constructor']", message: 'core/: kein Function-Konstruktor über .constructor()' }
];
// es2020 is the floor of the apps (iOS 14/15): no newer syntax, no AbortSignal.any/timeout or Object.hasOwn (core/lib/signals.js)
const CORE_PROPERTIES = [
    ...['process', 'Buffer', 'require', 'module', 'global', 'setImmediate', 'fetch', 'crypto'].map(property => (
        { object: 'globalThis', property, message: 'core/: keine Node-API über globalThis (ctx bringt den Rest)' })),
    { object: 'AbortSignal', property: 'any', message: 'core/: anySignal() aus core/lib/signals.js (iOS 14/15)' },
    { object: 'AbortSignal', property: 'timeout', message: 'core/: timeoutSignal() aus core/lib/signals.js (iOS 14/15)' },
    { object: 'Object', property: 'hasOwn', message: 'core/: Object.prototype.hasOwnProperty.call (iOS 14/15)' }
];

// `outside`: require literals that leave core/ (any '..' segment beyond the one leading '../' a subdirectory may use)
function coreRules() {
    const block = (files, outside, ignores) => ({
        files,
        ...(ignores ? { ignores } : {}),
        languageOptions: { ecmaVersion: 2020, globals: CORE_GLOBALS },
        rules: {
            'no-restricted-syntax': ['error',
                ...CORE_SYNTAX,
                { selector: `CallExpression[callee.name='require'][arguments.0.value=${outside}]`, message: 'core/ darf nur Module aus core/ laden (keine Node-API, keine Pakete, kein Server-Code)' }
            ],
            'no-restricted-properties': ['error', ...CORE_PROPERTIES],
            'no-new-func': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error'
        }
    });
    return [
        block(['core/*.js'], '/^(?!\\.\\/)|(^|\\/)\\.\\.(\\/|$)/'),
        block(['core/**/*.js'], '/^(?!\\.\\.?\\/)|^\\.\\.?\\/(.*\\/)?\\.\\.(\\/|$)/', ['core/*.js'])
    ];
}

module.exports = [
    { ignores: ['.claude/', 'node_modules/', 'frontend/node_modules/', 'frontend/dist/', 'frontend/dist-app/', 'desktop/dist/', 'desktop/node_modules/', 'mobile/node_modules/', 'mobile/www/', 'mobile/build/', 'mobile/ios/App/App/public/', 'mobile/android/app/src/main/assets/public/', 'mobile/android/**/build/', 'mobile/ios/App/Pods/', 'dist_pack/', 'dist/', 'data/', 'data-dev/', 'pterodactyl-manga-shelf/', 'scratch/', 'screenshots/', '*_screenshots/', 'gemini_export/'] },
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
    // core/ runs on the server and in the apps: no Node API, no packages, nothing outside core/ (ctx brings the rest)
    ...coreRules(),
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
