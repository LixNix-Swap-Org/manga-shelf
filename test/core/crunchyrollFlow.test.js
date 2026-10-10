// core/watch/crunchyrollFlow.js: login, history run and logout over injected transport and secret storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createFlow, FlowError } = require('../../core/watch/crunchyrollFlow');
const crunchyroll = require('../../core/watch/crunchyroll');

const fixture = (name) => JSON.parse(JSON.stringify(require(path.join(__dirname, '..', 'fixtures', name))));
const COOKIE = 'etp-test-cookie-0001';
const ROTATED = 'etp-rotated-cookie-0002';
const NEW_LOGIN = 'etp-new-login-cookie-0003';
const DEVICE = '11111111-2222-4333-8444-555555555555';
const SECRET = { etp_rt: COOKIE, client_id: 'test_client_01', device_id: DEVICE, account_id: null, saved_at: 1 };
const answer = (status, body, extra = {}) => ({ status, headers: {}, text: typeof body === 'string' ? body : JSON.stringify(body), cookies: [], ...extra });

function harness({ secret = SECRET, token = answer(200, fixture('crunchyroll/token.json')) } = {}) {
    const h = { secret: secret ? { ...secret } : null, requests: [], writes: [], deletes: 0, held: [] };
    h.answers = {
        token,
        me: answer(200, fixture('crunchyroll/me.json')),
        watch: answer(200, fixture('crunchyroll/watch-history.json')),
        discover: answer(200, fixture('crunchyroll/discover-history.json'))
    };
    const kindOf = (url) => (url.endsWith('/auth/v1/token') ? 'token' : url.endsWith('/accounts/v1/me') ? 'me' : url.includes('/watch-history') ? 'watch' : 'discover');
    h.hold = (kind) => {
        let reached;
        const entry = { kind, reached: new Promise((r) => { reached = r; }) };
        entry.arrive = reached;
        h.held.push(entry);
        return entry;
    };
    h.flow = createFlow({
        send: async (req) => {
            const kind = kindOf(req.url);
            h.requests.push({ kind, req });
            const held = h.held.find((e) => e.kind === kind && !e.release);
            if (held) {
                const pending = new Promise((resolve, reject) => { held.release = resolve; held.reject = reject; });
                held.arrive();
                return pending;
            }
            const value = h.answers[kind];
            if (value instanceof Error) throw value;
            return value;
        },
        readSecret: async () => h.secret,
        writeSecret: async (value) => { h.writes.push(value); h.secret = value; },
        deleteSecret: async () => { h.deletes += 1; h.secret = null; },
        randomUUID: () => '99999999-8888-4777-8666-555555555555',
        now: () => 42
    });
    h.tokenCalls = () => h.requests.filter((r) => r.kind === 'token').length;
    return h;
}

test('the cookie rule is shared with the desktop login', () => {
    assert.ok(crunchyroll.COOKIE_RE.test(COOKIE));
    for (const bad of ['short', 'a b', 'x;y=1234567', 'x'.repeat(4097)]) assert.equal(crunchyroll.COOKIE_RE.test(bad), false, bad);
});

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => err instanceof FlowError && err.code === code);

test('history: token, account, both lists merged as items with series_slug; the cookie goes only into the token request', async () => {
    const h = harness();
    const { items } = await h.flow.history();
    assert.deepEqual(h.requests.map((r) => r.kind), ['token', 'watch', 'discover']);
    assert.equal(h.requests[0].req.headers.Cookie, `etp_rt=${COOKIE}`);
    for (const r of h.requests.slice(1)) assert.ok(!JSON.stringify(r.req).includes(COOKIE));
    const watch = crunchyroll.parseWatchHistory(fixture('crunchyroll/watch-history.json'));
    const discover = crunchyroll.parseDiscoverHistory(fixture('crunchyroll/discover-history.json'));
    assert.deepEqual(items, crunchyroll.mergeItems(watch, discover));
    assert.equal(items.find((i) => i.external_id === 'GTESTSER01' && i.season === 1).series_slug, 'frieren-beyond-journeys-end');
    assert.equal(items.find((i) => i.external_id === 'GTESTNEW99').watched_at, null);
    assert.deepEqual(h.writes.map((w) => w.account_id), ['00000000-0000-4000-8000-000000000001']);
    assert.equal(await h.flow.connected(), true);
});

