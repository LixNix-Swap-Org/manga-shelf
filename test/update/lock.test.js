process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const lock = require('../../services/update/lock');
const { errorAnswer } = require('../../core/errors');

test.beforeEach(() => lock.reset());

const code = (expected) => (err) => {
    assert.equal(err.code, expected);
    return true;
};

test('phases: one download at a time, apply only from ready, nothing while applying or restarting', () => {
    assert.equal(lock.isBusy(), false);
    lock.begin('preparing');
    assert.throws(() => lock.begin('preparing'), code('UPDATE_BUSY'));
    assert.throws(() => lock.begin('applying'), code('UPDATE_BUSY'));
    assert.equal(lock.isUpdateRunning(), false, 'a download does not block backups');
    lock.setPhase('ready');
    lock.begin('preparing');
    lock.setPhase('ready');
    lock.begin('applying');
    assert.equal(lock.isUpdateRunning(), true);
    assert.throws(() => lock.begin('preparing'), code('UPDATE_RUNNING'));
    lock.setPhase('restarting');
    assert.equal(lock.isUpdateRunning(), true);
    lock.release();
    assert.equal(lock.isBusy(), false);
});

test('restore, snapshots and deletes refuse with 409 UPDATE_RUNNING while an update is applied', () => {
    lock.assertNoUpdate();
    lock.setPhase('ready');
    lock.begin('applying');
    assert.throws(() => lock.assertNoUpdate(), (err) => {
        const { status, body } = errorAnswer(err);
        assert.equal(status, 409);
        assert.equal(body.code, 'UPDATE_RUNNING');
        return true;
    });
});

function call(guard, method, url) {
    let error = null;
    let passed = false;
    const headers = {};
    guard({ method, originalUrl: url }, { set: (k, v) => { headers[k] = v; } }, (err) => {
        if (err) error = err;
        else passed = true;
    });
    return { error, passed, headers };
}

test('maintenance: every non-GET /api request except the update endpoints gets 503 MAINTENANCE', () => {
    const guard = lock.maintenanceGuard();
    assert.equal(call(guard, 'POST', '/api/mangas').passed, true, 'off by default');
    lock.setMaintenance(true);
    const refused = call(guard, 'POST', '/api/mangas');
    assert.equal(refused.passed, false);
    const { status, body } = errorAnswer(refused.error);
    assert.equal(status, 503);
    assert.equal(body.code, 'MAINTENANCE');
    assert.equal(refused.headers['Retry-After'], '60');
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(call(guard, method, '/api/volumes/1').passed, false, method);
    assert.equal(call(guard, 'GET', '/api/mangas').passed, true);
    assert.equal(call(guard, 'HEAD', '/api/health').passed, true);
    assert.equal(call(guard, 'GET', '/api/system/update/status').passed, true);
    assert.equal(call(guard, 'DELETE', '/api/system/update/staging/abc').passed, true);
    assert.equal(call(guard, 'POST', '/api/system/updates-other').passed, false);
    lock.release();
    assert.equal(lock.isMaintenance(), false);
    assert.equal(call(guard, 'POST', '/api/mangas').passed, true);
});
