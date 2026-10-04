// Image upload endpoints: type, magic byte and size checks and EXIF handling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer } = require('./helpers');

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const UUID_PNG = /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;

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
    assert.match(res.body.url, UUID_PNG);
    const stored = path.join(ctx.dataDir, 'uploads', path.basename(res.body.url));
    assert.ok(fs.existsSync(stored));
    assert.deepEqual(fs.readFileSync(stored), PNG);
});

test('upload: non-image type or extension is rejected and nothing is stored', async () => {
    const uploadsDir = path.join(ctx.dataDir, 'uploads');
    const before = fs.readdirSync(uploadsDir).length;
    const badMime = await post(editor, '/upload', form('image', [{ name: 'x.png', type: 'text/plain', data: Buffer.from('hi') }]));
    const badExt = await post(editor, '/upload', form('image', [{ name: 'x.html', type: 'image/png', data: Buffer.from('<b>') }]));
    assert.equal(badMime.status, 400);
    assert.equal(badExt.status, 400);
    assert.match(badMime.body.error, /Ungültiger Dateityp/);
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
    assert.equal(res.status, 400);
});

test('upload: visitors are forbidden', async () => {
    const res = await post(visitor, '/upload', form('image', [{ name: 'cover.png', type: 'image/png', data: PNG }]));
    assert.equal(res.status, 403);
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(64, 1)]);
const uploadsCount = () => fs.readdirSync(path.join(ctx.dataDir, 'uploads')).length;

test('upload: HTML bytes behind an image MIME type and .png name are rejected and not stored', async () => {
    const before = uploadsCount();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const res = await post(editor, '/upload', form('image', [{ name: 'evil.png', type: 'image/png', data: html }]));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Ungültiger Dateityp/);
    const tiny = await post(editor, '/upload', form('image', [{ name: 'tiny.gif', type: 'image/gif', data: Buffer.from('GIF8') }]));
    assert.equal(tiny.status, 400);
    assert.equal(uploadsCount(), before);
});

test('upload/multiple: one fake image rejects the whole request and leaves no file behind', async () => {
    const before = uploadsCount();
    const res = await post(editor, '/upload/multiple', form('images', [
        { name: 'ok.png', type: 'image/png', data: PNG },
        { name: 'fake.jpg', type: 'image/jpeg', data: Buffer.from('PK\u0003\u0004 not an image at all') }
    ]));
    assert.equal(res.status, 400);
    assert.equal(uploadsCount(), before);
});

test('upload: a real image with the wrong extension is stored under the detected one', async () => {
    const png = await post(editor, '/upload', form('image', [{ name: 'cover.jpg', type: 'image/jpeg', data: PNG }]));
    assert.equal(png.status, 200);
    assert.match(png.body.url, UUID_PNG);
    assert.deepEqual(fs.readFileSync(path.join(ctx.dataDir, 'uploads', path.basename(png.body.url))), PNG);

    const jpeg = await post(editor, '/upload', form('image', [{ name: 'cover.jpeg', type: 'image/jpeg', data: JPEG }]));
    assert.equal(jpeg.status, 200);
    assert.match(jpeg.body.url, /\.jpeg$/);

    const multi = await post(editor, '/upload/multiple', form('images', [{ name: 'a.webp', type: 'image/webp', data: JPEG }]));
    assert.equal(multi.status, 200);
    assert.match(multi.body.urls[0], /\.jpg$/);
    assert.ok(fs.existsSync(path.join(ctx.dataDir, 'uploads', path.basename(multi.body.urls[0]))));
});

function gpsJpeg() {
    const seg = (marker, payload) => {
        const head = Buffer.from([0xff, marker, 0, 0]);
        head.writeUInt16BE(payload.length + 2, 2);
        return Buffer.concat([head, payload]);
    };
    // big-endian TIFF: IFD0 with Orientation = 6 and a Make string standing in for the GPS block
    const tiff = Buffer.alloc(38 + 11);
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(2, 8);
    tiff.writeUInt16BE(0x010f, 10); tiff.writeUInt16BE(2, 12); tiff.writeUInt32BE(11, 14); tiff.writeUInt32BE(38, 18);
    tiff.writeUInt16BE(0x0112, 22); tiff.writeUInt16BE(3, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt16BE(6, 30);
    tiff.write('GPS-SECRET\0', 38, 'latin1');
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])),
        seg(0xfe, Buffer.from('GPS-SECRET comment')),
        seg(0xdb, Buffer.alloc(65, 1)),
        seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
        Buffer.from([0x12, 0x34, 0xff, 0xd9])
    ]);
}

