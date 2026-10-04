const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../utils/logger');

function capture(options) {
    const lines = [];
    const log = createLogger({ ...options, write: (level, line) => lines.push({ level, line }) });
    return { log, lines };
}

test('logger: levels below the threshold are dropped', () => {
    const { log, lines } = capture({ level: 'warn' });
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    assert.deepEqual(lines.map(l => l.level), ['warn', 'error']);
});

test('logger: silent level drops everything', () => {
    const { log, lines } = capture({ level: 'silent' });
    log.error('nope');
    assert.equal(lines.length, 0);
});

test('logger: text format has timestamp, level, component and context', () => {
    const { log, lines } = capture({ format: 'text' });
    log.child('backup').info('Restored snapshot', { file: 'a.zip', mangas: 3 });
    assert.match(lines[0].line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO {2}\[backup\] Restored snapshot file=a\.zip mangas=3$/);
});

test('logger: errors include the stack at error level, only the message at info/warn', () => {
    const { log, lines } = capture({ format: 'text', level: 'info' });
    const err = new Error('boom');
    log.warn('Checkpoint failed', err);
    log.error('Restore failed', err);
    assert.match(lines[0].line, /Checkpoint failed: boom$/);
    assert.doesNotMatch(lines[0].line, /\n/);
    assert.match(lines[1].line, /Restore failed: boom\n.*Error: boom/s);
});

test('logger: json format emits one parseable object per line', () => {
    const { log, lines } = capture({ format: 'json' });
    log.child('http').child('slow').warn('Slow request', { path: '/api/x', ms: 2500 }, new Error('late'));
    const entry = JSON.parse(lines[0].line);
    assert.equal(entry.level, 'warn');
    assert.equal(entry.component, 'http:slow');
    assert.equal(entry.msg, 'Slow request');
    assert.equal(entry.path, '/api/x');
    assert.equal(entry.ms, 2500);
    assert.equal(entry.err.message, 'late');
    assert.ok(!Number.isNaN(Date.parse(entry.time)));
});

test('logger: console-style trailing arguments are appended to the message', () => {
    const { log, lines } = capture({ format: 'text' });
    log.info('Applied migration', 4, 'ok');
    assert.match(lines[0].line, /Applied migration 4 ok$/);
});

test('logger: circular and BigInt context never throw, in both formats', () => {
    for (const format of ['text', 'json']) {
        const { log, lines } = capture({ format });
        const circular = { name: 'a' };
        circular.self = circular;
        assert.doesNotThrow(() => log.error('x', circular));
        assert.doesNotThrow(() => log.info('y', { n: 10n }));
        assert.equal(lines.length, 2, format);
        assert.match(lines[0].line, /\[Circular\]/);
        assert.match(lines[1].line, /10/);
        if (format === 'json') {
            assert.equal(JSON.parse(lines[0].line).self.self, '[Circular]');
            assert.equal(JSON.parse(lines[1].line).n, '10');
        }
    }
});

test('logger: a shared but non-circular object is written in full', () => {
    const { log, lines } = capture({ format: 'json' });
    const shared = { id: 1 };
    log.info('shared', { a: shared, b: shared });
    const entry = JSON.parse(lines[0].line);
    assert.deepEqual(entry.a, { id: 1 });
    assert.deepEqual(entry.b, { id: 1 });
});

