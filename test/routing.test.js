const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

// Behaviour that changed between Express 4 and 5 (catch-all route, missing req.body, query parsing).
let ctx;
let editor;
let rootUrl;

test.before(async () => {
    ctx = await startTestServer();
    rootUrl = ctx.base.replace(/\/api$/, '');
    const admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    editor = ctx.client();
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const bare = (client, method, route) => fetch(ctx.base + route, { method, headers: { Cookie: client.cookie } })
    .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

test('SPA fallback: deep links are served HTML instead of crashing the router', async () => {
    for (const p of ['/manga/1', '/some/deep/link', '/']) {
        const res = await fetch(rootUrl + p);
        assert.match(res.headers.get('content-type') || '', /text\/html/, p);
        assert.ok([200, 500].includes(res.status), `${p} -> ${res.status}`); // 500 = frontend not built (CI)
    }
});

test('unknown /api paths return a JSON 404 without a stack trace', async () => {
    const res = await fetch(ctx.base + '/does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /json/);
    assert.doesNotMatch(JSON.stringify(await res.json()), /\.js:\d+/);
});

test('malformed JSON body is a 400 with a message, not a 500 with a stack trace', async () => {
    const res = await fetch(ctx.base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
    assert.doesNotMatch(JSON.stringify(await res.json()), /\.js:\d+/);
});

test('POST without a body behaves like an empty JSON object (no 500)', async () => {
    const calls = [
        ['POST', '/volumes/batch-read'],
        ['POST', '/mangas/999/sync-edition'],
        ['POST', '/mangas/999/batch-import-gaps'],
        ['POST', '/mangas'],
        ['POST', '/volumes'],
        ['POST', '/volumes/batch'],
        ['POST', '/upload-remote']
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
