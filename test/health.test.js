const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startTestServer } = require('./helpers');

let ctx;
let lifecycle;

test.before(async () => {
    ctx = await startTestServer();
    lifecycle = require('../services/lifecycle');
});

test.after(async () => { await ctx.close(); });

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 3, 12);
const okDb = { prepare: () => ({ get: () => ({ 1: 1 }) }) };

function report(overrides = {}) {
    lifecycle.resetHealthCache();
    return lifecycle.healthReport({
        db: okDb,
        dataDir: ctx.dataDir,
        freeBytes: () => 10 * 1024 * MB,
        lastVerifiedSnapshot: () => ({ filename: 'x.zip', size: 100 * MB, time: NOW - HOUR }),
        isRestoreRunning: () => false,
        now: NOW,
        uptimeMs: 1000,
        ...overrides
    });
}

test('GET /api/health: public, no cache, status plus checks without paths or counts', async () => {
    const res = await fetch(ctx.base + '/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.ok(['ok', 'degraded'].includes(body.status), body.status);
    assert.deepEqual(Object.keys(body.checks).sort(), ['backup', 'db', 'disk', 'restoring', 'writable']);
    assert.equal(body.checks.db, 'ok');
    assert.equal(body.checks.writable, 'ok');
    assert.equal(body.checks.restoring, false);
    assert.equal(body.checks.backup, 'pending', 'a fresh server has no backup yet and is not degraded for it');
    assert.ok(!JSON.stringify(body).includes(ctx.dataDir));
    assert.equal(typeof body.version, 'string');
});

test('GET /api/health names the server and a stable instance id for the apps', async () => {
    const first = await (await fetch(ctx.base + '/health')).json();
    assert.equal(first.name, 'Manga Shelf');
    assert.match(first.instance_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const { db, initDb } = require('../db');
    const stored = () => db.prepare("SELECT value FROM app_settings WHERE key = 'instance_id'").get()?.value;
    assert.equal(stored(), first.instance_id);

    initDb();
    assert.equal((await (await fetch(ctx.base + '/health')).json()).instance_id, first.instance_id, 'survives a reopen');

    // a restored database without an id keeps the live one; a restored id travels with its data
    db.prepare("DELETE FROM app_settings WHERE key = 'instance_id'").run();
    initDb();
    assert.equal(stored(), first.instance_id);
    db.prepare("UPDATE app_settings SET value = 'from-backup' WHERE key = 'instance_id'").run();
    initDb();
    assert.equal((await (await fetch(ctx.base + '/health')).json()).instance_id, 'from-backup');
});

test('health: ok, then degraded for little space or an old backup, error for database or disk', () => {
    assert.deepEqual(report(), { status: 'ok', checks: { db: 'ok', writable: 'ok', disk: 'ok', backup: 'ok', restoring: false } });

    assert.equal(report({ freeBytes: () => 400 * MB }).checks.disk, 'low');
    assert.equal(report({ freeBytes: () => 400 * MB }).status, 'degraded');
    // twice the last snapshot counts when it is larger than 500 MB
    assert.equal(report({ freeBytes: () => 900 * MB, lastVerifiedSnapshot: () => ({ size: 600 * MB, time: NOW }) }).checks.disk, 'low');
    assert.equal(report({ freeBytes: () => null }).checks.disk, 'unknown');
    assert.equal(report({ freeBytes: () => null }).status, 'ok');

    assert.equal(report({ lastVerifiedSnapshot: () => ({ size: MB, time: NOW - 49 * HOUR }) }).checks.backup, 'stale');
    assert.equal(report({ lastVerifiedSnapshot: () => ({ size: MB, time: NOW - 49 * HOUR }) }).status, 'degraded');
    assert.equal(report({ lastVerifiedSnapshot: () => null, uptimeMs: 49 * HOUR }).checks.backup, 'missing');
    assert.equal(report({ lastVerifiedSnapshot: () => null, uptimeMs: 49 * HOUR }).status, 'degraded');
    assert.equal(report({ lastVerifiedSnapshot: () => { throw new Error('unreadable'); } }).checks.backup, 'pending');

    const broken = report({ db: { prepare: () => { throw new Error('closed'); } } });
    assert.deepEqual([broken.status, broken.checks.db], ['error', 'error']);
    const missing = report({ dataDir: path.join(os.tmpdir(), 'manga-shelf-does-not-exist-' + process.pid) });
    assert.deepEqual([missing.status, missing.checks.writable], ['error', 'error']);
    assert.equal(report({ isRestoreRunning: () => true }).checks.restoring, true);
});

test('health: a read-only data directory is an error (HTTP 503)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-ro-'));
    fs.chmodSync(dir, 0o555);
    try {
        assert.equal(report({ dataDir: dir }).checks.writable, 'error');
    } finally {
        fs.chmodSync(dir, 0o755);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('health: the backup lookup is cached for a minute', () => {
    lifecycle.resetHealthCache();
    let calls = 0;
    const deps = {
        db: okDb, dataDir: ctx.dataDir, freeBytes: () => null, isRestoreRunning: () => false, uptimeMs: 0,
        lastVerifiedSnapshot: () => { calls++; return null; }
    };
    lifecycle.healthReport({ ...deps, now: NOW });
    lifecycle.healthReport({ ...deps, now: NOW + 30 * 1000 });
    assert.equal(calls, 1);
    lifecycle.healthReport({ ...deps, now: NOW + 61 * 1000 });
    assert.equal(calls, 2);
});
