const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
// These tests stand in for clients behind a proxy: X-Forwarded-For picks the client address
process.env.TRUST_PROXY = 'true';
const { startTestServer } = require('./helpers');
const { createFailureTracker, createRateLimiter, clientKey, resetRateLimits, loginGuard } = require('../middleware/rateLimit');

let ctx;
let admin;
let editor;
let editorId;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    editor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    const created = await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' });
    editorId = created.body.user.id;
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });
test.beforeEach(() => resetRateLimits());

const login = (username, password, ip) => ctx.client()('POST', '/auth/login', { username, password }, ip ? { 'X-Forwarded-For': ip } : {});
const createUser = async (username, role = 'editor') => {
    const created = await admin('POST', '/users', { username, password: 'password123', role });
    assert.equal(created.status, 200);
    return created.body.user.id;
};

test('a user who created or edited a series can still be deleted', async () => {
    const manga = await editor('POST', '/mangas', { title: 'Von Editor' });
    assert.equal(manga.status, 200);
    const del = await admin('DELETE', '/users/' + editorId);
    assert.equal(del.status, 200);
    const detail = await admin('GET', '/mangas/' + manga.body.id);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.updated_by, null);
});

test('unknown roles are rejected instead of becoming editor', async () => {
    assert.equal((await admin('POST', '/users', { username: 'typo', password: 'password123', role: 'viewer' })).status, 400);
    const ok = await admin('POST', '/users', { username: 'v1', password: 'password123', role: 'visitor' });
    assert.equal(ok.status, 200);
    assert.equal((await admin('PUT', '/users/' + ok.body.user.id, { role: 'viewer' })).status, 400);
    assert.equal((await admin('PUT', '/users/' + ok.body.user.id, { role: 'editor' })).status, 200);
});

test('login: failures from one client lock that client only, the owner elsewhere still gets in', async () => {
    await createUser('lock-target');
    for (let i = 0; i < 10; i++) assert.equal((await login('Lock-Target', 'wrongwrong', '203.0.113.7')).status, 401);
    // the right password is refused from the locked client ...
    assert.equal((await login('lock-target', 'password123', '203.0.113.7')).status, 429);
    // ... but not from another address
    assert.equal((await login('lock-target', 'password123', '198.51.100.20')).status, 200);
});

test('login: failures spread over many addresses lock the account for new addresses, not for known ones', async () => {
    await createUser('spread-target');
    assert.equal((await login('spread-target', 'password123', '198.51.100.30')).status, 200);
    for (let i = 0; i < 50; i++) assert.equal((await login('spread-target', 'wrongwrong', `10.1.0.${i}`)).status, 401);
    assert.equal((await login('spread-target', 'wrongwrong', '10.1.1.1')).status, 429);
    assert.equal((await login('spread-target', 'password123', '10.1.1.2')).status, 429);
    assert.equal((await login('spread-target', 'password123', '198.51.100.30')).status, 200);
});

test('login: parallel guesses cannot pass the lock check together while bcrypt is slow', async () => {
    await createUser('race-target');
    const compare = bcrypt.compare;
    bcrypt.compare = async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 150));
        return compare(...args);
    };
    try {
        const results = await Promise.all(Array.from({ length: 15 }, () => login('race-target', 'wrongwrong', '203.0.113.50')));
        const statuses = results.map(r => r.status);
        assert.equal(statuses.filter(s => s === 401).length, 10);
        assert.equal(statuses.filter(s => s === 429).length, 5);
    } finally {
        bcrypt.compare = compare;
    }
    assert.equal((await login('race-target', 'password123', '203.0.113.50')).status, 429);
});

test('login: an overlong username is refused without keeping it as a lockout key', async () => {
    const res = await login('x'.repeat(90000), 'wrongwrong', '203.0.113.60');
    assert.equal(res.status, 401);
    assert.ok(loginGuard.keys().every(k => k.length <= 256));
    await admin('POST', '/users', { username: 'm'.repeat(64), password: 'password123', role: 'visitor' });
    assert.equal((await login('m'.repeat(64), 'password123', '203.0.113.61')).status, 200);
});

test('failure tracker: bounded keys, and a full store never evicts a live lock', () => {
    const tracker = createFailureTracker({ windowMs: 60000, max: 2, maxEntries: 3 });
    tracker.fail('real');
    tracker.fail('real');
    for (let i = 0; i < 10; i++) tracker.fail('junk-' + i + 'y'.repeat(1000));
    assert.equal(tracker.isLocked('real'), true);
    assert.ok(tracker.size() <= 3);
    assert.ok(tracker.keys().every(k => k.length <= 256));
});

