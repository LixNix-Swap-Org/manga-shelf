// Covers the main-process transport of the Crunchyroll calls with a stand-in for Electron's net (the real one runs in test/electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { createTransport, parseSetCookie, MAX_BODY_BYTES } = require('../lib/watchTransport');
const { crunchyroll } = require('./watchFakes');

function fakeNet() {
    const net = { requests: [] };
    net.request = (options) => {
        const req = new EventEmitter();
        req.options = options;
        req.headers = {};
        req.body = '';
        req.aborted = 0;
        req.setHeader = (name, value) => { req.headers[name] = value; };
        req.write = (chunk) => { req.body += chunk; };
        req.end = () => { req.ended = true; };
        req.abort = () => { req.aborted += 1; req.emit('abort'); };
        net.requests.push(req);
        return req;
    };
    return net;
}

const respond = (req, { status = 200, raw = [], chunks = [] } = {}) => {
    const response = new EventEmitter();
    response.statusCode = status;
    response.rawHeaders = raw;
    response.headers = {};
    req.emit('response', response);
    for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
    response.emit('end');
};

const setup = (deadlineMs = 20000) => {
    const net = fakeNet();
    const send = createTransport({ net, session: { id: 'api' }, userAgent: 'UA/1', isAllowedUrl: crunchyroll.isAllowedApiUrl, deadlineMs });
    return { net, send };
};

test('requests go out on the api session without session cookies or redirects, with the UA and the manual Cookie header', async () => {
    const { net, send } = setup();
    const request = crunchyroll.buildTokenRequest({ etp_rt: 'etp-cookie-000001', client_id: 'client_01', device_id: null });
    const pending = send({ ...request, headers: { ...request.headers, 'user-agent': 'other' } });
    const req = net.requests[0];
    assert.deepEqual(req.options, { method: 'POST', url: crunchyroll.ENDPOINTS.token, session: { id: 'api' }, credentials: 'omit', redirect: 'manual' });
    assert.equal(req.options.useSessionCookies, undefined);
    assert.equal(req.headers.Cookie, 'etp_rt=etp-cookie-000001');
    assert.equal(req.headers['User-Agent'], 'UA/1');
    assert.equal(req.headers['user-agent'], undefined);
    assert.equal(req.headers['Accept-Encoding'], undefined);
    assert.equal(req.body, 'grant_type=etp_rt_cookie');
    assert.ok(req.ended);
    respond(req, {
        raw: ['Content-Type', 'application/json', 'Set-Cookie', 'etp_rt=etp-rotated-000002; Max-Age=600; Path=/; HttpOnly; Secure', 'set-cookie', 'other=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'X-A', '1', 'x-a', '2'],
        chunks: ['{"access_token":', '"tok"}']
    });
    const before = Date.now();
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal(result.text, '{"access_token":"tok"}');
    assert.equal(result.headers['content-type'], 'application/json');
    assert.equal(result.headers['x-a'], '1, 2');
    assert.match(result.headers['set-cookie'], /^etp_rt=etp-rotated-000002; Max-Age=600.*, other=1;/);
    assert.equal(result.cookies.length, 2);
    assert.equal(result.cookies[0].name, 'etp_rt');
    assert.equal(result.cookies[0].value, 'etp-rotated-000002');
    assert.ok(Math.abs(result.cookies[0].expires - (before + 600000)) < 5000);
    assert.equal(result.cookies[1].expires, Date.parse('Wed, 21 Oct 2037 07:28:00 GMT'));
    assert.equal(crunchyroll.parseTokenResponse(result).etp_rt, 'etp-rotated-000002');
    assert.equal(req.aborted, 0);
});

test('Set-Cookie: attributes case-insensitive, Max-Age before Expires, Max-Age <= 0 is 0, no date is null', () => {
    assert.deepEqual(parseSetCookie('a=b; max-age=0; expires=Wed, 21 Oct 2037 07:28:00 GMT', 1000), { name: 'a', value: 'b', expires: 0 });
    assert.deepEqual(parseSetCookie('a=b; MAX-AGE=-5', 1000), { name: 'a', value: 'b', expires: 0 });
    assert.deepEqual(parseSetCookie('a=b; Max-Age=10; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 1000), { name: 'a', value: 'b', expires: 11000 });
    assert.deepEqual(parseSetCookie('a=b; EXPIRES=Wed, 21 Oct 2037 07:28:00 GMT', 1000), { name: 'a', value: 'b', expires: Date.parse('Wed, 21 Oct 2037 07:28:00 GMT') });
    assert.deepEqual(parseSetCookie('a=b; Path=/', 1000), { name: 'a', value: 'b', expires: null });
    assert.equal(parseSetCookie('=b', 1000), null);
    assert.equal(parseSetCookie('kein cookie', 1000), null);
});

test('a redirect is not followed: the 3xx comes back as it is and the request is aborted', async () => {
    const { net, send } = setup();
    const pending = send(crunchyroll.buildApiRequest(crunchyroll.ENDPOINTS.me, 'tok'));
    const req = net.requests[0];
    req.emit('redirect', 302, 'GET', 'https://evil.example/', { Location: ['https://evil.example/'], 'Set-Cookie': ['etp_rt=x12345678'] });
    const result = await pending;
    assert.equal(result.status, 302);
    assert.equal(result.headers.location, 'https://evil.example/');
    assert.equal(result.text, '');
    assert.deepEqual(result.cookies, [{ name: 'etp_rt', value: 'x12345678', expires: null }]);
    assert.equal(req.aborted, 1);
});

test('hosts outside the allow-list and other methods are refused before any request', async () => {
    const { net, send } = setup();
    for (const request of [{ url: 'https://evil.example/', method: 'GET' }, { url: 'http://www.crunchyroll.com/x', method: 'GET' }, { url: crunchyroll.ENDPOINTS.me, method: 'DELETE' }, null]) {
        await assert.rejects(send(request), (err) => err.code === 'not_allowed');
    }
    assert.equal(net.requests.length, 0);
});

test('more than 8 MiB of decoded body, a network error and the deadline reject with network', async (t) => {
    const big = setup();
    const pending = big.send(crunchyroll.buildApiRequest(crunchyroll.ENDPOINTS.me, 'tok'));
    const response = new EventEmitter();
    response.statusCode = 200;
    response.rawHeaders = [];
    big.net.requests[0].emit('response', response);
    response.emit('data', Buffer.alloc(MAX_BODY_BYTES));
    response.emit('data', Buffer.alloc(1));
    await assert.rejects(pending, (err) => err.code === 'network');
    assert.equal(big.net.requests[0].aborted, 1);

    const broken = setup();
    const failing = broken.send(crunchyroll.buildApiRequest(crunchyroll.ENDPOINTS.me, 'tok'));
    broken.net.requests[0].emit('error', new Error('net::ERR_CONNECTION_RESET'));
    await assert.rejects(failing, (err) => err.code === 'network');

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const slow = setup(20000);
    const waiting = slow.send(crunchyroll.buildApiRequest(crunchyroll.ENDPOINTS.me, 'tok'));
    t.mock.timers.tick(19999);
    t.mock.timers.tick(1);
    await assert.rejects(waiting, (err) => err.code === 'network');
    assert.equal(slow.net.requests[0].aborted, 1);
});
