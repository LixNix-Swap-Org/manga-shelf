process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const net = require('net');
const dns = require('dns');
const download = require('../../services/update/download');
const { makeSafeLookup, isPrivateAddress } = require('../../utils/safeFetch');
const h = require('../fixtures/update/helpers');

const pair = h.tlsPair();
const skip = pair ? false : 'openssl is not available';
const PAYLOAD = Buffer.alloc(300 * 1024, 7);

class LocalAgent extends https.Agent {
    constructor(port) {
        super({ keepAlive: false });
        this.localPort = port;
    }

    createConnection(options) {
        return tls.connect({ ...options, host: '127.0.0.1', port: this.localPort, servername: options.servername || options.host, ca: pair.cert });
    }
}

let server;
let agent;
const hits = [];

test.before(async () => {
    if (skip) return;
    server = https.createServer({ key: pair.key, cert: pair.cert }, (req, res) => {
        hits.push(`${req.headers.host}${req.url}`);
        const send = (status, body, headers = {}) => {
            res.writeHead(status, headers);
            res.end(body);
        };
        switch (req.url.split('?')[0]) {
        case '/file': return send(200, PAYLOAD, { 'Content-Length': PAYLOAD.length });
        case '/json': return send(200, JSON.stringify({ ok: true, ua: req.headers['user-agent'], cookie: req.headers.cookie || null, auth: req.headers.authorization || null }));
        case '/redirect-ok': return send(302, '', { Location: 'https://objects.githubusercontent.com/file?token=secret' });
        case '/redirect-relative': return send(302, '', { Location: '/file' });
        case '/redirect-evil': return send(302, '', { Location: 'https://evil.example/file' });
        case '/redirect-http': return send(302, '', { Location: 'http://github.com/file' });
        case '/redirect-port': return send(302, '', { Location: 'https://github.com:8443/file' });
        case '/loop': return send(302, '', { Location: 'https://github.com/loop' });
        case '/declared-big': return send(200, 'x', { 'Content-Length': 10 * 1024 * 1024 });
        case '/streamed-big': {
            res.writeHead(200);
            for (let i = 0; i < 20; i++) res.write(Buffer.alloc(64 * 1024));
            return res.end();
        }
        case '/short': {
            res.writeHead(200, { 'Content-Length': 100 });
            res.write(Buffer.alloc(10));
            return res.destroy();
        }
        case '/slow': {
            res.writeHead(200, { 'Content-Length': PAYLOAD.length });
            res.write(PAYLOAD.subarray(0, 1024));
            return undefined;
        }
        case '/limited': return send(403, '{}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' });
        default: return send(404, 'nope');
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    agent = new LocalAgent(server.address().port);
});

test.after(() => {
    if (server) {
        server.closeAllConnections();
        server.close();
    }
});

const tmp = h.tmpDir();
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const code = (expected) => (err) => {
    assert.equal(err.code, expected);
    return true;
};

test('only https to allow-listed hosts on the default port, without credentials', () => {
    for (const url of ['http://github.com/x', 'https://evil.example/x', 'https://github.com:444/x', 'https://user:pw@github.com/x', 'https://github.com.evil.example/x', 'not a url']) {
        assert.throws(() => download.allowedUrl(url), code('DOWNLOAD_HOST'), url);
    }
    for (const host of ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']) {
        assert.equal(download.allowedUrl(`https://${host}/x`).hostname, host);
    }
});

test('DNS answers in private ranges are refused (makeSafeLookup)', async () => {
    const lookup = makeSafeLookup(isPrivateAddress);
    await assert.rejects(new Promise((resolve, reject) => lookup('localhost', {}, (err, address) => (err ? reject(err) : resolve(address)))), /nicht erlaubt/);
});

test('JSON over an allowed host; no cookies or auth headers are sent', { skip }, async () => {
    const body = await download.fetchJson('https://api.github.com/json', { agent });
    assert.equal(body.ok, true);
    assert.match(body.ua, /^manga-shelf\//);
    assert.equal(body.cookie, null);
    assert.equal(body.auth, null);
});

test('redirects: allowed hosts followed (at most 3), foreign hosts, http and other ports refused before connecting', { skip }, async () => {
    assert.ok((await download.fetchBuffer('https://github.com/redirect-ok', { agent, maxBytes: 1024 * 1024 })).equals(PAYLOAD));
    assert.ok((await download.fetchBuffer('https://github.com/redirect-relative', { agent, maxBytes: 1024 * 1024 })).equals(PAYLOAD));
    hits.length = 0;
    await assert.rejects(download.fetchBuffer('https://github.com/redirect-evil', { agent }), code('DOWNLOAD_HOST'));
    assert.deepEqual(hits, ['github.com/redirect-evil'], 'evil.example was never contacted');
    await assert.rejects(download.fetchBuffer('https://github.com/redirect-http', { agent }), code('DOWNLOAD_HOST'));
    await assert.rejects(download.fetchBuffer('https://github.com/redirect-port', { agent }), code('DOWNLOAD_HOST'));
    await assert.rejects(download.fetchBuffer('https://github.com/loop', { agent }), code('DOWNLOAD_FAILED'));
});

test('caps: declared and streamed sizes over the cap are refused; 200 only', { skip }, async () => {
    await assert.rejects(download.fetchBuffer('https://github.com/declared-big', { agent, maxBytes: 1024 }), code('DOWNLOAD_TOO_LARGE'));
    await assert.rejects(download.fetchBuffer('https://github.com/streamed-big', { agent, maxBytes: 64 * 1024 }), code('DOWNLOAD_TOO_LARGE'));
    await assert.rejects(download.fetchBuffer('https://github.com/missing', { agent }), (err) => err.code === 'DOWNLOAD_FAILED' && err.httpStatus === 404);
    await assert.rejects(download.fetchJson('https://api.github.com/limited', { agent }), (err) => err.httpStatus === 403 && err.headers['x-ratelimit-reset'] === '2000000000');
});

test('fetchToFile streams into .part, hashes, renames; any failure leaves neither file', { skip }, async () => {
    const dest = path.join(tmp, 'asset.bin');
    const got = await download.fetchToFile('https://github.com/file', { agent, dest, expectedSha256: h.sha256hex(PAYLOAD), expectedSize: PAYLOAD.length });
    assert.equal(got.sha256, h.sha256hex(PAYLOAD));
    assert.equal(got.size, PAYLOAD.length);
    assert.ok(fs.readFileSync(dest).equals(PAYLOAD));
    assert.equal(fs.existsSync(dest + '.part'), false);

    const bad = path.join(tmp, 'bad.bin');
    await assert.rejects(download.fetchToFile('https://github.com/file', { agent, dest: bad, expectedSha256: 'f'.repeat(64) }), code('CHECKSUM_MISMATCH'));
    await assert.rejects(download.fetchToFile('https://github.com/file', { agent, dest: bad, expectedSize: 12 }), code('DOWNLOAD_FAILED'));
    await assert.rejects(download.fetchToFile('https://github.com/short', { agent, dest: bad }), code('DOWNLOAD_FAILED'));
    await assert.rejects(download.fetchToFile('https://github.com/streamed-big', { agent, dest: bad, maxBytes: 1000 }), code('DOWNLOAD_TOO_LARGE'));
    assert.equal(fs.existsSync(bad), false);
    assert.equal(fs.existsSync(bad + '.part'), false);
});

test('abort: abortAll() and the caller signal end a running download and remove the part file', { skip }, async () => {
    const dest = path.join(tmp, 'slow.bin');
    const running = download.fetchToFile('https://github.com/slow', { agent, dest });
    while (!fs.existsSync(dest + '.part') || download.activeDownloads() === 0) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));
    download.abortAll();
    await assert.rejects(running, code('DOWNLOAD_ABORTED'));
    assert.equal(fs.existsSync(dest + '.part'), false);
    assert.equal(download.activeDownloads(), 0);

    const ctl = new AbortController();
    const second = download.fetchToFile('https://github.com/slow', { agent, dest, signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    await assert.rejects(second, code('DOWNLOAD_ABORTED'));

    await assert.rejects(download.fetchToFile('https://github.com/slow', { agent, dest, deadlineMs: 100 }), code('DOWNLOAD_FAILED'));
    assert.equal(fs.existsSync(dest + '.part'), false);
});

class LookupAgent extends LocalAgent {
    createConnection(options, callback) {
        if (typeof options.lookup !== 'function') {
            callback(new Error('the request carries no lookup'));
            return undefined;
        }
        options.lookup(options.host, {}, (err, address) => {
            if (err) return callback(err);
            return callback(null, tls.connect({ ...options, host: address, port: this.localPort, servername: options.servername || options.host, ca: pair.cert }));
        });
        return undefined;
    }
}

test('the download resolves through the safe lookup: a host answering with a private address is refused', { skip }, async (t) => {
    const asked = [];
    t.mock.method(dns, 'lookup', (hostname, options, callback) => {
        asked.push(hostname);
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
    });
    const lookupAgent = new LookupAgent(server.address().port);
    const dest = path.join(tmp, 'resolved.bin');
    await assert.rejects(download.fetchToFile('https://github.com/file', { agent: lookupAgent, dest }), (err) => {
        assert.equal(err.code, 'DOWNLOAD_FAILED');
        assert.match(String(err.cause && err.cause.message), /Zieladresse nicht erlaubt/);
        return true;
    });
    assert.deepEqual(asked, ['github.com']);
    assert.equal(fs.existsSync(dest + '.part'), false);
});

test('timeouts: no TLS answer ends the connect, a stalled body ends at the idle limit', { skip }, async (t) => {
    const silent = net.createServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        silent.close();
    });
    const sockets = [];
    silent.on('connection', (socket) => sockets.push(socket));
    t.after(() => sockets.forEach((s) => s.destroy()));
    const stalled = new LocalAgent(silent.address().port);
    await assert.rejects(download.fetchBuffer('https://github.com/x', { agent: stalled, connectTimeoutMs: 100 }),
        (err) => err.code === 'DOWNLOAD_FAILED' && err.reason === 'connect_timeout');

    const dest = path.join(tmp, 'idle.bin');
    const started = Date.now();
    await assert.rejects(download.fetchToFile('https://github.com/slow', { agent, dest, idleTimeoutMs: 150 }), (err) => err.code === 'DOWNLOAD_FAILED');
    assert.ok(Date.now() - started < 5000);
    assert.equal(fs.existsSync(dest + '.part'), false);
});