test('failure tracker: a full store makes room by evicting the oldest unlocked entry, so new keys are still counted', () => {
    const tracker = createFailureTracker({ windowMs: 900000, max: 10, maxEntries: 100 });
    for (let i = 0; i < 100; i++) tracker.fail('junk' + i);
    for (let i = 0; i < 10; i++) tracker.fail('admin\n1.2.3.4');
    assert.equal(tracker.isLocked('admin\n1.2.3.4'), true);
    assert.equal(tracker.size(), 100);
    assert.ok(!tracker.keys().includes('junk0'), 'the oldest unlocked entry made room');
    assert.ok(tracker.keys().includes('junk99'));
});

test('failure tracker: when every entry is locked, unknown keys count as locked (fail closed)', () => {
    const tracker = createFailureTracker({ windowMs: 900000, max: 2, maxEntries: 2 });
    for (const key of ['a', 'b']) { tracker.fail(key); tracker.fail(key); }
    assert.equal(tracker.isLocked('new'), true);
    assert.ok(tracker.fail('new') >= 2);
    assert.equal(tracker.isLocked('a'), true);
    tracker.reset('a');
    assert.equal(tracker.isLocked('new'), false);
    tracker.fail('new');
    assert.equal(tracker.isLocked('new'), false);
    assert.equal(tracker.isLocked('b'), true);
});

test('request limiter: a full store evicts unlimited entries; when every entry is limited it fails open', () => {
    const limiter = createRateLimiter({ windowMs: 900000, max: 1, maxEntries: 2, keyFn: (req) => req.key });
    const hit = (key) => {
        let status = 200;
        const res = { setHeader() {}, status(code) { status = code; return this; }, json() { return this; } };
        limiter(Object.assign({ headers: {} }, { key }), res, () => {});
        return status;
    };
    assert.equal(hit('a'), 200);
    assert.equal(hit('a'), 429);
    assert.equal(hit('b'), 200);
    assert.equal(hit('c'), 200, 'b was not limited and made room');
    assert.equal(hit('c'), 429);
    assert.equal(hit('a'), 429, 'a limited entry is never evicted');
    assert.equal(hit('d'), 200, 'every entry limited: unknown keys pass uncounted');
    assert.equal(hit('d'), 200);
    assert.equal(hit('c'), 429);
});

test('an admin password reset lifts the login lock of that user', async () => {
    const id = await createUser('reset-lock');
    for (let i = 0; i < 10; i++) await login('reset-lock', 'wrongwrong', '203.0.113.70');
    assert.equal((await login('reset-lock', 'password123', '203.0.113.70')).status, 429);
    assert.equal((await admin('PUT', '/users/' + id, { password: 'brand-new-pass' })).status, 200);
    assert.equal((await login('reset-lock', 'brand-new-pass', '203.0.113.70')).status, 200);
    assert.equal((await login('reset-lock', 'password123', '203.0.113.70')).status, 401);
});

test('own password: wrong current passwords count toward the lock and are limited per account', async () => {
    await createUser('pw-guess');
    const session = ctx.client();
    assert.equal((await session('POST', '/auth/login', { username: 'pw-guess', password: 'password123' }, { 'X-Forwarded-For': '203.0.113.80' })).status, 200);
    for (let i = 0; i < 10; i++) {
        const r = await session('PUT', '/auth/password', { current_password: 'wrongwrong', new_password: 'brandnew123' }, { 'X-Forwarded-For': '203.0.113.80' });
        assert.equal(r.status, 403);
    }
    // same client: the login lock is shared with failed logins
    assert.equal((await login('PW-GUESS', 'password123', '203.0.113.80')).status, 429);
    // rotating addresses does not help against the per-account limit of this route
    const next = await session('PUT', '/auth/password', { current_password: 'password123', new_password: 'brandnew123' }, { 'X-Forwarded-For': '203.0.113.81' });
    assert.equal(next.status, 429);
    assert.match(next.body.error, /Passwort zu ändern/);
});

test('own password: logins from the same address do not use up the password change budget', async () => {
    await createUser('nat-user');
    const session = ctx.client();
    const nat = { 'X-Forwarded-For': '192.0.2.50' };
    for (let i = 0; i < 20; i++) {
        assert.equal((await session('POST', '/auth/login', { username: 'nat-user', password: 'password123' }, nat)).status, 200);
    }
    assert.equal((await session('PUT', '/auth/password', { current_password: 'password123', new_password: 'brandnew123' }, nat)).status, 200);
});