test('history: a rotated etp_rt is written before any other request; /me only without an account id', async () => {
    const h = harness({ token: answer(200, { access_token: 'tok' }, { cookies: [{ name: 'etp_rt', value: ROTATED, expires: null }] }) });
    let requestsAtWrite = null;
    const original = h.writes.push.bind(h.writes);
    h.writes.push = (value) => {
        if (requestsAtWrite === null) requestsAtWrite = h.requests.length;
        return original(value);
    };
    await h.flow.history();
    assert.equal(requestsAtWrite, 1);
    assert.deepEqual(h.requests.map((r) => r.kind), ['token', 'me', 'watch', 'discover']);
    assert.deepEqual(h.writes.map((w) => [w.etp_rt, w.account_id, w.saved_at]), [[ROTATED, null, 42], [ROTATED, '00000000-0000-4000-8000-000000000001', 42]]);
    assert.deepEqual(Object.keys(h.secret).sort(), ['account_id', 'client_id', 'device_id', 'etp_rt', 'saved_at']);
});

test('history: not connected, refused login (secret deleted first), other failures keep the secret', async () => {
    await rejectsWith(harness({ secret: null }).flow.history(), 'not_connected');
    await rejectsWith(harness({ secret: { etp_rt: 'x' } }).flow.history(), 'not_connected');

    for (const [token, code] of [[answer(401, {}), 'reconnect'], [answer(400, { error: 'invalid_grant' }), 'reconnect'], [answer(403, '<html>'), 'blocked'],
        [answer(429, ''), 'rate_limited'], [answer(503, ''), 'unavailable'], [answer(200, '<html>'), 'bad_response']]) {
        const h = harness({ token });
        await rejectsWith(h.flow.history(), code);
        assert.equal(h.secret === null, code === 'reconnect', code);
        assert.equal(h.deletes, code === 'reconnect' ? 1 : 0, code);
        assert.equal(h.tokenCalls(), 1, code);
    }

    const partial = harness();
    partial.answers.discover = answer(500, '');
    assert.ok((await partial.flow.history()).items.length > 0, 'one list answering is enough');
    const none = harness();
    none.answers.watch = answer(401, {});
    none.answers.discover = answer(500, '');
    await rejectsWith(none.flow.history(), 'reconnect');
    assert.equal(none.secret, null);
});

test('a rejected send is network (bad_response for a refused host) and never reaches a parser', async () => {
    const h = harness();
    h.answers.token = Object.assign(new Error('offline'), { code: 'network' });
    await rejectsWith(h.flow.history(), 'network');
    assert.notEqual(h.secret, null);
    h.answers.token = Object.assign(new Error('host'), { code: 'not_allowed' });
    await rejectsWith(h.flow.history(), 'bad_response');
    h.answers.token = new Error('anything');
    await rejectsWith(h.flow.history(), 'network');

    const lists = harness();
    lists.answers.watch = Object.assign(new Error('offline'), { code: 'network' });
    assert.ok((await lists.flow.history()).items.length > 0);
    lists.answers.discover = Object.assign(new Error('offline'), { code: 'network' });
    await rejectsWith(lists.flow.history(), 'network');
});

test('a throwing secret store propagates unchanged', async () => {
    const broken = new Error('locked');
    const flow = createFlow({
        send: async () => { throw new Error('never'); },
        readSecret: async () => { throw broken; },
        writeSecret: async () => {},
        deleteSecret: async () => {},
        randomUUID: () => DEVICE,
        now: () => 1
    });
    await assert.rejects(flow.history(), (err) => err === broken);
    await assert.rejects(flow.connected(), (err) => err === broken);
    await assert.rejects(flow.connect({ etpRt: NEW_LOGIN, scriptResult: null, isCancelled: () => false }), (err) => err === broken);
});

