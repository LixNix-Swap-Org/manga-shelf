const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { startTestServer } = require('./helpers');

// Behaviour that changed between Express 4 and 5 (catch-all route, missing req.body, query parsing), static files
// and the SPA fallback (against a fixture build inside a dot-directory), error texts and the CSV body limit.
let ctx;
let editor;
let rootUrl;
let frontendRoot;

const MARKER = '<div id="root"></div>';
const APP_JS = 'export const greeting = "hallo";\n'.repeat(200);
const ENGLISH = /too large|Unexpected|Expected property|in JSON at position|Failed to decode|Not Found|Cannot (GET|POST)/i;

test.before(async () => {
    frontendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-frontend-'));
    const dist = path.join(frontendRoot, '.app', 'dist');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><html><body>${MARKER}</body></html>`);
    fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1);');
    fs.writeFileSync(path.join(dist, 'assets', 'app-x.js'), APP_JS);
    fs.writeFileSync(path.join(dist, 'assets', 'app-x.js.br'), zlib.brotliCompressSync(APP_JS));
    fs.writeFileSync(path.join(dist, 'assets', 'app-x.js.gz'), zlib.gzipSync(APP_JS));
    fs.writeFileSync(path.join(dist, 'assets', 'big-x.js'), 'x');
    fs.writeFileSync(path.join(dist, 'assets', 'big-x.js.br'), require('crypto').randomBytes(16 * 1024 * 1024));
    fs.writeFileSync(path.join(dist, 'assets', 'mid-x.js'), 'x');
    fs.writeFileSync(path.join(dist, 'assets', 'mid-x.js.br'), require('crypto').randomBytes(2 * 1024 * 1024));
    fs.writeFileSync(path.join(dist, 'manifest.json'), '{}');

    ctx = await startTestServer({ env: { FRONTEND_DIR: dist } });
    rootUrl = ctx.root;
    const admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    editor = ctx.client();
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
});

test.after(async () => {
    await ctx.close();
    fs.rmSync(frontendRoot, { recursive: true, force: true });
});

const bare = (client, method, route) => fetch(ctx.base + route, { method, headers: { Cookie: client.cookie } })
    .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

const assertSecurityHeaders = (res, label) => {
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', label);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', label);
    assert.ok(res.headers.get('content-security-policy'), label);
};

test('SPA fallback: deep links get index.html with 200', async () => {
    for (const p of ['/manga/1', '/some/deep/link', '/login']) {
        const res = await fetch(rootUrl + p);
        assert.equal(res.status, 200, p);
        assert.match(res.headers.get('content-type') || '', /text\/html/, p);
        assert.ok((await res.text()).includes(MARKER), p);
    }
    const head = await fetch(rootUrl + '/manga/1', { method: 'HEAD' });
    assert.equal(head.status, 200);
    // '/' is answered by express.static, not by the fallback
    const home = await fetch(rootUrl + '/');
    assert.equal(home.status, 200);
    assert.ok((await home.text()).includes(MARKER));
});

test('missing static files are a 404 and never index.html', async () => {
    for (const p of ['/uploads/does-not-exist.jpg', '/uploads/a/b.png', '/assets/index-OLDHASH.js', '/favicon.ico', '/manga/1/cover.png']) {
        const res = await fetch(rootUrl + p);
        assert.equal(res.status, 404, p);
        assert.doesNotMatch(res.headers.get('content-type') || '', /text\/html/, p);
        assert.ok(!(await res.text()).includes(MARKER), p);
    }
    const post = await fetch(rootUrl + '/some/page', { method: 'POST' });
    assert.equal(post.status, 404);
    assert.doesNotMatch(await post.text(), ENGLISH);

    const asset = await fetch(rootUrl + '/assets/index-abc123.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') || '', /javascript/);
    assert.match(asset.headers.get('cache-control') || '', /immutable/);
});

test('uploads: images are served as images, anything else only as a download', async () => {
    const uploads = path.join(ctx.dataDir, 'uploads');
    fs.writeFileSync(path.join(uploads, 'cover-test.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    fs.writeFileSync(path.join(uploads, 'planted.html'), '<script>alert(1)</script>');

    const img = await fetch(rootUrl + '/uploads/cover-test.png');
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type') || '', /^image\/png/);
    assert.match(img.headers.get('content-security-policy') || '', /sandbox/);
    assert.match(img.headers.get('cache-control') || '', /immutable/);
    assert.equal(img.headers.get('content-disposition'), null);

    const html = await fetch(rootUrl + '/uploads/planted.html');
    assert.equal(html.headers.get('content-disposition'), 'attachment');
    assert.match(html.headers.get('content-security-policy') || '', /sandbox/);
});

test('unknown /api paths return a JSON 404 without a stack trace', async () => {
    const res = await fetch(ctx.base + '/does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /json/);
    assert.doesNotMatch(JSON.stringify(await res.json()), /\.js:\d+/);
});

test('malformed JSON body: 400 with a German message and the security headers', async () => {
    const res = await fetch(ctx.base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    assert.equal(res.status, 400);
    assertSecurityHeaders(res, 'malformed');
    const body = await res.json();
    assert.equal(body.error, 'Ungültige Anfrage (fehlerhaftes JSON)');
    assert.doesNotMatch(JSON.stringify(body), /\.js:\d+/);
});

test('oversized JSON body: 413 with a German message and the security headers', async () => {
    const res = await fetch(ctx.base + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'x', password: 'y'.repeat(200 * 1024) })
    });
    assert.equal(res.status, 413);
    assertSecurityHeaders(res, 'too large');
    assert.equal((await res.json()).error, 'Anfrage ist zu groß (max. 100 KB)');
});

test('CSV import: the 10 MB body is only parsed for editors', async () => {
    // Anonymous: rejected before the (malformed) body is read, so 401 and not 400
    const anon = await fetch(ctx.base + '/import/csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{' + 'x'.repeat(300 * 1024)
    });
    assert.equal(anon.status, 401);
    assertSecurityHeaders(anon, 'anonymous csv');

    const rows = Array.from({ length: 6000 }, (_, i) => `Reihe ${i};1;Fehlt`);
    const csv = 'Reihe;Bandnummer;Status\n' + rows.join('\n') + '\n';
    assert.ok(csv.length > 100 * 1024);
    const dry = await editor('POST', '/import/csv', { csv, dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));

    const tooBig = await editor('POST', '/import/csv', { csv: 'a'.repeat(11 * 1024 * 1024) });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error, 'CSV-Datei ist zu groß (max. 10 MB)');
});

test('upload errors from multer are German', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const send = async (route, fill) => {
        const form = new FormData();
        fill(form);
        const res = await fetch(ctx.base + route, { method: 'POST', headers: { Cookie: editor.cookie }, body: form });
        return { status: res.status, body: await res.json() };
    };

    const many = await send('/upload/multiple', (form) => {
        for (let i = 0; i < 11; i++) form.append('images', new Blob([png], { type: 'image/png' }), `p${i}.png`);
    });
    assert.equal(many.status, 400);
    assert.equal(many.body.error, 'Höchstens 10 Bilder auf einmal');

    const big = await send('/upload', (form) => {
        form.append('image', new Blob([png, Buffer.alloc(16 * 1024 * 1024)], { type: 'image/png' }), 'big.png');
    });
    assert.equal(big.status, 400);
    assert.equal(big.body.error, 'Bild ist größer als 15 MB');

    const wrongField = await send('/upload', (form) => {
        form.append('picture', new Blob([png], { type: 'image/png' }), 'p.png');
    });
    assert.equal(wrongField.status, 400);
    assert.equal(wrongField.body.error, 'Unerwartetes Dateifeld im Upload');
    for (const r of [many, big, wrongField]) assert.doesNotMatch(r.body.error, ENGLISH);
});

test('a malformed percent-encoding is a German 400', async () => {
    const res = await fetch(ctx.base + '/mangas/%E0', { headers: { Cookie: editor.cookie } });
    assert.equal(res.status, 400);
    assert.doesNotMatch(JSON.stringify(await res.json()), ENGLISH);
});

test('no CORS headers without CORS_ORIGIN, origins are never reflected', async () => {
    const res = await fetch(ctx.base + '/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
});

test('POST without a body behaves like an empty JSON object (no 500)', async () => {
    const calls = [
        ['POST', '/volumes/batch-read'],
        ['POST', '/mangas/999/sync-edition'],
        ['POST', '/mangas/999/batch-import-gaps'],
        ['POST', '/mangas'],
        ['POST', '/volumes'],
        ['POST', '/volumes/batch'],
        ['POST', '/upload-remote'],
        ['POST', '/import/csv']
    ];
    for (const [method, route] of calls) {
        const res = await bare(editor, method, route);
        assert.ok(res.status >= 400 && res.status < 500, `${method} ${route} -> ${res.status}`);
    }
    const login = await bare(ctx.client(), 'POST', '/auth/login');
    assert.ok(login.status === 400 || login.status === 401, `login without body -> ${login.status}`);
});

test('query strings: numeric and repeated params are handled without crashing', async () => {
    const ok = await bare(editor, 'GET', '/release-radar');
    assert.equal(ok.status, 200);
    const odd = await bare(editor, 'GET', '/manga-passion/editions?title=a&title=b&total_volumes=abc');
    assert.ok(odd.status < 500, `repeated title -> ${odd.status}`);
    const lookup = await bare(editor, 'GET', '/volumes/lookup?manga_id=abc&volume_number=1');
    assert.ok(lookup.status < 500, `lookup -> ${lookup.status}`);
});

test('precompressed assets: brotli or gzip by Accept-Encoding, the plain file otherwise', async () => {
    // fetch decodes bodies (and drops Content-Encoding on HEAD): read the raw response through http
    const raw = (p, encoding, method = 'GET') => new Promise((resolve, reject) => {
        const req = require('http').request(rootUrl + p, { method, headers: { 'Accept-Encoding': encoding } }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
    for (const [encoding, expected, decode] of [['br', 'br', zlib.brotliDecompressSync], ['gzip, deflate', 'gzip', zlib.gunzipSync], ['br;q=0, gzip', 'gzip', zlib.gunzipSync]]) {
        const res = await raw('/assets/app-x.js', encoding);
        assert.equal(res.headers['content-encoding'], expected, encoding);
        assert.match(res.headers['content-type'], /javascript/, encoding);
        assert.match(res.headers.vary || '', /Accept-Encoding/i, encoding);
        assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', encoding);
        assert.equal(decode(res.body).toString(), APP_JS, encoding);
        // the file written by the build, not an on-the-fly compression
        assert.deepEqual(res.body, fs.readFileSync(path.join(frontendRoot, '.app', 'dist', 'assets', `app-x.js.${expected === 'br' ? 'br' : 'gz'}`)), encoding);
    }
    const plain = await raw('/assets/app-x.js', 'identity');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), APP_JS);
    const head = await raw('/assets/app-x.js', 'br', 'HEAD');
    assert.deepEqual([head.status, head.headers['content-encoding'], head.body.length], [200, 'br', 0]);
    for (const p of ['/assets/missing.js', '/assets/../x.js.br', '/assets/sub%2Fapp-x.js']) {
        const res = await raw(p, 'br');
        assert.equal(res.status, 404, p);
        assert.ok(!res.body.toString().includes(MARKER), p);
    }
});

test('a client that aborts a precompressed download mid-stream does not take the server down', async () => {
    const net = require('net');
    const { port } = new URL(rootUrl);
    const abortOnce = (resetAfterHeaders) => new Promise((resolve) => {
        const socket = net.connect(Number(port), '127.0.0.1', () => {
            socket.write('GET /assets/big-x.js HTTP/1.1\r\nHost: x\r\nAccept-Encoding: br\r\n\r\n');
            if (!resetAfterHeaders) socket.resetAndDestroy();
        });
        socket.once('data', () => socket.resetAndDestroy());
        socket.on('error', () => {});
        socket.on('close', resolve);
    });
    for (let i = 0; i < 20; i++) await abortOnce(i % 4 !== 0);
    await new Promise(r => setTimeout(r, 200));
    const health = await fetch(ctx.base + '/health');
    assert.equal(health.status, 200);
    const asset = await fetch(rootUrl + '/assets/app-x.js');
    assert.equal(await asset.text(), APP_JS);
});

test('a read error after the headers of a precompressed asset closes the connection instead of hanging', async (t) => {
    const http = require('http');
    const original = fs.createReadStream;
    t.after(() => { fs.createReadStream = original; });
    fs.createReadStream = function (file, options) {
        const stream = original.call(this, file, options);
        if (String(file).endsWith('mid-x.js.br')) {
            let read = 0;
            stream.on('data', (chunk) => {
                read += chunk.length;
                if (read > 64 * 1024) stream.destroy(Object.assign(new Error('EIO injected'), { code: 'EIO' }));
            });
        }
        return stream;
    };
    const outcome = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ outcome: 'hang' }), 5000);
        const req = http.get(rootUrl + '/assets/mid-x.js', { headers: { 'Accept-Encoding': 'br' } }, (res) => {
            let received = 0;
            res.on('data', c => { received += c.length; });
            res.on('error', () => {});
            res.on('end', () => { clearTimeout(timer); resolve({ outcome: 'end', status: res.statusCode, received }); });
            res.on('close', () => { clearTimeout(timer); resolve({ outcome: res.complete ? 'end' : 'closed', status: res.statusCode, received, length: Number(res.headers['content-length']) }); });
        });
        req.on('error', (err) => { clearTimeout(timer); err.code === 'ECONNRESET' ? resolve({ outcome: 'closed' }) : reject(err); });
    });
    assert.equal(outcome.outcome, 'closed', JSON.stringify(outcome));
    if (outcome.length) assert.ok(outcome.received < outcome.length);
    fs.createReadStream = original;
    assert.equal((await fetch(ctx.base + '/health')).status, 200);
});

test('416 and 412 answers under /assets are not cacheable', async () => {
    for (const [encoding, headers] of [
        ['br', { Range: 'bytes=99999999-' }],
        ['identity', { Range: 'bytes=99999999-' }],
        ['br', { 'If-Match': '"nope"' }],
        ['identity', { 'If-Match': '"nope"' }]
    ]) {
        const res = await fetch(rootUrl + '/assets/app-x.js', { headers: { 'Accept-Encoding': encoding, ...headers } });
        const label = `${encoding} ${JSON.stringify(headers)}`;
        assert.ok([412, 416].includes(res.status), `${label} -> ${res.status}`);
        assert.equal(res.headers.get('cache-control'), 'no-store', label);
        assert.equal(res.headers.get('last-modified'), null, label);
        assert.equal(res.headers.get('etag'), null, label);
        assert.equal(res.headers.get('content-encoding'), null, label);
        await res.arrayBuffer();
    }
});

test('uploads: Cross-Origin-Resource-Policy same-origin for everyone, varied on Origin (app shells load images in CORS mode)', async () => {
    fs.writeFileSync(path.join(ctx.dataDir, 'uploads', 'corp-test.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    for (const origin of [null, 'https://evil.example', 'capacitor://localhost', 'https://localhost', 'app://manga-shelf']) {
        const res = await fetch(rootUrl + '/uploads/corp-test.png', { headers: origin ? { Origin: origin } : {} });
        assert.equal(res.status, 200, String(origin));
        assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin', String(origin));
        assert.match(res.headers.get('vary') || '', /Origin/, String(origin));
    }
});

test('error bodies carry a code; body-parser and multer errors get their own', async () => {
    const malformed = await fetch(ctx.base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.deepEqual(await malformed.json(), { error: 'Ungültige Anfrage (fehlerhaftes JSON)', code: 'INVALID_JSON' });
    const big = await fetch(ctx.base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(200 * 1024) }) });
    assert.equal((await big.json()).code, 'PAYLOAD_TOO_LARGE');
    const unknown = await fetch(ctx.base + '/nope');
    assert.deepEqual(await unknown.json(), { error: 'Nicht gefunden', code: 'NOT_FOUND' });
    const missing = await bare(editor, 'GET', '/mangas/987654');
    assert.deepEqual(missing.body, { error: 'Manga nicht gefunden', code: 'NOT_FOUND' });
    const invalid = await bare(editor, 'POST', '/mangas');
    assert.deepEqual(invalid.body, { error: 'Titel darf nicht leer sein', code: 'BAD_REQUEST' });
    const form = new FormData();
    form.append('picture', new Blob([Buffer.from('89504e47', 'hex')], { type: 'image/png' }), 'p.png');
    const upload = await fetch(ctx.base + '/upload', { method: 'POST', headers: { Cookie: editor.cookie }, body: form });
    assert.equal((await upload.json()).code, 'UPLOAD_REJECTED');
});

test('every response has a request id; a server error names it as reference', async (t) => {
    const ids = new Set();
    for (const url of [rootUrl + '/', ctx.base + '/health', ctx.base + '/nope']) {
        const id = (await fetch(url)).headers.get('x-request-id');
        assert.match(id, /^[0-9a-f]{8}$/, url);
        ids.add(id);
    }
    assert.equal(ids.size, 3);

    const snapshot = require('../core/snapshot');
    t.mock.method(snapshot, 'listMangas', () => { throw new Error('kaputt: /secret/path'); });
    const res = await fetch(ctx.base + '/mangas', { headers: { Cookie: editor.cookie } });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Interner Serverfehler');
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.ref, res.headers.get('x-request-id'));
    assert.doesNotMatch(JSON.stringify(body), /secret/);
});
