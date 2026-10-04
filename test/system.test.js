const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer } = require('./helpers');

let ctx, admin, editor, system;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client(); editor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' })).status, 200);
    await editor('POST', '/auth/login', { username: 'ed', password: 'password123' });
    system = require('../routes/system');
});
test.after(async () => { await ctx.close(); });

function fakeGithub(impl) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = (url, opts) => {
        if (String(url).startsWith(ctx.base)) return realFetch(url, opts);
        calls.push(String(url));
        return impl(String(url), opts);
    };
    return { calls, restore: () => { global.fetch = realFetch; } };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('GET /system: admins only, with version, storage, backups, orphans, sources and update state', async () => {
    const gh = fakeGithub(() => Promise.reject(new Error('offline')));
    try {
        system.resetSystemState();
        assert.equal((await ctx.client()('GET', '/system')).status, 401);
        assert.equal((await editor('GET', '/system')).status, 403);
        const res = await admin('GET', '/system');
        assert.equal(res.status, 200);
        const b = res.body;
        assert.equal(b.version, require('../package.json').version);
        assert.equal(b.node, process.version);
        assert.ok(Number.isInteger(b.uptime));
        assert.equal(b.data_dir, ctx.dataDir);
        assert.ok(['ok', 'degraded', 'error'].includes(b.health.status));
        assert.ok(b.database.bytes > 0);
        assert.equal(b.database.schema_version, b.database.latest_schema_version);
        assert.equal(b.database.counts.users, 2);
        assert.ok(b.storage.free_bytes === null || b.storage.free_bytes > 0);
        assert.deepEqual(b.storage.uploads, { count: 0, bytes: 0 });
        assert.equal(b.orphans.count, 0);
        assert.equal(b.backups.count, 0);
        assert.equal(b.backups.last_verified, null);
        assert.equal(typeof b.backups.schedule.hour, 'number');
        assert.deepEqual(b.jobs, { running: [], restore_running: false });
        assert.deepEqual(b.sources, { users_with_keys: 0 });
        assert.equal(b.update.current, b.version);
        assert.equal(b.update.available, false);
        await system.updateRun();
    } finally {
        gh.restore();
    }
});