test('two concurrent history() calls make one token request', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.flow.history(), h.flow.history()]);
    assert.equal(a, b);
    assert.equal(h.tokenCalls(), 1);
    await h.flow.history();
    assert.equal(h.tokenCalls(), 2, 'a later call runs again');
});

test('logout during history() leaves no secret', async () => {
    const h = harness({ token: answer(200, fixture('crunchyroll/token.json'), { cookies: [{ name: 'etp_rt', value: ROTATED, expires: null }] }) });
    const held = h.hold('token');
    const run = h.flow.history();
    await held.reached;
    await h.flow.disconnect();
    held.release(h.answers.token);
    await rejectsWith(run, 'stale');
    assert.equal(h.secret, null);
    assert.deepEqual(h.writes, []);
    assert.equal(await h.flow.connected(), false);
});

test('logout while the history lists load: no items, nothing written back', async () => {
    const h = harness();
    const held = h.hold('discover');
    const run = h.flow.history();
    await held.reached;
    await h.flow.disconnect();
    held.release(h.answers.discover);
    await rejectsWith(run, 'stale');
    assert.equal(h.secret, null);
});

test('connect during a history() that then gets 401 keeps the new secret and rejects stale', async () => {
    const h = harness({ token: answer(401, {}) });
    const held = h.hold('token');
    const run = h.flow.history();
    await held.reached;
    await h.flow.connect({ etpRt: NEW_LOGIN, scriptResult: JSON.stringify({ accountAuthClientId: 'page_client_1' }), isCancelled: () => false });
    held.release(h.answers.token);
    await rejectsWith(run, 'stale');
    assert.equal(h.deletes, 0);
    assert.deepEqual(h.secret, { etp_rt: NEW_LOGIN, client_id: 'page_client_1', device_id: DEVICE, account_id: null, saved_at: 42 });
});

test('connect: device id kept or new, client id fallback, bad cookie, cancelled and stale write nothing', async () => {
    const kept = harness();
    await kept.flow.connect({ etpRt: NEW_LOGIN, scriptResult: null, isCancelled: () => false });
    assert.deepEqual(kept.secret, { etp_rt: NEW_LOGIN, client_id: crunchyroll.ENDPOINTS.clientIdFallback.id, device_id: DEVICE, account_id: null, saved_at: 42 });

    const fresh = harness({ secret: null });
    await fresh.flow.connect({ etpRt: NEW_LOGIN, scriptResult: null });
    assert.equal(fresh.secret.device_id, '99999999-8888-4777-8666-555555555555');

    const bad = harness({ secret: null });
    await rejectsWith(bad.flow.connect({ etpRt: 'a b', scriptResult: null, isCancelled: () => false }), 'bad_response');
    assert.deepEqual(bad.writes, []);

    const cancelled = harness({ secret: null });
    let asked = 0;
    await rejectsWith(cancelled.flow.connect({ etpRt: NEW_LOGIN, scriptResult: null, isCancelled: () => { asked += 1; return true; } }), 'cancelled');
    assert.equal(asked, 1);
    assert.deepEqual(cancelled.writes, []);
    assert.equal(cancelled.secret, null);

    let release;
    const slow = harness({ secret: null });
    const flow = createFlow({
        send: async () => answer(500, ''),
        readSecret: () => new Promise((r) => { release = () => r(null); }),
        writeSecret: async (value) => slow.writes.push(value),
        deleteSecret: async () => {},
        randomUUID: () => DEVICE,
        now: () => 1
    });
    const pending = flow.connect({ etpRt: NEW_LOGIN, scriptResult: null, isCancelled: () => false });
    const out = flow.disconnect();
    release();
    await out;
    await rejectsWith(pending, 'stale');
    assert.deepEqual(slow.writes, []);
});