test('login limiter: only well-formed failed attempts count, successful logins and empty bodies do not', async () => {
    await createUser('busy-office');
    await createUser('new-colleague');
    const ip = '192.0.2.60';
    for (let i = 0; i < 25; i++) {
        assert.equal((await ctx.client()('POST', '/auth/login', {}, { 'X-Forwarded-For': ip })).status, 400);
        assert.equal((await login('busy-office', 'password123', ip)).status, 200);
    }
    // 50 failed attempts on different accounts (below every per-account lock) use up the per-address budget ...
    for (let i = 0; i < 50; i++) assert.equal((await login('nobody-' + i, 'wrongwrong', ip)).status, 401);
    const blocked = await login('new-colleague', 'password123', ip);
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Anmeldeversuche/);
    assert.equal((await login('nobody-x', 'wrongwrong', ip)).status, 429);
    // ... but an account that logged in from this address before still gets in, and other addresses are unaffected
    assert.equal((await login('busy-office', 'password123', ip)).status, 200);
    assert.equal((await login('new-colleague', 'password123', '192.0.2.61')).status, 200);
});

test('login: a locked account answers without using up the address budget', async () => {
    await createUser('locked-acct');
    const ip = '192.0.2.70';
    for (let i = 0; i < 10; i++) assert.equal((await login('locked-acct', 'wrongwrong', ip)).status, 401);
    for (let i = 0; i < 60; i++) assert.equal((await login('locked-acct', 'wrongwrong', ip)).status, 429);
    // only the 10 bcrypt-checked failures counted: 40 more failures on other accounts are still answered
    for (let i = 0; i < 40; i++) assert.equal((await login('other-' + i, 'wrongwrong', ip)).status, 401);
    assert.equal((await login('other-x', 'wrongwrong', ip)).status, 429);
});

test('login: a limiter store saturated by 60k addresses still lets a fresh address log in', async () => {
    const { loginLimiter } = require('../middleware/rateLimit');
    await createUser('after-flood');
    const res = { setHeader() {}, status() { return this; }, json() { return this; } };
    for (let k = 0; k < 60000; k++) {
        const req = { ip: `10.${k >> 16}.${(k >> 8) & 255}.${k & 255}`, headers: {}, socket: {} };
        for (let i = 0; i < 51; i++) loginLimiter.consume(req, res);
    }
    assert.equal(loginLimiter.size(), 50000);
    assert.equal((await login('after-flood', 'wrongwrong', '198.51.100.99')).status, 401);
    assert.equal((await login('after-flood', 'password123', '198.51.100.98')).status, 200);
    assert.equal((await login('after-flood', 'password123', '2001:db8:aaaa:1::1')).status, 200);
    assert.equal(loginLimiter.size(), 50000);
});

