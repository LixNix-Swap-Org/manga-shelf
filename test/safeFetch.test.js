const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchRemoteImage, isPrivateAddress, detectImageExt, MAX_IMAGE_BYTES } = require('../utils/safeFetch');

// smallest valid headers for each format the uploads accept
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 2)]);

// The test server runs on 127.0.0.1, which the real check refuses: allow exactly that address
// so the whole download path (lookup, redirects, limits, magic bytes) runs like against a public host.
const onlyTestServer = { isBlockedAddress: (a) => a !== '127.0.0.1' };

let server;
let base;
const routes = {
    '/cover.jpg': (req, res) => { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(JPEG); },
    '/cover.png': (req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); },
    '/moved': (req, res) => { res.writeHead(301, { Location: '/redirect-2' }); res.end(); },
    '/redirect-2': (req, res) => { res.writeHead(302, { Location: base + '/cover.png' }); res.end(); },
    '/loop': (req, res) => { res.writeHead(302, { Location: '/loop' }); res.end(); },
    '/to-other-host': (req, res) => { res.writeHead(302, { Location: 'http://127.0.0.2:' + server.address().port + '/cover.jpg' }); res.end(); },
    '/page.html': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Kein Bild</title>'); },
    '/missing.jpg': (req, res) => { res.writeHead(404); res.end(); },
    '/huge-declared.jpg': (req, res) => { res.writeHead(200, { 'Content-Length': String(MAX_IMAGE_BYTES + 1) }); res.end(); },
    '/huge-stream.jpg': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        const chunk = Buffer.alloc(1024 * 1024, 7);
        let sent = 0;
        const push = () => {
            while (sent <= MAX_IMAGE_BYTES && !res.destroyed) {
                sent += chunk.length;
                if (!res.write(chunk)) return res.once('drain', push);
            }
            res.end();
        };
        push();
    },
    '/drip.jpg': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        const timer = setInterval(() => res.write(Buffer.from([0xff])), 50);
        res.on('close', () => clearInterval(timer));
    }
};

test.before(async () => {
    server = http.createServer((req, res) => (routes[req.url] || routes['/missing.jpg'])(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => {
    server.closeAllConnections();
    server.close();
});

test('isPrivateAddress catches every notation of internal addresses', () => {
    const internal = [
        '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
        '::', '::1', '0:0:0:0:0:0:0:1',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0:7f00:1', '::127.0.0.1',
        '64:ff9b::7f00:1', '64:ff9b:1::1', '2002:7f00:1::', '2002:c0a8:101::1',
        'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378::1',
        'not-an-ip'
    ];
    for (const a of internal) assert.equal(isPrivateAddress(a), true, a);

    const publicHosts = ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1'];
    for (const a of publicHosts) assert.equal(isPrivateAddress(a), false, a);
});

test('isPrivateAddress blocks only the special /24s of 192.0.0.0/16, not public hosts like i0.wp.com', () => {
    const internal = ['192.0.0.1', '192.0.0.8', '192.0.0.170', '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1',
        '::ffff:192.0.0.170', '::ffff:192.0.2.1'];
    for (const a of internal) assert.equal(isPrivateAddress(a), true, a);
    const publicHosts = ['192.0.77.2', '192.0.78.9', '192.0.43.8', '192.0.1.1', '192.0.3.1', '::ffff:192.0.77.2', '2002:c000:4d02::1'];
    for (const a of publicHosts) assert.equal(isPrivateAddress(a), false, a);
});

test('detectImageExt recognises AVIF by its major or a compatible brand', () => {
    const ftyp = (major, compatible) => {
        const brands = [major, '\0\0\0\0', ...compatible].join('');
        const box = Buffer.alloc(8 + brands.length);
        box.writeUInt32BE(box.length, 0);
        box.write('ftyp', 4, 'ascii');
        box.write(brands, 8, 'latin1');
        return Buffer.concat([box, Buffer.alloc(32)]);
    };
    assert.equal(detectImageExt(ftyp('avif', ['mif1'])), '.avif');
    assert.equal(detectImageExt(ftyp('mif1', ['miaf', 'avif'])), '.avif');
    assert.equal(detectImageExt(ftyp('heic', ['mif1', 'heic'])), null);
    assert.equal(detectImageExt(ftyp('isom', ['mp41'])), null);
    assert.equal(detectImageExt(Buffer.from('<html><script>')), null);
    assert.equal(detectImageExt(Buffer.alloc(4)), null);
});

test('blocks loopback in every URL notation by default', async () => {
    const port = server.address().port;
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[64:ff9b::7f00:1]']) {
        await assert.rejects(fetchRemoteImage(`http://${host}:${port}/cover.jpg`), /nicht erlaubt/, host);
    }
});

test('downloads a cover and detects its format', async () => {
    const jpg = await fetchRemoteImage(base + '/cover.jpg', onlyTestServer);
    assert.equal(jpg.ext, '.jpg');
    assert.deepEqual(jpg.buffer, JPEG);
    const png = await fetchRemoteImage(base + '/cover.png', onlyTestServer);
    assert.equal(png.ext, '.png');
});

test('follows relative and absolute redirects, but not endlessly', async () => {
    const res = await fetchRemoteImage(base + '/moved', onlyTestServer);
    assert.equal(res.ext, '.png');
    await assert.rejects(fetchRemoteImage(base + '/loop', onlyTestServer), /Zu viele Weiterleitungen/);
});

test('a redirect target is checked again', async () => {
    // 127.0.0.2 is not on the allow list here, just like an internal host behind a public redirect
    await assert.rejects(fetchRemoteImage(base + '/to-other-host', onlyTestServer), /nicht erlaubt/);
});

test('rejects non-images and failed responses', async () => {
    await assert.rejects(fetchRemoteImage(base + '/page.html', onlyTestServer), /kein gültiges Bild/);
    await assert.rejects(fetchRemoteImage(base + '/missing.jpg', onlyTestServer), /Status 404/);
    await assert.rejects(fetchRemoteImage('ftp://example.com/a.jpg'), /http\(s\)/);
    await assert.rejects(fetchRemoteImage('http://user:pw@example.com/a.jpg'), /Zugangsdaten/);
});

test('enforces the size cap, declared or streamed', async () => {
    await assert.rejects(fetchRemoteImage(base + '/huge-declared.jpg', onlyTestServer), /zu groß/);
    await assert.rejects(fetchRemoteImage(base + '/huge-stream.jpg', onlyTestServer), /zu groß/);
});

test('a server that keeps dripping bytes hits the overall deadline', async () => {
    const started = Date.now();
    await assert.rejects(
        fetchRemoteImage(base + '/drip.jpg', { ...onlyTestServer, idleTimeoutMs: 5000, totalTimeoutMs: 300 }),
        /Zeitüberschreitung/
    );
    assert.ok(Date.now() - started < 2000);
});
