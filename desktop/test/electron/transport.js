// The transport against a local HTTPS server inside Electron: manual Cookie header, no cookie jar, Set-Cookie, no redirects, limits.
const assert = require('node:assert/strict');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const { net, session } = require('electron');
const { createTransport, MAX_BODY_BYTES } = require('../../lib/watchTransport');
const { browserUserAgent } = require('../../lib/watchLogin');

const crunchyroll = require(path.join(__dirname, '..', '..', '..', 'core', 'watch', 'crunchyroll.js'));
const { CERT, KEY } = require('./fixtureTls');
const ROTATED = 'etp-rotated-gate-000001';
const MANUAL = 'etp-manual-gate-000002';
const pem = (text) => String(text).replace(/\s+/g, '');

function startServer() {
    const seen = [];
    const server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            if (req.url === '/token') {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `etp_rt=${ROTATED}; Max-Age=600; Path=/; HttpOnly; Secure` });
                res.end(JSON.stringify({ access_token: 'gate-token', account_id: 'gate-account' }));
            } else if (req.url === '/redirect') {
                res.writeHead(302, { Location: '/target' });
                res.end();
            } else if (req.url === '/big') {
                res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
                res.end(zlib.gzipSync(Buffer.alloc(MAX_BODY_BYTES + 1024, 0x61)));
            } else if (req.url === '/slow') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.write('a');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('ok');
            }
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `https://127.0.0.1:${server.address().port}` })));
}

async function withSetup(fn, { deadlineMs = 20000 } = {}) {
    const { server, seen, base } = await startServer();
    const ses = session.fromPartition(`test-api-${crypto.randomBytes(8).toString('hex')}`);
    ses.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' && pem(request.certificate.data) === pem(CERT) ? 0 : -2));
    const userAgent = browserUserAgent(require('electron').app.userAgentFallback);
    const send = createTransport({ net, session: ses, userAgent, isAllowedUrl: (url) => typeof url === 'string' && url.startsWith(`${base}/`), deadlineMs });
    try {
        await fn({ send, seen, base, ses, userAgent });
    } finally {
        server.closeAllConnections();
        server.close();
        await ses.clearStorageData().catch(() => {});
    }
}

module.exports = () => [
    {
        name: 'a manual Cookie header arrives verbatim, the jar stays empty, Set-Cookie comes back parsed and in the headers',
        run: () => withSetup(async ({ send, seen, base, ses, userAgent }) => {
            const request = crunchyroll.buildTokenRequest({ etp_rt: MANUAL, client_id: 'client_01', device_id: null });
            const before = Date.now();
            const result = await send({ ...request, url: `${base}/token` });
            assert.equal(seen.length, 1);
            assert.equal(seen[0].headers.cookie, `etp_rt=${MANUAL}`);
            assert.equal(seen[0].headers['user-agent'], userAgent);
            assert.equal(seen[0].body, 'grant_type=etp_rt_cookie');
            assert.equal(result.status, 200);
            assert.equal(result.cookies.length, 1);
            assert.equal(result.cookies[0].name, 'etp_rt');
            assert.equal(result.cookies[0].value, ROTATED);
            assert.ok(Math.abs(result.cookies[0].expires - (before + 600000)) < 10000);
            assert.match(result.headers['set-cookie'], new RegExp(`^etp_rt=${ROTATED};`));
            assert.equal(crunchyroll.parseTokenResponse(result).etp_rt, ROTATED);
            assert.deepEqual(await ses.cookies.get({}), []);
            await send({ url: `${base}/plain`, method: 'GET', headers: {} });
            assert.equal(seen[1].headers.cookie, undefined);
        })
    },
    {
        name: 'a 302 comes back unfollowed',
        run: () => withSetup(async ({ send, seen, base }) => {
            const result = await send({ url: `${base}/redirect`, method: 'GET', headers: {} });
            assert.equal(result.status, 302);
            assert.equal(result.headers.location, '/target');
            assert.ok(!seen.some((r) => r.url === '/target'));
        })
    },
    {
        name: 'more than 8 MiB of decoded body rejects with network',
        run: () => withSetup(async ({ send, base }) => {
            await assert.rejects(send({ url: `${base}/big`, method: 'GET', headers: {} }), (err) => err.code === 'network');
        })
    },
    {
        name: 'the deadline rejects with network',
        run: () => withSetup(async ({ send, base }) => {
            const started = Date.now();
            await assert.rejects(send({ url: `${base}/slow`, method: 'GET', headers: {} }), (err) => err.code === 'network');
            assert.ok(Date.now() - started < 5000);
        }, { deadlineMs: 1000 })
    },
    {
        name: 'a host outside the allow-list is refused before any request',
        run: () => withSetup(async ({ send, seen }) => {
            await assert.rejects(send({ url: 'https://example.com/', method: 'GET', headers: {} }), (err) => err.code === 'not_allowed');
            assert.equal(seen.length, 0);
        })
    }
];
