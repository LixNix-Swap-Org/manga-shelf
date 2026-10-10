// General request limit in front of every route and the path guard of the precompressed assets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { startTestServer } = require('./helpers');

const PER_MINUTE = 4;
const STATIC_PER_MINUTE = 10;
const UPLOADS_PER_MINUTE = 80;
const APP_JS = 'export const greeting = "hallo";\n'.repeat(200);
const SECRET = 'outside-the-assets-folder';

let ctx;
let frontendRoot;
let nextAddress = 1;
const freshClient = () => `10.77.0.${nextAddress++}`;
const stores = [];

test.before(async () => {
    if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'silent';
    const limits = require('../middleware/rateLimit');
    const createLimiterStore = limits.createLimiterStore;
    limits.createLimiterStore = (options) => {
        const store = createLimiterStore(options);
        stores.push(store);
        return store;
    };
    frontendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-umbrella-'));
    const dist = path.join(frontendRoot, 'dist');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
    fs.writeFileSync(path.join(dist, 'assets', 'app-x.js'), APP_JS);
    fs.writeFileSync(path.join(dist, 'assets', 'app-x.js.br'), zlib.brotliCompressSync(APP_JS));
    fs.writeFileSync(path.join(dist, 'secret.js.br'), zlib.brotliCompressSync(SECRET));
    fs.writeFileSync(path.join(frontendRoot, 'secret.js.br'), zlib.brotliCompressSync(SECRET));
    ctx = await startTestServer({ env: { FRONTEND_DIR: dist, RATE_LIMIT_UMBRELLA: String(PER_MINUTE) } });
});

test.after(async () => {
    await ctx.close();
    fs.rmSync(frontendRoot, { recursive: true, force: true });
});