test('rate-limit keys: IPv6 clients count per /64, IPv4-mapped addresses as IPv4', async () => {
    assert.equal(clientKey('2001:db8:1:2:aaaa::1'), clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
    assert.equal(clientKey('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(clientKey('198.51.100.7'), '198.51.100.7');

    await createUser('v6-target');
    for (let i = 0; i < 10; i++) {
        assert.equal((await login('v6-target', 'wrongwrong', `2001:db8:1:2::${(i + 1).toString(16)}`)).status, 401);
    }
    assert.equal((await login('v6-target', 'password123', '2001:db8:1:2:dead:beef:0:1')).status, 429);
    assert.equal((await login('v6-target', 'password123', '2001:db8:1:3::1')).status, 200);
});

test('an admin resetting their own password via user management stays signed in, other sessions end', async () => {
    const id = await createUser('boss2', 'admin');
    const here = ctx.client();
    const elsewhere = ctx.client();
    assert.equal((await here('POST', '/auth/login', { username: 'boss2', password: 'password123' })).status, 200);
    assert.equal((await elsewhere('POST', '/auth/login', { username: 'boss2', password: 'password123' })).status, 200);
    assert.equal((await here('PUT', '/users/' + id, { password: 'newpassword123' })).status, 200);
    assert.equal((await here('GET', '/auth/me')).status, 200);
    assert.equal((await elsewhere('GET', '/auth/me')).status, 401);
    assert.equal((await here('PUT', '/users/' + id, { role: 'admin' })).status, 200);
});

test('volumes: status is validated, renumbering to an existing number is a 409, read flags parse strings', async () => {
    const manga = (await admin('POST', '/mangas', { title: 'Validierung' })).body.id;
    const v1 = (await admin('POST', '/volumes', { manga_id: manga, volume_number: '1' })).body.id;
    const v2 = (await admin('POST', '/volumes', { manga_id: manga, volume_number: '2' })).body.id;
    assert.equal((await admin('POST', '/volumes', { manga_id: manga, volume_number: '3', status: 'Quatsch' })).status, 400);
    assert.equal((await admin('PUT', '/volumes/' + v2, { status: 'Quatsch' })).status, 400);
    assert.equal((await admin('PUT', '/volumes/' + v2, { volume_number: '1' })).status, 409);
    assert.equal((await admin('PUT', '/volumes/' + v2, { volume_number: '1', type: 'special_edition' })).status, 200);

    assert.equal((await admin('POST', '/volumes/batch-read', { manga_id: manga, up_to_volume: 2 })).body.count, 2);
    await admin('POST', '/volumes/batch-read', { manga_id: manga, up_to_volume: 2, read: 'false' });
    const detail = await admin('GET', '/mangas/' + manga);
    assert.equal(detail.body.volumes.filter(v => v.is_read).length, 0);
    assert.equal((await admin('POST', `/volumes/${v1}/read`, { user_id: 9999 })).status, 404);
});

test('manga update rejects a non-string title instead of crashing', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Titel' })).body.id;
    assert.equal((await admin('PUT', '/mangas/' + id, { title: 123 })).status, 400);
    assert.equal((await admin('PUT', '/mangas/' + id, { title: 'x'.repeat(301) })).status, 400);
    assert.equal((await admin('PUT', '/mangas/' + id, { title: 'Neu' })).status, 200);
});

test('a password reset ends older sessions of that user, a new login works', async () => {
    const created = await admin('POST', '/users', { username: 'reset-me', password: 'password123', role: 'editor' });
    const session = ctx.client();
    assert.equal((await session('POST', '/auth/login', { username: 'reset-me', password: 'password123' })).status, 200);
    assert.equal((await session('GET', '/auth/me')).status, 200);

    assert.equal((await admin('PUT', '/users/' + created.body.user.id, { password: 'newpassword123' })).status, 200);

    assert.equal((await session('GET', '/auth/me')).status, 401);
    const fresh = ctx.client();
    assert.equal((await fresh('POST', '/auth/login', { username: 'reset-me', password: 'newpassword123' })).status, 200);
    assert.equal((await fresh('GET', '/auth/me')).status, 200);
});

test('responses carry hardening headers and no blanket CORS', async () => {
    const res = await fetch(ctx.base + '/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('server snapshots use a consistent database copy and leave no temp files behind', async () => {
    const fs = require('fs');
    const path = require('path');
    const AdmZip = require('adm-zip');
    const snap = await admin('POST', '/backups/create');
    assert.equal(snap.status, 200);
    const file = path.join(ctx.dataDir, 'backups', snap.body.snapshot.filename);
    assert.ok(new AdmZip(file).getEntry('manga.db'), 'manga.db is in the snapshot');
    assert.deepEqual(fs.readdirSync(path.join(ctx.dataDir, 'temp')).filter(f => f.startsWith('backup-db-')), []);
});

test('own password: needs the current one, ends other sessions, keeps the current one', async () => {
    const created = await admin('POST', '/users', { username: 'self-change', password: 'password123', role: 'visitor' });
    assert.equal(created.status, 200);
    const phone = ctx.client();
    const laptop = ctx.client();
    assert.equal((await phone('POST', '/auth/login', { username: 'self-change', password: 'password123' })).status, 200);
    assert.equal((await laptop('POST', '/auth/login', { username: 'self-change', password: 'password123' })).status, 200);

    assert.equal((await laptop('PUT', '/auth/password', { current_password: 'falsch-falsch', new_password: 'brandnew123' })).status, 403);
    assert.equal((await laptop('PUT', '/auth/password', { current_password: 'password123', new_password: 'short' })).status, 400);

    assert.equal((await laptop('PUT', '/auth/password', { current_password: 'password123', new_password: 'brandnew123' })).status, 200);
    assert.equal((await laptop('GET', '/auth/me')).status, 200);
    assert.equal((await phone('GET', '/auth/me')).status, 401);
    assert.equal((await ctx.client()('POST', '/auth/login', { username: 'self-change', password: 'brandnew123' })).status, 200);
});

test('usernames are unique and log in regardless of case', async () => {
    assert.equal((await admin('POST', '/users', { username: 'CaseUser', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'caseuser', password: 'password123' })).status, 400);
    assert.equal((await ctx.client()('POST', '/auth/login', { username: 'CASEUSER', password: 'password123' })).status, 200);
});

test('responses carry a Content-Security-Policy without inline scripts', async () => {
    const res = await fetch(ctx.base.replace(/\/api$/, '') + '/api/health');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /object-src 'none'/);
});

test('volume input is validated: unknown series, dates, photo list, username length', async () => {
    const manga = await admin('POST', '/mangas', { title: 'Validierung' });
    const mid = manga.body.id;
    assert.equal((await admin('POST', '/volumes', { manga_id: 987654, volume_number: '1' })).status, 404);
    assert.equal((await admin('POST', '/volumes', { manga_id: mid, volume_number: '1', release_date: 'morgen' })).status, 400);
    assert.equal((await admin('POST', '/volumes', { manga_id: mid, volume_number: '1', purchase_date: '2024-13-01' })).status, 400);
    assert.equal((await admin('POST', '/volumes', { manga_id: mid, volume_number: '1', images: 'kein json' })).status, 400);
    assert.equal((await admin('POST', '/volumes', { manga_id: mid, volume_number: '1', images: [1, 2] })).status, 400);

    const ok = await admin('POST', '/volumes', { manga_id: mid, volume_number: '1', release_date: '2024-05', purchase_date: '2024-05-17', images: ['/uploads/a.jpg'] });
    assert.equal(ok.status, 200);
    const vid = ok.body.id;
    assert.equal((await admin('PUT', '/volumes/' + vid, { release_date: '2024-99-99' })).status, 400);
    assert.equal((await admin('PUT', '/volumes/' + vid, { images: '["/uploads/b.jpg"]' })).status, 200);
    assert.equal((await admin('PUT', '/volumes/' + vid, { status: 'Fehlt', release_date: '2024-05' })).status, 200);

    const long = await admin('POST', '/users', { username: 'u'.repeat(65), password: 'password123', role: 'editor' });
    assert.equal(long.status, 400);
});

test('Manga Passion actions on an unknown series answer 404', async () => {
    assert.equal((await admin('GET', '/mangas/987654/gaps')).status, 404);
    assert.equal((await admin('POST', '/mangas/987654/sync-edition', { edition_id: 1 })).status, 404);
    assert.equal((await admin('POST', '/mangas/987654/batch-import-gaps', { volume_numbers: ['1'] })).status, 404);
    assert.equal((await admin('POST', '/mangas/987654/autofill-volumes', {})).status, 404);
});

const userRow = (id) => require('../db').db.prepare('SELECT username, password_hash FROM users WHERE id = ?').get(id);

async function withSlowHash(during, fn) {
    const hash = bcrypt.hash;
    bcrypt.hash = async (...args) => {
        const result = await hash(...args);
        during();
        return result;
    };
    try {
        return await fn();
    } finally {
        bcrypt.hash = hash;
    }
}

test('own password: a change of the account during the bcrypt await is not overwritten', async () => {
    const id = await createUser('pw-race');
    const session = ctx.client();
    assert.equal((await session('POST', '/auth/login', { username: 'pw-race', password: 'password123' })).status, 200);
    const { db } = require('../db');

    const otherHash = await bcrypt.hash('parallel-change', 4);
    const res = await withSlowHash(() => db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(otherHash, id),
        () => session('PUT', '/auth/password', { current_password: 'password123', new_password: 'brandnew123' }));
    assert.equal(res.status, 409);
    assert.match(res.body.error, /in der Zwischenzeit geändert/);
    assert.equal(userRow(id).password_hash, otherHash);

    // a restore during the await gave the id to someone else
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash('password123', 4), id);
    const before = userRow(id).password_hash;
    const swapped = await withSlowHash(() => db.prepare("UPDATE users SET username = 'pw-race-other' WHERE id = ?").run(id),
        () => session('PUT', '/auth/password', { current_password: 'password123', new_password: 'brandnew123' }));
    assert.equal(swapped.status, 401);
    assert.equal(swapped.body.code, 'SESSION_INVALID');
    assert.deepEqual({ ...userRow(id) }, { username: 'pw-race-other', password_hash: before });
});

test('admin password reset: the target changing during the bcrypt await gives 409 and writes nothing', async () => {
    const id = await createUser('reset-race');
    const { db } = require('../db');
    const before = userRow(id).password_hash;
    const res = await withSlowHash(() => db.prepare("UPDATE users SET username = 'reset-race-other' WHERE id = ?").run(id),
        () => admin('PUT', '/users/' + id, { password: 'brand-new-pass', role: 'visitor' }));
    assert.equal(res.status, 409);
    assert.match(res.body.error, /in der Zwischenzeit geändert/);
    assert.equal(userRow(id).password_hash, before);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(id).role, 'editor');

    db.prepare("UPDATE users SET username = 'reset-race' WHERE id = ?").run(id);
    const otherHash = await bcrypt.hash('another-reset', 4);
    const parallel = await withSlowHash(() => db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(otherHash, id),
        () => admin('PUT', '/users/' + id, { password: 'brand-new-pass' }));
    assert.equal(parallel.status, 409);
    assert.equal(userRow(id).password_hash, otherHash);
    assert.equal((await admin('PUT', '/users/' + id, { password: 'brand-new-pass' })).status, 200);
});