test('update check: a newer GitHub release is reported after the background check; failures stay quiet', async () => {
    const gh = fakeGithub(() => Promise.resolve(jsonResponse({ tag_name: 'v99.1.0', html_url: 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v99.1.0' })));
    try {
        system.resetSystemState();
        const first = await admin('GET', '/system');
        assert.equal(first.body.update.latest, null, 'the page never waits for GitHub');
        await system.updateRun();
        const second = (await admin('GET', '/system')).body.update;
        assert.equal(second.latest, '99.1.0');
        assert.equal(second.available, true);
        assert.match(second.url, /^https:\/\/github\.com\//);
        assert.ok(second.checked_at);
        assert.equal(gh.calls.length, 1, 'checked once a day');
        assert.match(gh.calls[0], /api\.github\.com\/repos\/LixNix-Swap-Org\/manga-shelf\/releases\/latest/);
    } finally {
        gh.restore();
    }

    const failing = fakeGithub(() => Promise.resolve(jsonResponse({ message: 'Not Found' }, 404)));
    try {
        system.resetSystemState();
        await admin('GET', '/system');
        await system.updateRun();
        const state = (await admin('GET', '/system')).body.update;
        assert.equal(state.latest, null);
        assert.equal(state.available, false);
        assert.equal(failing.calls.length, 1, 'retried at most hourly');
    } finally {
        failing.restore();
    }

    assert.ok(system.compareVersions('2.20.0', '2.19.1') > 0);
    assert.equal(system.compareVersions('v2.19.1', '2.19.1'), 0);
    assert.ok(system.compareVersions('2.9.0', '2.10.0') < 0);
});

test('update check: UPDATE_CHECK=false sends nothing', async () => {
    const gh = fakeGithub(() => assert.fail('no request expected'));
    process.env.UPDATE_CHECK = 'false';
    try {
        system.resetSystemState();
        const state = (await admin('GET', '/system')).body.update;
        assert.equal(state.enabled, false);
        assert.equal(system.updateRun(), null);
        assert.equal(gh.calls.length, 0);
    } finally {
        delete process.env.UPDATE_CHECK;
        gh.restore();
    }
});

test('orphans: counted by a dry run, removed by POST /system/orphans/clean (editors refused)', async () => {
    const gh = fakeGithub(() => Promise.reject(new Error('offline')));
    try {
        const uploads = path.join(ctx.dataDir, 'uploads');
        fs.mkdirSync(uploads, { recursive: true });
        const orphan = path.join(uploads, 'verwaist.jpg');
        const fresh = path.join(uploads, 'frisch.jpg');
        const trashed = path.join(uploads, 'papierkorb-cover.jpg');
        fs.writeFileSync(orphan, Buffer.alloc(2048));
        fs.writeFileSync(fresh, Buffer.alloc(10));
        fs.writeFileSync(trashed, Buffer.alloc(100));
        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        fs.utimesSync(orphan, old, old);
        fs.utimesSync(trashed, old, old);
        // a series in the trash still needs its cover for a restore
        const { db } = require('../db');
        db.exec('CREATE TABLE IF NOT EXISTS trash (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id INTEGER NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL)');
        db.prepare('INSERT INTO trash (kind, ref_id, title, payload) VALUES (?, ?, ?, ?)')
            .run('manga', 999, 'Gelöscht', JSON.stringify({ manga: { cover_image: '/uploads/papierkorb-cover.jpg' } }));

        const before = (await admin('GET', '/system?refresh=1')).body;
        assert.deepEqual(before.storage.uploads, { count: 3, bytes: 2158 });
        assert.equal(before.orphans.count, 1);
        assert.equal(before.orphans.bytes, 2048);

        assert.equal((await editor('POST', '/system/orphans/clean')).status, 403);
        const cleaned = await admin('POST', '/system/orphans/clean');
        assert.equal(cleaned.status, 200);
        assert.deepEqual(cleaned.body, { success: true, removed: 1, bytes: 2048, skipped: false });
        assert.ok(!fs.existsSync(orphan));
        assert.ok(fs.existsSync(fresh), 'uploads younger than 7 days stay');
        assert.ok(fs.existsSync(trashed), 'covers of trashed entries stay');
        assert.equal((await admin('GET', '/system')).body.orphans.count, 0);
        await system.updateRun();
    } finally {
        gh.restore();
    }
});

test('POST /system/sessions/end-all ends every session; the admin keeps working with a new one', async () => {
    const other = ctx.client();
    await other('POST', '/auth/login', { username: 'ed', password: 'password123' });
    assert.equal((await other('GET', '/auth/me')).status, 200);
    const app = await fetch(`${ctx.base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'app' },
        body: JSON.stringify({ username: 'admin', password: 'password123' })
    }).then(r => r.json());
    assert.ok(app.token);

    assert.equal((await editor('POST', '/system/sessions/end-all')).status, 403);
    const oldCookie = admin.cookie;
    const res = await admin('POST', '/system/sessions/end-all');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.users, 2);
    assert.equal(res.body.token, undefined, 'browser clients get the cookie only');
    assert.notEqual(admin.cookie, oldCookie);
    assert.equal((await admin('GET', '/auth/me')).status, 200);
    assert.equal((await other('GET', '/auth/me')).status, 401);
    assert.equal((await ctx.client(oldCookie)('GET', '/auth/me')).status, 401);
    const bearerMe = await fetch(`${ctx.base}/auth/me`, { headers: { Authorization: `Bearer ${app.token}` } });
    assert.equal(bearerMe.status, 401);

    const fresh = await fetch(`${ctx.base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'app' },
        body: JSON.stringify({ username: 'admin', password: 'password123' })
    }).then(r => r.json());
    const viaBearer = await fetch(`${ctx.base}/system/sessions/end-all`, { method: 'POST', headers: { Authorization: `Bearer ${fresh.token}` } }).then(r => r.json());
    assert.ok(viaBearer.token, 'app clients get the new token in the body');
    assert.equal((await fetch(`${ctx.base}/auth/me`, { headers: { Authorization: `Bearer ${viaBearer.token}` } })).status, 200);
    await editor('POST', '/auth/login', { username: 'ed', password: 'password123' });
    await admin('POST', '/auth/login', { username: 'admin', password: 'password123' });
});

test('the calendar feed is rate-limited per address', async () => {
    const hit = () => fetch(`${ctx.base}/radar/feed.ics?token=${'x'.repeat(43)}`, { headers: { 'X-Forwarded-For': '10.77.0.1' } });
    let last;
    for (let i = 0; i < 121; i++) last = await hit();
    assert.equal(last.status, 429);
    const elsewhere = await fetch(`${ctx.base}/radar/feed.ics?token=${'x'.repeat(43)}`, { headers: { 'X-Forwarded-For': '10.77.0.2' } });
    assert.equal(elsewhere.status, 404);
});
