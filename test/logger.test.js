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
