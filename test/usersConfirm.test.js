process.env.LOG_LEVEL = 'info';
process.env.LOG_FORMAT = 'json';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestServer } = require('./helpers');
const { resetRateLimits } = require('../middleware/rateLimit');

let ctx;
let admin;
let adminId;
const lines = [];
const { log: realLog, warn: realWarn } = console;

test.before(async () => {
    console.log = (line) => { lines.push(String(line)); };
    console.warn = console.log;
    ctx = await startTestServer();
    admin = ctx.client();
    const setup = await admin('POST', '/setup', { username: 'chef', password: 'password123' });
    assert.equal(setup.status, 200);
    adminId = setup.body.user.id;
});

test.after(async () => {
    Object.assign(console, { log: realLog, warn: realWarn });
    await ctx.close();
});
test.beforeEach(() => resetRateLimits());

const db = () => require('../db').db;
const row = (id) => db().prepare('SELECT username, role, password_hash FROM users WHERE id = ?').get(id);
const auditLines = () => lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter((e) => e && e.component === 'auth' && /^Benutzer (angelegt|geändert)$/.test(e.msg));
const lastAudit = () => auditLines().at(-1);
const createUser = async (username, role = 'editor', extra = {}) => {
    const res = await admin('POST', '/users', { username, password: 'password123', role, ...extra });
    assert.equal(res.status, 200, username);
    return res.body.user.id;
};
const login = async (username, password = 'password123', headers = {}) => {
    const client = ctx.client();
    const res = await client('POST', '/auth/login', { username, password }, headers);
    assert.equal(res.status, 200, username);
    return client;
};
const canLogin = async (username, password) => (await ctx.client()('POST', '/auth/login', { username, password })).status === 200;
const appToken = async (username, password = 'password123') => {
    const res = await fetch(ctx.base + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client': 'app' },
        body: JSON.stringify({ username, password })
    });
    return (await res.json()).token;
};
const bearer = (token) => (method, url, body, headers = {}) => ctx.client()(method, url, body, { Authorization: 'Bearer ' + token, ...headers });
const expectCode = (res, status, code) => assert.deepEqual([res.status, res.body.code], [status, code], JSON.stringify(res.body));

test('creating an admin needs the caller password; other roles do not', async () => {
    const before = db().prepare('SELECT count(*) AS n FROM users').get().n;
    const missing = await admin('POST', '/users', { username: 'neu-admin', password: 'password123', role: 'admin' });
    expectCode(missing, 400, 'BAD_REQUEST');
    assert.equal(missing.body.error, 'Bitte das aktuelle Passwort eingeben');
    const wrong = await admin('POST', '/users', { username: 'neu-admin', password: 'password123', role: 'admin', current_password: 'falsch-falsch' });
    expectCode(wrong, 403, 'WRONG_PASSWORD');
    assert.equal(wrong.body.error, 'Das aktuelle Passwort stimmt nicht');
    assert.equal(db().prepare('SELECT count(*) AS n FROM users').get().n, before);

    const id = await createUser('neu-admin', 'admin', { current_password: 'password123' });
    assert.equal(row(id).role, 'admin');
    await createUser('neu-editor', 'editor');
    await createUser('neu-gast', 'visitor', { current_password: 'egal' });
});

