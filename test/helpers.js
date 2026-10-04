const fs = require('fs');
const os = require('os');
const path = require('path');

// Settings that change test outcomes. index.js skips .env when MANGA_SHELF_NO_LISTEN=1, and these override whatever
// the developer's shell exports. TRUST_PROXY=true lets tests pick a client address via X-Forwarded-For.
const HERMETIC_ENV = {
    TRUST_PROXY: 'true',
    SETUP_TOKEN: 'test-setup-token',
    CORS_ORIGIN: '',
    COOKIE_SECURE: '',
    FRONTEND_DIR: undefined,
    JWT_SECRET: undefined,
    APP_ORIGINS: undefined
};

let started = false;

/**
 * Creates an isolated data dir, loads the app against it and starts it on an ephemeral port.
 * Only once per process: db.js, auth and the rate limiters keep their state from the first require, so a second
 * server would silently keep using the first (deleted) data dir. Tests in one file share one ctx via before/after.
 * `options.env` sets further variables (undefined removes one) before the app is loaded.
 */
async function startTestServer(options = {}) {
    if (started) {
        throw new Error('startTestServer() may only be called once per process: db.js and index.js cache DATA_DIR at require time. Share one ctx through before/after or put the test into its own file.');
    }
    if (require.cache[require.resolve('../db')]) {
        throw new Error('db.js was loaded before startTestServer(): it would keep its own DATA_DIR. Require app modules only after the server has started.');
    }
    started = true;

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-test-'));
    const env = { ...HERMETIC_ENV, ...options.env, DATA_DIR: dataDir, MANGA_SHELF_NO_LISTEN: '1' };
    if (process.env.LOG_LEVEL === undefined && !('LOG_LEVEL' in env)) env.LOG_LEVEL = 'silent';
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }

    const app = require('../index.js');
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const root = `http://127.0.0.1:${server.address().port}`;
    const base = `${root}/api`;

    // Minimal cookie-aware client
    const client = (cookie = '') => {
        const api = async (method, url, body, extraHeaders = {}) => {
            // POST /setup needs the first-run code; a test that wants to send its own passes setup_token explicitly
            if (method === 'POST' && url === '/setup' && body && typeof body === 'object' && !('setup_token' in body)) {
                body = { ...body, setup_token: process.env.SETUP_TOKEN };
            }
            const res = await fetch(base + url, {
                method,
                headers: { 'Content-Type': 'application/json', ...(api.cookie ? { Cookie: api.cookie } : {}), ...extraHeaders },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const set = res.headers.get('set-cookie');
            if (set) api.cookie = set.split(';')[0];
            let json = null;
            try { json = await res.json(); } catch (e) { /* no body */ }
            return { status: res.status, body: json };
        };
        api.cookie = cookie;
        return api;
    };

    const close = async () => {
        await new Promise((resolve) => server.close(resolve));
        require('../db').closeDb();
        fs.rmSync(dataDir, { recursive: true, force: true });
    };

    return { client, close, dataDir, base, root };
}

module.exports = { startTestServer };