function request(base, p, { client, method = 'GET', headers = {} } = {}) {
    const { hostname, port } = new URL(base);
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname, port, path: p, method, headers: { 'X-Forwarded-For': client, ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

const json = (res) => JSON.parse(res.body.toString());

test('API: the configured number of requests per minute passes, the next one gets a 429 with the app error body', async () => {
    const client = freshClient();
    for (let i = 1; i <= PER_MINUTE; i++) {
        const res = await request(ctx.root, '/api/health', { client });
        assert.equal(res.status, 200, `request ${i}`);
        assert.equal(res.headers['ratelimit-policy'], `${PER_MINUTE};w=60`);
        assert.match(res.headers.ratelimit, new RegExp(`^limit=${PER_MINUTE}, remaining=${PER_MINUTE - i}, reset=\\d+$`));
        assert.equal(res.headers['x-ratelimit-limit'], undefined, 'no legacy headers');
    }
    const limited = await request(ctx.root, '/api/health', { client });
    assert.equal(limited.status, 429);
    assert.match(limited.headers['content-type'], /application\/json/);
    assert.deepEqual(json(limited), { error: 'Zu viele Anfragen – bitte kurz warten.', code: 'TOO_MANY_REQUESTS' });
    assert.ok(Number(limited.headers['retry-after']) >= 1, 'Retry-After in seconds');
    assert.equal(limited.headers['cache-control'], 'no-store');
    assert.ok(limited.headers['x-request-id']);
    assert.equal(limited.headers['x-content-type-options'], 'nosniff');
});

test('API: the limit sits in front of every router, other clients keep their own budget', async () => {
    const client = freshClient();
    for (let i = 0; i < PER_MINUTE; i++) await request(ctx.root, '/api/health', { client });
    const login = await request(ctx.root, '/api/auth/login', {
        client, method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(login.status, 429);
    assert.equal(json(login).code, 'TOO_MANY_REQUESTS');
    for (const p of ['/api/auth/me', '/API/health', '/api/unknown-route']) {
        assert.equal((await request(ctx.root, p, { client })).status, 429, p);
    }
    assert.equal((await request(ctx.root, '/api/health', { client: freshClient() })).status, 200);
});

test('static files and the SPA share a separate, larger budget (2.5 times the API one)', async () => {
    const client = freshClient();
    const paths = ['/', '/assets/app-x.js', '/manga/1', '/favicon.ico', '/assets/missing.js'];
    for (let i = 0; i < STATIC_PER_MINUTE; i++) {
        const p = paths[i % paths.length];
        const res = await request(ctx.root, p, { client });
        assert.ok(res.status === 200 || res.status === 404, `${p} -> ${res.status}`);
        assert.equal(res.headers['ratelimit-policy'], `${STATIC_PER_MINUTE};w=60`, p);
    }
    const limited = await request(ctx.root, '/manga/2', { client });
    assert.equal(limited.status, 429);
    assert.match(limited.headers['content-type'], /text\/plain/);
    assert.equal(limited.body.toString(), 'Zu viele Anfragen – bitte kurz warten.');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal((await request(ctx.root, '/uploads/missing.jpg', { client })).status, 404, 'the uploads budget is separate');
    assert.equal((await request(ctx.root, '/api/health', { client })).status, 200, 'the API budget is separate');
});

test('uploads have their own budget (20 times the API one), so taking a collection over does not lose covers', async () => {
    const client = freshClient();
    for (let i = 1; i <= UPLOADS_PER_MINUTE; i++) {
        const res = await request(ctx.root, `/uploads/cover-${i}.jpg`, { client });
        assert.equal(res.status, 404, `request ${i}`);
        assert.equal(res.headers['ratelimit-policy'], `${UPLOADS_PER_MINUTE};w=60`);
    }
    const limited = await request(ctx.root, '/UPLOADS/cover-0.jpg', { client });
    assert.equal(limited.status, 429);
    assert.match(limited.headers['content-type'], /text\/plain/);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal((await request(ctx.root, '/manga/1', { client })).status, 200, 'the web app budget is separate');
    assert.equal((await request(ctx.root, '/api/health', { client })).status, 200, 'the API budget is separate');
});

test('a long forwarded address is stored as a short key and still counted per client', async () => {
    assert.equal(stores.length, 1, 'index.js builds the umbrella on createLimiterStore');
    const [store] = stores;
    const long = (c) => c.repeat(8000);
    for (let i = 0; i < 40; i++) {
        const res = await request(ctx.root, '/api/health', { client: long(String.fromCharCode(97 + (i % 26))) + i });
        assert.equal(res.status, 200);
    }
    assert.ok(store.keys().every((k) => k.length <= 300), 'no key keeps the forwarded value');
    const client = long('z');
    for (let i = 0; i < PER_MINUTE; i++) assert.equal((await request(ctx.root, '/api/health', { client })).status, 200);
    assert.equal((await request(ctx.root, '/api/health', { client })).status, 429, 'the hashed key counts like the address');
    assert.equal((await request(ctx.root, '/api/health', { client: long('y') })).status, 200);
});

test('RATE_LIMIT_UMBRELLA=0 switches the limit off', async () => {
    const previous = process.env.RATE_LIMIT_UMBRELLA;
    process.env.RATE_LIMIT_UMBRELLA = '0';
    let server;
    try {
        const app = require('../index.js').createApp();
        server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        const client = freshClient();
        for (let i = 0; i < STATIC_PER_MINUTE + 5; i++) {
            const api = await request(base, '/api/health', { client });
            assert.equal(api.status, 200, `API request ${i + 1}`);
            assert.equal(api.headers.ratelimit, undefined);
            assert.equal((await request(base, '/manga/1', { client })).status, 200, `SPA request ${i + 1}`);
        }
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        process.env.RATE_LIMIT_UMBRELLA = previous;
    }
});

test('RATE_LIMIT_UMBRELLA: whole numbers from 0, otherwise a German warning and the default 1200', () => {
    const { readConfig } = require('../utils/config');
    assert.equal(readConfig({}).values.rateLimitUmbrella, 1200);
    assert.equal(readConfig({ RATE_LIMIT_UMBRELLA: '0' }).values.rateLimitUmbrella, 0);
    assert.equal(readConfig({ RATE_LIMIT_UMBRELLA: ' 3000 ' }).values.rateLimitUmbrella, 3000);
    for (const bad of ['-1', 'viele', '1.5']) {
        const { values, warnings } = readConfig({ RATE_LIMIT_UMBRELLA: bad });
        assert.equal(values.rateLimitUmbrella, 1200, bad);
        assert.match(warnings[0], /^RATE_LIMIT_UMBRELLA=".*" ist ungültig/, bad);
    }
    const huge = readConfig({ RATE_LIMIT_UMBRELLA: '5000000' });
    assert.equal(huge.values.rateLimitUmbrella, 100000);
    assert.match(huge.warnings[0], /ist zu groß/);
});

test('precompressed assets: served from the assets folder only, traversal attempts are a 404', async () => {
    const ok = await request(ctx.root, '/assets/app-x.js', { client: freshClient(), headers: { 'Accept-Encoding': 'br' } });
    assert.equal(ok.headers['content-encoding'], 'br');
    assert.equal(zlib.brotliDecompressSync(ok.body).toString(), APP_JS);
    for (const p of ['/assets/../secret.js', '/assets/..%2Fsecret.js', '/assets/%2E%2E%2Fsecret.js', '/assets/..%5Csecret.js', '/assets/..%2F..%2Fsecret.js']) {
        const res = await request(ctx.root, p, { client: freshClient(), headers: { 'Accept-Encoding': 'br' } });
        assert.ok(res.status === 404 || res.status === 403, `${p} -> ${res.status}`);
        assert.equal(res.headers['content-encoding'], undefined, p);
        assert.ok(!res.body.includes(zlib.brotliCompressSync(SECRET)), p);
    }
});
