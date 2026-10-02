const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    { ignores: ['node_modules/', 'frontend/', 'dist_pack/', 'dist/', 'data/', 'pterodactyl-manga-shelf/', 'scratch/', 'screenshots/', '*_screenshots/', 'gemini_export/'] },
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
    }
];