test('logout: limited per address, the cookie is cleared anyway', async () => {
    const ip = { 'X-Forwarded-For': '192.0.2.90' };
    for (let i = 0; i < 30; i++) assert.equal((await ctx.client()('POST', '/auth/logout', undefined, ip)).status, 200);
    const res = await fetch(ctx.base + '/auth/logout', { method: 'POST', headers: ip });
    assert.equal(res.status, 429);
    assert.match(res.headers.get('set-cookie') || '', /^token=;/);
    assert.equal((await ctx.client()('POST', '/auth/logout', undefined, { 'X-Forwarded-For': '192.0.2.91' })).status, 200);
});

test('logout: a token whose session already ended is not added to the logout list', async () => {
    const id = await createUser('stale-logout');
    const res = await fetch(ctx.base + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'stale-logout', password: 'password123' })
    });
    const token = res.headers.get('set-cookie').split(';')[0].slice('token='.length);
    assert.equal((await admin('PUT', '/users/' + id, { password: 'newpassword123' })).status, 200);
    assert.equal((await ctx.client('token=' + token)('POST', '/auth/logout')).status, 200);
    const digest = require('crypto').createHash('sha256').update(token).digest('base64url');
    const row = require('../db').db.prepare("SELECT value FROM app_settings WHERE key = 'revoked_sessions'").get();
    assert.ok(!row || !(digest in JSON.parse(row.value)));
});

