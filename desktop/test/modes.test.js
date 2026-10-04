// Covers launch-mode argument parsing, run resolution, settings normalisation and server/window URL helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const modes = require('../modes');

const { parseArgs, resolveRun, normalizeSettings, withMode, sameServer, windowHost, serverOrigin, localWindowUrl, DEFAULT_LOCAL_PORT, DEFAULT_SERVER_PORT } = modes;

test('parseArgs reads the spec flags in both spellings and ignores Chromium switches', () => {
    const args = parseArgs(['--server-only', '--port', '8080', '--host=0.0.0.0', '--data-dir', '/tmp/x', '--inspect=9229', '-psn_0_123', '--user-data-dir=/tmp/u']);
    assert.equal(args.serverOnly, true);
    assert.equal(args.port, 8080);
    assert.equal(args.host, '0.0.0.0');
    assert.equal(args.dataDir, '/tmp/x');
    assert.equal(args.userDataDir, '/tmp/u');
    assert.deepEqual(args.errors, []);
    assert.equal(parseArgs(['--connect', 'https://manga.example.org']).connect, 'https://manga.example.org');
    assert.equal(parseArgs(['--hidden']).hidden, true);
});

test('parseArgs reports bad values in German and keeps going', () => {
    const args = parseArgs(['--port', '70000', '--connect', 'ftp://x', '--data-dir', '--port=abc']);
    assert.equal(args.port, null);
    assert.equal(args.connect, null);
    assert.equal(args.dataDir, null);
    assert.equal(args.errors.length, 4);
    assert.match(args.errors[0], /ungültiger Port/);
    assert.match(args.errors[1], /--connect/);
    assert.match(args.errors[2], /braucht einen Wert/);
});

test('parseArgs takes a manga-shelf:// link the OS passes (Windows/Linux)', () => {
    const link = 'manga-shelf://connect?url=http%3A%2F%2F192.168.1.10%3A3000&name=Zuhause';
    assert.equal(parseArgs(['--', link]).deepLink, link);
    assert.equal(parseArgs(['--connect', link]).connect, link);
});

test('normalizeSettings drops unknown modes, bad ports and wrong types', () => {
    const s = normalizeSettings({ mode: 'weird', localPort: 0, serverPort: 99999, serverHost: '  ', tray: 'yes', autostart: true, serverView: 'x' });
    assert.equal(s.mode, null);
    assert.equal(s.localPort, DEFAULT_LOCAL_PORT);
    assert.equal(s.serverPort, DEFAULT_SERVER_PORT);
    assert.equal(s.serverHost, '0.0.0.0');
    assert.equal(s.tray, true);
    assert.equal(s.autostart, true);
    assert.equal(s.serverView, 'local');
    assert.deepEqual(normalizeSettings(null), normalizeSettings({}));
    assert.deepEqual(normalizeSettings([1]), normalizeSettings({}));
});

test('resolveRun: first start without flags asks for the mode', () => {
    const run = resolveRun({}, parseArgs([]));
    assert.equal(run.needsChoice, true);
    assert.equal(run.server, null);
});

test('resolveRun: local mode serves on loopback, the window shows it', () => {
    const run = resolveRun({ mode: 'local' }, parseArgs([]));
    assert.deepEqual(run.server, { host: '127.0.0.1', port: DEFAULT_LOCAL_PORT });
    assert.equal(run.view, 'local');
    assert.equal(run.network, false);
    assert.equal(run.tray, false);
});

test('resolveRun: client mode has no server and shows the bundled app', () => {
    const run = resolveRun({ mode: 'client' }, parseArgs([]));
    assert.equal(run.server, null);
    assert.equal(run.view, 'remote');
    assert.equal(run.tray, false);
});

test('resolveRun: server mode binds all interfaces on 3000 with tray; the window may show another server', () => {
    const run = resolveRun({ mode: 'server' }, parseArgs([]));
    assert.deepEqual(run.server, { host: '0.0.0.0', port: 3000 });
    assert.equal(run.network, true);
    assert.equal(run.view, 'local');
    assert.equal(run.tray, true);
    const both = resolveRun({ mode: 'server', serverView: 'remote', tray: false }, parseArgs([]));
    assert.equal(both.view, 'remote');
    assert.ok(both.server);
    assert.equal(both.tray, false);
});

test('resolveRun: flags win over the settings for this run', () => {
    const serverOnly = resolveRun({ mode: 'client' }, parseArgs(['--server-only', '--port', '4000']));
    assert.equal(serverOnly.mode, 'server');
    assert.equal(serverOnly.view, null);
    assert.equal(serverOnly.tray, true);
    assert.deepEqual(serverOnly.server, { host: '0.0.0.0', port: 4000 });

    const connect = resolveRun({}, parseArgs(['--connect', 'https://home.example']));
    assert.equal(connect.needsChoice, false);
    assert.equal(connect.mode, 'client');
    assert.equal(connect.connect, 'https://home.example');

    const shared = resolveRun({ mode: 'local' }, parseArgs(['--host', '0.0.0.0']));
    assert.equal(shared.network, true);
    assert.equal(shared.server.host, '0.0.0.0');
});

test('withMode keeps the other settings and refuses unknown modes', () => {
    const next = withMode({ mode: 'local', serverPort: 8080, autostart: true }, 'server');
    assert.equal(next.mode, 'server');
    assert.equal(next.serverPort, 8080);
    assert.equal(next.autostart, true);
    assert.throws(() => withMode({}, 'cloud'), /Unbekannte Betriebsart/);
});

test('sameServer, windowHost and the window URL', () => {
    assert.equal(sameServer({ host: '0.0.0.0', port: 3000 }, { host: '0.0.0.0', port: 3000 }), true);
    assert.equal(sameServer({ host: '127.0.0.1', port: 3000 }, { host: '0.0.0.0', port: 3000 }), false);
    assert.equal(sameServer(null, { host: '0.0.0.0', port: 3000 }), false);
    assert.equal(windowHost('0.0.0.0'), '127.0.0.1');
    assert.equal(windowHost('::'), '127.0.0.1');
    assert.equal(windowHost('localhost'), '127.0.0.1');
    assert.equal(windowHost('192.168.1.10'), '192.168.1.10');
    assert.equal(serverOrigin(3000, 'fd00::1'), 'http://[fd00::1]:3000');
    assert.equal(localWindowUrl(37210, '127.0.0.1'), 'http://127.0.0.1:37210/');
});