test('upload: EXIF with a GPS position and comments are removed, the orientation is kept', async () => {
    const photo = gpsJpeg();
    const res = await post(editor, '/upload', form('image', [{ name: 'IMG_0001.jpg', type: 'image/jpeg', data: photo }]));
    assert.equal(res.status, 200);
    const stored = fs.readFileSync(path.join(ctx.dataDir, 'uploads', path.basename(res.body.url)));
    assert.equal(stored.includes('GPS-SECRET'), false);
    assert.equal(require('../utils/imageMeta').readExifOrientation(stored.subarray(6)), 6);

    const pngChunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const iend = PNG.indexOf('IEND') - 4;
    const tagged = Buffer.concat([PNG.subarray(0, iend), pngChunk('tEXt', Buffer.from('Comment\0GPS-SECRET', 'latin1')), PNG.subarray(iend)]);
    const multi = await post(editor, '/upload/multiple', form('images', [{ name: 'a.png', type: 'image/png', data: tagged }]));
    assert.equal(multi.status, 200);
    assert.deepEqual(fs.readFileSync(path.join(ctx.dataDir, 'uploads', path.basename(multi.body.urls[0]))), PNG);
});

const uploadsDir = () => path.join(ctx.dataDir, 'uploads');
const tagPng = () => {
    const iend = PNG.indexOf('IEND') - 4;
    const chunk = Buffer.concat([Buffer.from([0, 0, 0, 18]), Buffer.from('tEXtComment\0GPS-SECRET', 'latin1'), Buffer.alloc(4)]);
    return Buffer.concat([PNG.subarray(0, iend), chunk, PNG.subarray(iend)]);
};

test('stripImageFile and stripImageFileSync rewrite a file in place, keep its mtime and leave no temp file', async () => {
    const { stripImageFile, stripImageFileSync } = require('../middleware/upload');
    const dir = fs.mkdtempSync(path.join(ctx.dataDir, 'strip-'));
    const old = new Date('2020-01-02T03:04:05Z');
    const a = path.join(dir, 'a.jpg');
    const b = path.join(dir, 'b.png');
    const clean = path.join(dir, 'c.png');
    fs.writeFileSync(a, gpsJpeg());
    fs.writeFileSync(b, tagPng());
    fs.writeFileSync(clean, PNG);
    fs.utimesSync(a, old, old);
    assert.equal(await stripImageFile(a), true);
    assert.equal(stripImageFileSync(b), true);
    assert.equal(await stripImageFile(clean), false);
    assert.equal(stripImageFileSync(clean), false);
    assert.equal(fs.readFileSync(a).includes('GPS-SECRET'), false);
    assert.deepEqual(fs.readFileSync(b), PNG);
    assert.equal(fs.statSync(a).mtimeMs, old.getTime());
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.jpg', 'b.png', 'c.png']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('existing uploads are stripped once in the background and the run is recorded', async () => {
    const { db } = require('../db');
    const { stripExistingUploadsOnce } = require('../services/scheduler');
    db.prepare("DELETE FROM app_settings WHERE key = 'uploads_metadata_stripped'").run();
    const names = Array.from({ length: 45 }, (_, i) => `legacy-${i}.jpg`);
    for (const n of names) fs.writeFileSync(path.join(uploadsDir(), n), gpsJpeg());
    fs.writeFileSync(path.join(uploadsDir(), 'legacy.png'), tagPng());
    fs.writeFileSync(path.join(uploadsDir(), 'legacy.gif'), Buffer.from('GIF89a GPS-SECRET'));

    const stopped = await stripExistingUploadsOnce({ shouldStop: () => true });
    assert.equal(stopped.done, false);
    assert.equal(db.prepare("SELECT 1 FROM app_settings WHERE key = 'uploads_metadata_stripped'").get(), undefined);

    const run = await stripExistingUploadsOnce();
    assert.equal(run.done, true);
    assert.ok(run.stripped >= names.length + 1);
    for (const n of [...names, 'legacy.png']) assert.equal(fs.readFileSync(path.join(uploadsDir(), n)).includes('GPS-SECRET'), false, n);
    assert.ok(fs.readFileSync(path.join(uploadsDir(), 'legacy.gif')).includes('GPS-SECRET'), 'unsupported formats stay as they are');
    assert.ok(db.prepare("SELECT value FROM app_settings WHERE key = 'uploads_metadata_stripped'").get());
    assert.equal(fs.readdirSync(uploadsDir()).some(n => n.startsWith('.strip-')), false);

    fs.writeFileSync(path.join(uploadsDir(), 'later.jpg'), gpsJpeg());
    assert.deepEqual(await stripExistingUploadsOnce(), { done: true, files: 0, stripped: 0 });
    assert.ok(fs.readFileSync(path.join(uploadsDir(), 'later.jpg')).includes('GPS-SECRET'), 'the pass runs only once');
    for (const n of [...names, 'legacy.png', 'legacy.gif', 'later.jpg']) fs.unlinkSync(path.join(uploadsDir(), n));
});

test('upload: a marker-dense 14 MB JPEG is accepted unchanged without parsing every marker', async () => {
    const bomb = Buffer.alloc(14 * 1024 * 1024);
    for (let i = 0; i < bomb.length; i += 2) { bomb[i] = 0xff; bomb[i + 1] = 0xd0; }
    bomb[1] = 0xd8;
    bomb[3] = 0xd8;
    const started = Date.now();
    const res = await post(editor, '/upload', form('image', [{ name: 'bomb.jpg', type: 'image/jpeg', data: bomb }]));
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 5000);
    const stored = path.join(uploadsDir(), path.basename(res.body.url));
    assert.equal(fs.statSync(stored).size, bomb.length);
    fs.unlinkSync(stored);
});
