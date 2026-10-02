const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer } = require('./helpers');

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let ctx;
let editor;
let visitor;

test.before(async () => {
    ctx = await startTestServer();
    const admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'vis', password: 'password123', role: 'visitor' })).status, 200);
    editor = ctx.client();
    visitor = ctx.client();
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
    assert.equal((await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

function form(field, files) {
    const fd = new FormData();
    for (const f of files) fd.append(field, new Blob([f.data], { type: f.type }), f.name);
    return fd;
}

async function post(client, route, fd) {
    const res = await fetch(ctx.base + route, { method: 'POST', headers: { Cookie: client.cookie }, body: fd });
    let body = null;
    try { body = await res.json(); } catch (e) { /* no JSON body */ }
    return { status: res.status, body };
}

test('upload: valid PNG is stored under data/uploads and returns its URL', async () => {
    const res = await post(editor, '/upload', form('image', [{ name: 'cover.png', type: 'image/png', data: PNG }]));
    assert.equal(res.status, 200);
    assert.match(res.body.url, /^\/uploads\/\d+-\d+\.png$/);
    const stored = path.join(ctx.dataDir, 'uploads', path.basename(res.body.url));
    assert.ok(fs.existsSync(stored));
    assert.deepEqual(fs.readFileSync(stored), PNG);
});

test('upload: non-image type or extension is rejected and nothing is stored', async () => {
    const uploadsDir = path.join(ctx.dataDir, 'uploads');
    const before = fs.readdirSync(uploadsDir).length;
    const badMime = await post(editor, '/upload', form('image', [{ name: 'x.png', type: 'text/plain', data: Buffer.from('hi') }]));
    const badExt = await post(editor, '/upload', form('image', [{ name: 'x.html', type: 'image/png', data: Buffer.from('<b>') }]));
    assert.ok(badMime.status >= 400, `bad mime status ${badMime.status}`);
    assert.ok(badExt.status >= 400, `bad ext status ${badExt.status}`);
    assert.equal(fs.readdirSync(uploadsDir).length, before);
});

test('upload: missing file returns 400', async () => {
    const res = await post(editor, '/upload', new FormData());
    assert.equal(res.status, 400);
});

test('upload/multiple: stores several images and returns all URLs', async () => {
    const files = [1, 2, 3].map(i => ({ name: `p${i}.png`, type: 'image/png', data: PNG }));
    const res = await post(editor, '/upload/multiple', form('images', files));
    assert.equal(res.status, 200);
    assert.equal(res.body.urls.length, 3);
    assert.equal(new Set(res.body.urls).size, 3);
});

test('upload/multiple: more than 10 files are rejected', async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ name: `p${i}.png`, type: 'image/png', data: PNG }));
    const res = await post(editor, '/upload/multiple', form('images', files));
    assert.ok(res.status >= 400);
});

test('upload: visitors are forbidden', async () => {
    const res = await post(visitor, '/upload', form('image', [{ name: 'cover.png', type: 'image/png', data: PNG }]));
    assert.equal(res.status, 403);
});
