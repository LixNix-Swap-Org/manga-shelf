const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    { ignores: ['node_modules/', 'frontend/', 'dist_pack/', 'data/', 'pterodactyl-manga-shelf/'] },
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
        // Puppeteer scripts run snippets inside the browser page (page.evaluate)
        files: ['test-*.js', 'verify-*.js', 'seed-remote.js', 'check-remote.js'],
        languageOptions: { globals: { ...globals.node, ...globals.browser } }
    }
];
