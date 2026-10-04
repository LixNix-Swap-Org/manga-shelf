// users.locale / users.default_language: /auth/me carries both, PUT /auth/profile changes the own row only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { resetRateLimits } = require('../middleware/rateLimit');

let ctx;
let admin;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });
test.beforeEach(() => resetRateLimits());

const loggedIn = async (username) => {
    const client = ctx.client();
    assert.equal((await client('POST', '/auth/login', { username, password: 'password123' })).status, 200);
    return client;
};

test('a new account follows the device (locale null) with German as default edition language', async () => {
    const me = await admin('GET', '/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.locale, null);
    assert.equal(me.body.user.default_language, 'de');
});

test('PUT /auth/profile stores the own locale and default language and answers the user', async () => {
    const res = await admin('PUT', '/auth/profile', { locale: 'EN', default_language: 'JA' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'admin');
    assert.equal(res.body.user.locale, 'en');
    assert.equal(res.body.user.default_language, 'ja');
    assert.equal((await admin('GET', '/auth/me')).body.user.locale, 'en');
    assert.equal((await admin('PUT', '/auth/profile', { locale: 'pt-br' })).body.user.locale, 'pt-BR');
    const reset = await admin('PUT', '/auth/profile', { locale: null });
    assert.equal(reset.body.user.locale, null, 'null follows the device again');
    assert.equal(reset.body.user.default_language, 'ja', 'fields left out stay');
    assert.equal((await admin('PUT', '/auth/profile', { locale: '' })).body.user.locale, null);
});

test('invalid values answer 400 with their own codes and German text; nothing changes', async () => {
    const bad = await admin('PUT', '/auth/profile', { locale: 'klingonisch' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: 'Unbekannte Sprache', code: 'LOCALE_INVALID' });
    const lang = await admin('PUT', '/auth/profile', { default_language: 'deu' });
    assert.equal(lang.status, 400);
    assert.equal(lang.body.code, 'LANGUAGE_INVALID');
    const empty = await admin('PUT', '/auth/profile', {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'BAD_REQUEST');
    assert.equal((await admin('PUT', '/auth/profile', { locale: 7 })).body.code, 'LOCALE_INVALID');
    assert.equal((await admin('GET', '/auth/me')).body.user.default_language, 'ja');
});

test('guests set their own language; signed out is 401; another origin is refused', async () => {
    assert.equal((await admin('POST', '/users', { username: 'gast', password: 'password123', role: 'guest' })).status, 200);
    const gast = await loggedIn('gast');
    const res = await gast('PUT', '/auth/profile', { locale: 'en' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'guest');
    assert.equal((await gast('GET', '/auth/me')).body.user.locale, 'en');
    assert.equal((await admin('GET', '/auth/me')).body.user.locale, null, 'only the own row');
    assert.equal((await ctx.client()('PUT', '/auth/profile', { locale: 'en' })).status, 401);
    const cross = await gast('PUT', '/auth/profile', { locale: 'de' }, { Origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.code, 'CROSS_ORIGIN');
});
