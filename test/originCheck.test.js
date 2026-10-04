const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { createOriginCheck, parseOrigins, bearerToken } = require('../middleware/originCheck');

let server;
let port;

test.before(async () => {
    const app = express();
    app.use('/api', createOriginCheck({
        allowedOrigins: parseOrigins(' https://Tools.Example.org/ , https://other.example '),
        appOrigins: ['capacitor://localhost', 'https://localhost']
    }));
    app.all('/api/thing', (req, res) => res.json({ ok: true }));
    server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function send(method, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/thing', method, headers: { Host: 'shelf.example.org', ...headers } }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('safe methods always pass, also from a foreign site', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const res = await send(method, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
        assert.equal(res.status, 200, method);
    }
});

test('Sec-Fetch-Site: same-origin and none pass, same-site and cross-site are refused with a German message', async () => {
    assert.equal((await send('POST', { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://shelf.example.org' })).status, 200);
    assert.equal((await send('POST', { 'Sec-Fetch-Site': 'none' })).status, 200);
    for (const site of ['same-site', 'cross-site']) {
        const res = await send('POST', { 'Sec-Fetch-Site': site, Origin: 'https://evil.example.org' });
        assert.equal(res.status, 403, site);
        assert.equal(res.body.code, 'CROSS_ORIGIN');
        assert.match(res.body.error, /fremden Seite/);
    }
    // a matching Origin does not override what the browser says about the request
    assert.equal((await send('DELETE', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://shelf.example.org' })).status, 403);
});

test('without Sec-Fetch-Site the Origin host must match the Host header', async () => {
    assert.equal((await send('POST', { Origin: 'https://shelf.example.org' })).status, 200);
    assert.equal((await send('PUT', { Origin: 'http://SHELF.example.org' })).status, 200, 'scheme and case do not matter');
    assert.equal((await send('POST', { Origin: 'https://shelf.example.org:8443' })).status, 403);
    assert.equal((await send('POST', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await send('POST', { Origin: 'null' })).status, 403);
});

test('requests without Origin and Sec-Fetch-Site (curl, scripts, the test client) pass', async () => {
    assert.equal((await send('POST')).status, 200);
    assert.equal((await send('DELETE')).status, 200);
});

test('origins listed in CORS_ORIGIN pass, normalised like the configuration', async () => {
    assert.equal((await send('POST', { Origin: 'https://tools.example.org', 'Sec-Fetch-Site': 'cross-site' })).status, 200);
    assert.equal((await send('POST', { Origin: 'https://other.example' })).status, 200);
    assert.equal((await send('POST', { Origin: 'https://tools.example.org.evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.deepEqual(parseOrigins(''), []);
    assert.deepEqual(parseOrigins(undefined), []);
});

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2lnbmF0dXJl';

test('bearerToken: only a well-formed Bearer JWT counts', () => {
    const of = (authorization) => bearerToken({ headers: { authorization } });
    assert.equal(of('Bearer ' + JWT), JWT);
    assert.equal(of('bearer  ' + JWT + ' '), JWT);
    for (const bad of [undefined, '', JWT, 'Basic ' + JWT, 'Bearer', 'Bearer abc', 'Bearer a.b', `Bearer ${JWT} x`, 'Bearer a.b.c=']) {
        assert.equal(of(bad), null, String(bad));
    }
});

test('a bearer token skips the check unless the session cookie is sent too', async () => {
    const auth = { Authorization: 'Bearer ' + JWT };
    assert.equal((await send('POST', { ...auth, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 200);
    assert.equal((await send('DELETE', { ...auth, Origin: 'capacitor://localhost', 'Sec-Fetch-Site': 'cross-site' })).status, 200);
    const withCookie = await send('POST', { ...auth, Cookie: 'theme=dark; token=abc', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(withCookie.body.code, 'CROSS_ORIGIN', 'the cookie wins over the bearer, so the cookie session stays protected');
    assert.equal((await send('POST', { Authorization: 'Bearer nonsense', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await send('POST', { ...auth, Cookie: 'xtoken=abc', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 200, 'other cookies do not count');
});

test('app origins pass without the session cookie (login), never with it', async () => {
    for (const origin of ['capacitor://localhost', 'https://localhost', 'HTTPS://LOCALHOST/']) {
        assert.equal((await send('POST', { Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status, 200, origin);
    }
    const cookie = await send('POST', { Origin: 'https://localhost', 'Sec-Fetch-Site': 'same-site', Cookie: 'token=abc' });
    assert.equal(cookie.status, 403);
    assert.equal((await send('POST', { Origin: 'https://localhost:8080', 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'another port is another origin');
    assert.equal((await send('POST', { Origin: 'http://localhost', 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'another scheme is another origin');
    assert.equal((await send('POST', { Origin: 'ionic://localhost', 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'only the configured app origins');
});

test('the session cookie is recognised the way cookie-parser reads it, also with spaces around the name', async () => {
    const foreign = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', Authorization: 'Bearer ' + JWT };
    for (const cookie of ['token =x', ' token\t=x', 'a=1;token = x', 'theme=dark;   token=', 'token=a=b']) {
        assert.equal((await send('POST', { ...foreign, Cookie: cookie })).status, 403, cookie);
        assert.equal((await send('POST', { Origin: 'capacitor://localhost', 'Sec-Fetch-Site': 'cross-site', Cookie: cookie })).status, 403, cookie);
    }
    for (const cookie of ['token', 'tokens=x', 'my token=x', 'a=token=x']) {
        assert.equal((await send('POST', { ...foreign, Cookie: cookie })).status, 200, cookie);
    }
});
