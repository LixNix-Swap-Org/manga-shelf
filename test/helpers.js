const fs = require('fs');
const os = require('os');
const path = require('path');

/** Creates an isolated data dir, loads the app against it and starts it on an ephemeral port. */
async function startTestServer() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-test-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.JWT_SECRET;

    process.env.MANGA_SHELF_NO_LISTEN = '1';
    const app = require('../index.js');
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;

    // Minimal cookie-aware client
    const client = (cookie = '') => {
        const api = async (method, url, body, extraHeaders = {}) => {
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

    return { client, close, dataDir, base };
}

module.exports = { startTestServer };