test('promotion to admin needs the caller password and changes nothing without it', async () => {
    const id = await createUser('aufstieg');
    expectCode(await admin('PUT', '/users/' + id, { role: 'admin' }), 400, 'BAD_REQUEST');
    expectCode(await admin('PUT', '/users/' + id, { role: 'admin', current_password: 'falsch-falsch' }), 403, 'WRONG_PASSWORD');
    assert.equal(row(id).role, 'editor');
    const ok = await admin('PUT', '/users/' + id, { role: 'admin', current_password: 'password123' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, 'admin');
    assert.equal(row(id).role, 'admin');
});

test('own account: a password reset or role change through user management needs the current password', async () => {
    const id = await createUser('selbst', 'admin', { current_password: 'password123' });
    const self = await login('selbst');
    expectCode(await self('PUT', '/users/' + id, { password: 'gekapert-123' }), 400, 'BAD_REQUEST');
    expectCode(await self('PUT', '/users/' + id, { password: 'gekapert-123', current_password: 'falsch-falsch' }), 403, 'WRONG_PASSWORD');
    expectCode(await self('PUT', '/users/' + id, { role: 'editor' }), 400, 'BAD_REQUEST');
    assert.equal(row(id).role, 'admin');
    assert.equal(await canLogin('selbst', 'gekapert-123'), false);

    const reset = await self('PUT', '/users/' + id, { password: 'eigenes-neu-1', current_password: 'password123' });
    assert.equal(reset.status, 200);
    assert.equal((await self('GET', '/auth/me')).status, 200, 'the own session continues with the new cookie');
    assert.equal(await canLogin('selbst', 'eigenes-neu-1'), true);
    const demote = await self('PUT', '/users/' + id, { role: 'editor', current_password: 'eigenes-neu-1' });
    assert.equal(demote.status, 200);
    assert.equal(row(id).role, 'editor');
});

test('a stolen admin bearer token cannot reset its own password to pass a later password check', async () => {
    const id = await createUser('dieb-ziel', 'admin', { current_password: 'password123' });
    const stolen = bearer(await appToken('dieb-ziel'));
    const hash = row(id).password_hash;
    expectCode(await stolen('PUT', '/users/' + id, { password: 'angreifer-1' }), 400, 'BAD_REQUEST');
    expectCode(await stolen('POST', '/users', { username: 'helfer', password: 'angreifer-1', role: 'admin' }), 400, 'BAD_REQUEST');
    expectCode(await stolen('PUT', '/users/' + adminId, { password: 'angreifer-1' }), 400, 'BAD_REQUEST');
    assert.equal(row(id).password_hash, hash);
    assert.equal(db().prepare("SELECT id FROM users WHERE username = 'helfer'").get(), undefined);
    assert.equal(await canLogin('chef', 'angreifer-1'), false);

    const ok = await stolen('PUT', '/users/' + id, { password: 'eigenes-neu-2', current_password: 'password123' });
    assert.equal(ok.status, 200);
    assert.match(ok.body.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
});

test('resetting another admin needs the caller password; editors and demotions of other admins do not', async () => {
    const other = await createUser('zweit-admin', 'admin', { current_password: 'password123' });
    const editor = await createUser('nur-editor');
    expectCode(await admin('PUT', '/users/' + other, { password: 'fremd-neu-1' }), 400, 'BAD_REQUEST');
    expectCode(await admin('PUT', '/users/' + other, { password: 'fremd-neu-1', current_password: 'falsch-falsch' }), 403, 'WRONG_PASSWORD');
    assert.equal(await canLogin('zweit-admin', 'fremd-neu-1'), false);
    assert.equal((await admin('PUT', '/users/' + other, { password: 'fremd-neu-1', current_password: 'password123' })).status, 200);
    assert.equal(await canLogin('zweit-admin', 'fremd-neu-1'), true);

    assert.equal((await admin('PUT', '/users/' + editor, { password: 'editor-neu-1' })).status, 200);
    assert.equal((await admin('PUT', '/users/' + editor, { role: 'visitor' })).status, 200);
    assert.equal((await admin('PUT', '/users/' + other, { role: 'editor' })).status, 200);
    assert.equal(row(other).role, 'editor');
});

test('wrong confirmations count toward the caller sign-in lock; the lock answers 429 with Retry-After', async () => {
    await createUser('sperre', 'admin', { current_password: 'password123' });
    const ip = { 'X-Forwarded-For': '198.51.100.23' };
    const locked = await login('sperre', 'password123', ip);
    const target = await createUser('sperre-ziel');
    for (let i = 0; i < 9; i++) {
        expectCode(await locked('PUT', '/users/' + target, { role: 'admin', current_password: 'falsch-falsch' }, ip), 403, 'WRONG_PASSWORD');
    }
    assert.equal((await locked('PUT', '/users/' + target, { role: 'admin', current_password: 'password123' }, ip)).status, 200, 'a success clears the count');
    assert.equal((await locked('PUT', '/users/' + target, { role: 'editor' }, ip)).status, 200);
    for (let i = 0; i < 10; i++) {
        expectCode(await locked('PUT', '/users/' + target, { role: 'admin', current_password: 'falsch-falsch' }, ip), 403, 'WRONG_PASSWORD');
    }
    const res = await fetch(ctx.base + '/users/' + target, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: locked.cookie, ...ip },
        body: JSON.stringify({ role: 'admin', current_password: 'password123' })
    });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'Zu viele fehlgeschlagene Anmeldeversuche für diesen Benutzer. Bitte in einigen Minuten erneut versuchen.', code: 'TOO_MANY_ATTEMPTS' });
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    assert.equal(row(target).role, 'editor');
    const signIn = await ctx.client()('POST', '/auth/login', { username: 'sperre', password: 'password123' }, ip);
    expectCode(signIn, 429, 'TOO_MANY_ATTEMPTS');
});

