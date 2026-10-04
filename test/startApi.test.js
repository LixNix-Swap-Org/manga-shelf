const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// start()/stop() as the desktop app uses them: DATA_DIR is set before index.js is loaded, nothing listens on import
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-start-'));
Object.assign(process.env, { DATA_DIR: dataDir, MANGA_SHELF_NO_LISTEN: '1', LOG_LEVEL: process.env.LOG_LEVEL || 'silent', SETUP_TOKEN: 'start-setup-token' });
delete process.env.FRONTEND_DIR;

const app = require('../index.js');
const lifecycle = require('../services/lifecycle');

test.after(() => {
    require('../db').closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('index.js exports the app plus createApp, start and stop', () => {
    assert.equal(typeof app, 'function');
    assert.equal(typeof app.listen, 'function');
    for (const fn of ['createApp', 'start', 'stop']) assert.equal(typeof app[fn], 'function', fn);
    const second = app.createApp();
    assert.notEqual(second, app);
    assert.equal(typeof second.handle, 'function');
});

test('start({ port: 0 }) serves /api/health, stop() ends it and a new start works', async () => {
    for (let round = 0; round < 2; round++) {
        const started = await app.start({ host: '127.0.0.1', port: 0, console: false });
        assert.ok(started.port > 0);
        assert.equal(started.url, `http://127.0.0.1:${started.port}`);
        const res = await fetch(started.url + '/api/health');
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('x-request-id'));
        await app.stop();
        assert.equal(started.server.listening, false);
        await assert.rejects(fetch(started.url + '/api/health'));
    }
    await app.stop();
});

test('start refuses a second start and another data directory', async () => {
    await assert.rejects(app.start({ port: 0, host: '127.0.0.1', dataDir: path.join(dataDir, 'other') }), /DATA_DIR/);
    const started = await app.start({ host: '127.0.0.1', port: 0, console: false, dataDir });
    try {
        await assert.rejects(app.start({ host: '127.0.0.1', port: 0, console: false }), /läuft bereits/);
    } finally {
        await app.stop();
    }
    assert.equal(started.server.listening, false);
});

test('a port in use rejects start() instead of exiting the process', async () => {
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    try {
        await assert.rejects(app.start({ host: '127.0.0.1', port: blocker.address().port, console: false }), { code: 'EADDRINUSE' });
    } finally {
        blocker.close();
    }
    const started = await app.start({ host: '127.0.0.1', port: 0, console: false });
    await app.stop();
    assert.equal(started.server.listening, false);
});

test('stop() waits for a running job and cuts a stalled connection', async () => {
    const started = await app.start({ host: '127.0.0.1', port: 0, console: false });
    // a client that never finishes its request keeps a connection open
    const socket = net.connect(started.port, '127.0.0.1');
    await new Promise(resolve => socket.on('connect', resolve));
    socket.write('GET /api/health HTTP/1.1\r\nHost: x\r\n');
    socket.on('error', () => {});
    let jobDone = false;
    lifecycle.trackJob('test-job', new Promise(resolve => setTimeout(() => { jobDone = true; resolve(); }, 300)));
    assert.deepEqual(lifecycle.runningJobs(), ['test-job']);
    const t0 = Date.now();
    await app.stop();
    assert.ok(jobDone, 'the job finished before the database was closed');
    assert.ok(Date.now() - t0 < 3000, `stop took ${Date.now() - t0} ms`);
    assert.equal(started.server.listening, false);
    socket.destroy();
});

test('shutdown: idempotent, gives up on a job after the deadline and still closes everything', async () => {
    lifecycle.resetLifecycle();
    const calls = [];
    const parts = {
        stopScheduler: () => calls.push('scheduler'),
        closeConsole: () => { calls.push('console'); throw new Error('already closed'); },
        closeDb: () => calls.push('db')
    };
    lifecycle.trackJob('endless', new Promise(() => {}));
    const first = lifecycle.shutdown(parts, { jobDeadlineMs: 50 });
    assert.equal(lifecycle.shutdown(parts), first);
    assert.equal(lifecycle.isShuttingDown(), true);
    await first;
    assert.deepEqual(calls, ['scheduler', 'console', 'db']);
    lifecycle.resetLifecycle();
    assert.equal(lifecycle.isShuttingDown(), false);
});

test('trackJob returns the promise and forgets finished or failed jobs', async () => {
    lifecycle.resetLifecycle();
    const ok = lifecycle.trackJob('a', Promise.resolve(1));
    const failed = lifecycle.trackJob('b', Promise.reject(new Error('x')));
    assert.equal(await ok, 1);
    await assert.rejects(failed);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(lifecycle.runningJobs(), []);
    assert.deepEqual(await lifecycle.waitForJobs(10), []);
});