test('logger: err.cause (also nested in AggregateError) reaches text and json output', () => {
    const fetchError = () => new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' })
    });
    const text = capture({ format: 'text' });
    text.log.warn('Manga Passion nicht erreichbar:', fetchError());
    assert.match(text.lines[0].line, /nicht erreichbar: fetch failed \(cause: ENOTFOUND getaddrinfo ENOTFOUND example\.invalid\)$/);
    text.log.error('Fehler:', fetchError());
    assert.match(text.lines[1].line, /Caused by: Error: getaddrinfo ENOTFOUND/);

    const json = capture({ format: 'json' });
    json.log.warn('x', fetchError());
    assert.equal(JSON.parse(json.lines[0].line).err.cause.code, 'ENOTFOUND');

    const refused = Object.assign(new AggregateError([
        Object.assign(new Error('connect ECONNREFUSED ::1:80'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), { code: 'ECONNREFUSED' })
    ], ''), { code: 'ECONNREFUSED' });
    json.log.warn('y', new TypeError('fetch failed', { cause: refused }));
    const entry = JSON.parse(json.lines[1].line);
    assert.equal(entry.err.cause.errors.length, 2);
    assert.equal(entry.err.cause.errors[0].code, 'ECONNREFUSED');
    text.log.warn('z', new TypeError('fetch failed', { cause: refused }));
    assert.match(text.lines[2].line, /cause: ECONNREFUSED \[ECONNREFUSED, ECONNREFUSED\]/);

    const loop = new Error('a');
    loop.cause = loop;
    assert.doesNotThrow(() => json.log.warn('loop', loop));
    assert.doesNotThrow(() => text.log.warn('loop', loop));
    text.log.warn('plain cause', new Error('outer', { cause: 'just a string' }));
    assert.match(text.lines.at(-1).line, /outer \(cause: just a string\)$/);
});

test('logger: context keys cannot overwrite level, msg or time', () => {
    const { log, lines } = capture({ format: 'json' });
    log.info('real', { msg: 'fake', level: 'error', time: 'never' });
    const entry = JSON.parse(lines[0].line);
    assert.equal(entry.level, 'info');
    assert.equal(entry.msg, 'real');
    assert.notEqual(entry.time, 'never');
});

test('logger: a message ending in a colon does not print "::" before the error', () => {
    const { log, lines } = capture({ format: 'text' });
    log.error('Failed migration v2 (x):', new Error('no such column'));
    log.info('Status:', 'ok');
    assert.match(lines[0].line, /Failed migration v2 \(x\): no such column\n/);
    assert.doesNotMatch(lines[0].line, /::/);
    assert.match(lines[1].line, /Status: ok$/);
});

test('logger: a throwing getter or sink never makes the log call throw', () => {
    const { log, lines } = capture({ format: 'text' });
    const evil = { get boom() { throw new Error('getter'); } };
    assert.doesNotThrow(() => log.error('evil', evil));
    assert.match(lines[0].line, /^evil \[log entry could not be written: getter\]$/);
    const broken = createLogger({ write: () => { throw new Error('sink down'); } });
    assert.doesNotThrow(() => broken.error('x'));
});

test('logger: an unhandled rejection with a circular reason does not become an uncaught exception', () => {
    const { spawnSync } = require('node:child_process');
    const script = `
        const log = require(${JSON.stringify(require.resolve('../utils/logger'))});
        process.on('unhandledRejection', (reason) => log.error('[Process] Unhandled promise rejection:', reason));
        process.on('uncaughtException', () => { process.stdout.write('UNCAUGHT'); process.exit(3); });
        const reason = { n: 1n }; reason.self = reason;
        Promise.reject(reason);
    `;
    for (const format of ['text', 'json']) {
        const res = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, LOG_FORMAT: format }, encoding: 'utf8' });
        assert.equal(res.status, 0, res.stdout + res.stderr);
        assert.doesNotMatch(res.stdout, /UNCAUGHT/);
        assert.match(res.stderr, /Unhandled promise rejection/);
    }
});

test('logger: the root logger takes LOG_LEVEL and LOG_FORMAT from utils/config.js (trimmed, any case)', () => {
    const { spawnSync } = require('node:child_process');
    const script = `
        const log = require(${JSON.stringify(require.resolve('../utils/logger'))});
        log.info('info-line'); log.warn('warn-line');
    `;
    const res = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, LOG_LEVEL: ' Warn ', LOG_FORMAT: 'JSON' }, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout + res.stderr, /info-line/);
    assert.equal(JSON.parse(res.stderr.trim()).msg, 'warn-line');
});