test('a target that becomes admin while the request waits for the hash is a 409 and stays unchanged', async () => {
    const id = await createUser('wechsel');
    const before = row(id).password_hash;
    const hash = bcrypt.hash;
    bcrypt.hash = async (...args) => {
        db().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
        return hash(...args);
    };
    let res;
    try {
        res = await admin('PUT', '/users/' + id, { password: 'heimlich-neu-1' });
    } finally {
        bcrypt.hash = hash;
    }
    expectCode(res, 409, 'CHANGED_MEANWHILE');
    assert.equal(row(id).password_hash, before);
});

test('creation, promotion and resets are logged with the admin, auth scheme and client address, never a password', async () => {
    const ip = { 'X-Forwarded-For': '203.0.113.44' };
    const created = await admin('POST', '/users', { username: 'protokoll', password: 'geheim-neu-1', role: 'editor' }, ip);
    assert.equal(created.status, 200);
    const id = created.body.user.id;
    assert.deepEqual(lastAudit(), { ...lastAudit(), msg: 'Benutzer angelegt', admin: 'chef', user: 'protokoll', role: 'editor', auth_scheme: 'cookie', ip: '203.0.113.44' });

    const app = bearer(await appToken('chef'));
    const v6 = { 'X-Forwarded-For': '2001:db8:5:6::7' };
    assert.equal((await app('PUT', '/users/' + id, { role: 'admin', current_password: 'password123' }, v6)).status, 200);
    const promotion = lastAudit();
    assert.equal(promotion.msg, 'Benutzer geändert');
    assert.deepEqual(
        [promotion.admin, promotion.user, promotion.role, promotion.previous_role, promotion.password_reset, promotion.auth_scheme],
        ['chef', 'protokoll', 'admin', 'editor', false, 'bearer']
    );
    assert.match(promotion.ip, /^2001:db8:5:6/);

    assert.equal((await admin('PUT', '/users/' + id, { password: 'geheim-neu-2', current_password: 'password123' }, ip)).status, 200);
    assert.deepEqual([lastAudit().password_reset, lastAudit().role, lastAudit().auth_scheme, lastAudit().ip], [true, 'admin', 'cookie', '203.0.113.44']);

    const count = auditLines().length;
    assert.equal((await admin('PUT', '/users/' + id, { role: 'admin', current_password: 'password123' })).status, 200);
    assert.equal(auditLines().length, count, 'an unchanged role writes no line');

    const all = lines.join('\n');
    for (const secret of ['geheim-neu-1', 'geheim-neu-2', 'password123']) assert.equal(all.includes(secret), false, secret);
});