test('usernames with comma, vertical bar or control characters are refused', async () => {
    for (const username of ['a,b', 'a|b', 'tab\there', 'nl\nx', 'del\u007f']) {
        const res = await admin('POST', '/users', { username, password: 'password123', role: 'visitor' });
        assert.equal(res.status, 400, JSON.stringify(username));
        assert.match(res.body.error, /Komma/);
    }
    assert.equal((await admin('POST', '/users', { username: 'Anna Ben', password: 'password123', role: 'visitor' })).status, 200);
});

test('header gaps: no X-Powered-By, Permissions-Policy keeps the camera for this origin, COOP, HSTS only over HTTPS', async () => {
    const plain = await fetch(ctx.base + '/health');
    assert.equal(plain.headers.get('x-powered-by'), null);
    assert.equal(plain.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    assert.equal(plain.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(plain.headers.get('strict-transport-security'), null);
    // TRUST_PROXY=true in this file: the proxy says the client used https
    const secure = await fetch(ctx.base + '/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(secure.headers.get('strict-transport-security'), 'max-age=15552000');
    const page = await fetch(ctx.root + '/', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(page.headers.get('strict-transport-security'), 'max-age=15552000');
});

test('API answers are never cached: sessions, users and backups are no-store', async () => {
    for (const route of ['/auth/me', '/users', '/backups', '/version', '/export/csv']) {
        const res = await fetch(ctx.base + route, { headers: { Cookie: admin.cookie } });
        assert.equal(res.status, 200, route);
        assert.equal(res.headers.get('cache-control'), 'no-store', route);
        await res.arrayBuffer();
    }
    const denied = await fetch(ctx.base + '/users');
    assert.equal(denied.headers.get('cache-control'), 'no-store');
});

test('cross-origin writes from a browser are refused before the body is read', async () => {
    const res = await fetch(ctx.base + '/backups/create', {
        method: 'POST',
        headers: { Cookie: admin.cookie, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-site' }
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'CROSS_ORIGIN');
    const sameOrigin = await fetch(ctx.base + '/mangas', {
        method: 'POST',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({ title: 'Gleicher Ursprung' })
    });
    assert.equal(sameOrigin.status, 200);
});

const APP_ORIGINS = ['capacitor://localhost', 'https://localhost', 'ionic://localhost', 'app://manga-shelf'];

test('CORS: the app origins get a preflight for bearer requests, without credentials', async () => {
    for (const origin of APP_ORIGINS) {
        const res = await fetch(ctx.base + '/auth/login', {
            method: 'OPTIONS',
            headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,x-client,content-type' }
        });
        assert.equal(res.status, 204, origin);
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
        assert.equal(res.headers.get('access-control-allow-credentials'), null);
        const allowed = res.headers.get('access-control-allow-headers').toLowerCase().split(',');
        for (const header of ['authorization', 'x-client', 'content-type', 'if-none-match']) assert.ok(allowed.includes(header), header);
        assert.match(res.headers.get('access-control-allow-methods'), /DELETE/);
        assert.match(res.headers.get('vary'), /Origin/);
    }
    const foreign = await fetch(ctx.base + '/auth/login', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' }
    });
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    assert.equal(foreign.headers.get('access-control-allow-headers'), null);
    const plainHttp = await fetch(ctx.base + '/health', { headers: { Origin: 'http://localhost' } });
    assert.equal(plainHttp.headers.get('access-control-allow-origin'), null, 'http://localhost is no app origin');

    const health = await fetch(ctx.base + '/health', { headers: { Origin: 'capacitor://localhost' } });
    assert.equal(health.headers.get('access-control-allow-origin'), 'capacitor://localhost');
    assert.match(health.headers.get('access-control-expose-headers'), /ETag/);
    assert.match(health.headers.get('access-control-expose-headers'), /X-Request-Id/);
});

test('app clients: login from an app origin and bearer writes pass the origin check; cookie sessions stay protected', async () => {
    await createUser('app-ed');
    const appHeaders = { Origin: 'capacitor://localhost', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' };
    const login = await fetch(ctx.base + '/auth/login', {
        method: 'POST',
        headers: { ...appHeaders, 'X-Client': 'app' },
        body: JSON.stringify({ username: 'app-ed', password: 'password123' })
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('access-control-allow-origin'), 'capacitor://localhost');
    const { token } = await login.json();
    const write = await fetch(ctx.base + '/mangas', {
        method: 'POST',
        headers: { ...appHeaders, Authorization: 'Bearer ' + token },
        body: JSON.stringify({ title: 'Aus der App' })
    });
    assert.equal(write.status, 200);

    const cookieRide = await fetch(ctx.base + '/mangas', {
        method: 'POST',
        headers: { ...appHeaders, Origin: 'https://localhost', 'Sec-Fetch-Site': 'same-site', Cookie: admin.cookie },
        body: JSON.stringify({ title: 'Nein' })
    });
    assert.equal((await cookieRide.json()).code, 'CROSS_ORIGIN');
    const both = await fetch(ctx.base + '/mangas', {
        method: 'POST',
        headers: { ...appHeaders, Origin: 'https://evil.example', Cookie: admin.cookie, Authorization: 'Bearer ' + token },
        body: JSON.stringify({ title: 'Nein' })
    });
    assert.equal(both.status, 403, 'a bearer next to the cookie does not lift the check');
});

test('uploads stay CORP same-origin for everyone; the apps read them through CORS, varied on Origin', async () => {
    for (const origin of [undefined, 'capacitor://localhost', 'https://localhost', 'https://evil.example']) {
        const res = await fetch(ctx.root + '/uploads/missing.jpg', { headers: origin ? { Origin: origin } : {} });
        assert.equal(res.status, 404);
        assert.match(res.headers.get('vary'), /Origin/, String(origin));
        assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin', String(origin));
        const app = origin && APP_ORIGINS.includes(origin);
        assert.equal(res.headers.get('access-control-allow-origin'), app ? origin : null, String(origin));
    }
});

test('APP_ORIGINS replaces the app origins, none switches them off', async () => {
    const { createApp } = require('../index.js');
    const probe = async (value, origin) => {
        const saved = process.env.APP_ORIGINS;
        process.env.APP_ORIGINS = value;
        const server = await new Promise((resolve) => {
            const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
        });
        if (saved === undefined) delete process.env.APP_ORIGINS; else process.env.APP_ORIGINS = saved;
        try {
            const base = `http://127.0.0.1:${server.address().port}/api`;
            const preflight = await fetch(base + '/auth/login', {
                method: 'OPTIONS',
                headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
            });
            const login = await fetch(base + '/auth/login', {
                method: 'POST',
                headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json', 'X-Client': 'app' },
                body: JSON.stringify({ username: 'nobody-here', password: 'password123' })
            });
            await login.arrayBuffer();
            return { allowOrigin: preflight.headers.get('access-control-allow-origin'), login: login.status };
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    };
    assert.deepEqual(await probe('none', 'capacitor://localhost'), { allowOrigin: null, login: 403 });
    assert.deepEqual(await probe(' https://shell.example/ ', 'https://shell.example'), { allowOrigin: 'https://shell.example', login: 401 });
    assert.deepEqual(await probe('https://shell.example', 'capacitor://localhost'), { allowOrigin: null, login: 403 });
});

test('a session cookie spelled with spaces around the name still gets the origin check', async () => {
    const cookie = admin.cookie.replace(/^token=/, 'token =');
    assert.notEqual(cookie, admin.cookie);
    const res = await fetch(ctx.base + '/mangas', {
        method: 'POST',
        headers: {
            Cookie: cookie, Authorization: 'Bearer a.b.c', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ title: 'Nein' })
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'CROSS_ORIGIN');
});

test('error bodies: no route answers an error itself without the shared helper (static scan)', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'routes');
    const offenders = [];
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
        fs.readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((line, i) => {
            if (/\.status\(\s*(?:[45]\d\d|[A-Za-z_.]+)\s*\)\s*\.json\(/.test(line)) offenders.push(`${file}:${i + 1}`);
        });
    }
    assert.deepEqual(offenders, [], 'use throw new HttpError(...) or sendError(res, ...)');
});

test('error bodies: direct answers of routes and middleware carry a code, 5xx a ref, none an ETag', async () => {
    const send = async (method, route, body, headers = {}) => {
        const res = await fetch(ctx.base + route, {
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: res.status, headers: res.headers, body: await res.json() };
    };
    await createUser('codes-user');
    const user = ctx.client();
    assert.equal((await user('POST', '/auth/login', { username: 'codes-user', password: 'password123' }, { 'X-Forwarded-For': '10.9.0.3' })).status, 200);
    const wrongLogin = await send('POST', '/auth/login', { username: 'codes-user', password: 'falsch-123' }, { 'X-Forwarded-For': '10.9.0.1' });
    assert.deepEqual([wrongLogin.status, wrongLogin.body.code], [401, 'INVALID_CREDENTIALS']);
    const taken = await admin('POST', '/users', { username: 'CODES-USER', password: 'password123', role: 'editor' });
    assert.deepEqual([taken.status, taken.body.code], [400, 'USERNAME_TAKEN']);
    const wrongCurrent = await user('PUT', '/auth/password', { current_password: 'falsch-123', new_password: 'password456' });
    assert.deepEqual([wrongCurrent.status, wrongCurrent.body.code], [403, 'WRONG_PASSWORD']);

    let limited;
    for (let i = 0; i < 12 && !limited; i++) {
        const res = await send('POST', '/setup', { username: 'x', password: 'password123' }, { 'X-Forwarded-For': '10.9.0.2' });
        if (res.status === 429) limited = res;
        else assert.equal(res.body.code, 'ADMIN_EXISTS');
    }
    assert.ok(limited, 'the setup limiter answers 429');
    assert.equal(limited.body.code, 'TOO_MANY_REQUESTS');
    assert.equal(limited.body.ref, undefined);

    const realFetch = global.fetch;
    global.fetch = (url, opts) => (String(url).startsWith(ctx.base) ? realFetch(url, opts) : Promise.reject(new Error('offline')));
    let unavailable;
    try {
        const res = await realFetch(ctx.base + '/manga-passion/editions?title=Offline%20Reihe&force_refresh=true', { headers: { Cookie: user.cookie } });
        unavailable = { status: res.status, headers: res.headers, body: await res.json() };
    } finally {
        global.fetch = realFetch;
    }
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, 'MP_UNAVAILABLE');
    assert.equal(unavailable.body.ref, unavailable.headers.get('x-request-id'));
    for (const res of [wrongLogin, limited, unavailable]) {
        assert.equal(res.headers.get('etag'), null);
        assert.equal(res.headers.get('cache-control'), 'no-store');
    }
});

test('error bodies: a 500 a middleware answers itself still gets a code and the request id as ref', async (t) => {
    const scratch = require('../db').openRawDb(':memory:');
    const proto = Object.getPrototypeOf(scratch);
    scratch.close();
    const prepare = proto.prepare;
    t.mock.method(proto, 'prepare', function (sql) {
        if (/FROM users WHERE id/i.test(sql)) throw new Error('disk I/O error');
        return prepare.call(this, sql);
    });
    const res = await fetch(ctx.base + '/mangas', { headers: { Cookie: admin.cookie } });
    t.mock.restoreAll();
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Authentifizierung fehlgeschlagen', code: 'INTERNAL_ERROR', ref: res.headers.get('x-request-id') });
});
