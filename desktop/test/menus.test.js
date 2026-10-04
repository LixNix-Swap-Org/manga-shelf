// Covers the application menu, tray template and tooltip, and the login-autostart helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMenuTemplate, findItem } = require('../menu');
const { buildTrayTemplate, trayTooltip } = require('../tray');
const { linuxAutostartEntry, linuxAutostartFile, setAutostart, startedAtLogin } = require('../lib/autostart');

function recorder() {
    const calls = [];
    const actions = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
    return { calls, actions };
}

const base = { platform: 'linux', mode: 'local', view: 'local', serverRunning: true, network: false, serverView: 'local', tray: true, autostart: false, setupPending: false };

test('menu: "Quellen & Schlüssel…" opens the keys tab in local and client mode', () => {
    for (const state of [base, { ...base, mode: 'client', view: 'remote', serverRunning: false }]) {
        const { calls, actions } = recorder();
        const item = findItem(buildMenuTemplate(state, actions), 'api-keys');
        assert.equal(item.label, 'Quellen && Schlüssel…', 'Electron shows && as one &');
        assert.equal(item.enabled, true);
        item.click();
        assert.deepEqual(calls, [['openApiKeys']]);
    }
    assert.equal(findItem(buildMenuTemplate({ ...base, mode: 'server', view: null }, {}), 'api-keys').enabled, false);
});

test('menu: the three modes are radio items, choosing another one switches', () => {
    const { calls, actions } = recorder();
    const template = buildMenuTemplate(base, actions);
    const labels = ['mode-local', 'mode-client', 'mode-server'].map((id) => findItem(template, id));
    assert.deepEqual(labels.map((i) => i.label), ['Nur auf diesem Gerät', 'Mit Server verbinden', 'Dieses Gerät ist Server']);
    assert.deepEqual(labels.map((i) => i.checked), [true, false, false]);
    labels[0].click();
    labels[2].click();
    assert.deepEqual(calls, [['setMode', 'server']]);
});

test('menu: server items only in server mode, address only while the server is reachable from the network', () => {
    const local = buildMenuTemplate(base, {});
    assert.equal(findItem(local, 'port').enabled, false);
    assert.equal(findItem(local, 'address').enabled, false);
    assert.equal(findItem(local, 'tray').enabled, false);
    const { calls, actions } = recorder();
    const server = buildMenuTemplate({ ...base, mode: 'server', network: true, serverView: 'remote' }, actions);
    assert.equal(findItem(server, 'address').enabled, true);
    assert.equal(findItem(server, 'port').enabled, true);
    assert.equal(findItem(server, 'server-view-remote').checked, true);
    findItem(server, 'server-view-remote').click({ checked: false });
    findItem(server, 'tray').click({ checked: false });
    findItem(server, 'autostart').click({ checked: true });
    findItem(server, 'address').click();
    assert.deepEqual(calls, [['setServerView', 'local'], ['setTray', false], ['setAutostart', true], ['showAddress']]);
});

test('menu: backup and data folder need a running server; setup code only while setup is pending', () => {
    const client = buildMenuTemplate({ ...base, mode: 'client', view: 'remote', serverRunning: false }, {});
    assert.equal(findItem(client, 'backup-now').enabled, false);
    assert.equal(findItem(client, 'open-data-dir').enabled, false);
    assert.equal(findItem(client, 'setup-code'), null);
    assert.equal(findItem(buildMenuTemplate({ ...base, setupPending: true }, {}), 'setup-code').label, 'Einrichtungscode anzeigen…');
});

test('menu: macOS gets the app menu with quit, the others a quit item under Datei', () => {
    const mac = buildMenuTemplate({ ...base, platform: 'darwin' }, {});
    assert.equal(mac[0].label, 'Manga Shelf');
    assert.equal(findItem([mac[1]], 'quit'), null);
    assert.ok(findItem([mac[0]], 'quit'));
    const win = buildMenuTemplate({ ...base, platform: 'win32' }, {});
    assert.equal(win[0].label, 'Datei');
    assert.ok(findItem([win[0]], 'quit'));
    assert.ok(win.some((m) => m.label === 'Bearbeiten'));
});

test('tray: Öffnen / Adresse kopieren / Backup jetzt / Beenden', () => {
    const { calls, actions } = recorder();
    const template = buildTrayTemplate({ serverRunning: true, port: 3000, address: 'http://192.168.1.10:3000', view: 'local' }, actions);
    const labels = template.filter((i) => i.label).map((i) => i.label);
    assert.deepEqual(labels, ['Server läuft (Port 3000)', 'Öffnen', 'Adresse kopieren', 'Backup jetzt', 'Beenden']);
    for (const id of ['open', 'copy-address', 'backup-now', 'quit']) template.find((i) => i.id === id).click();
    assert.deepEqual(calls.map((c) => c[0]), ['openWindow', 'copyAddress', 'backupNow', 'quit']);
    const off = buildTrayTemplate({ serverRunning: false, address: null, view: null }, actions);
    assert.equal(off.find((i) => i.id === 'open').enabled, false);
    assert.equal(off.find((i) => i.id === 'copy-address').enabled, false);
    assert.equal(off.find((i) => i.id === 'backup-now').enabled, false);
    assert.equal(trayTooltip({ address: 'http://x:1' }), 'Manga Shelf – http://x:1');
});

test('autostart: XDG entry on Linux, login item elsewhere', (t) => {
    assert.match(linuxAutostartEntry('/opt/Manga Shelf/manga-shelf'), /^Exec="\/opt\/Manga Shelf\/manga-shelf" --hidden$/m);
    assert.match(linuxAutostartEntry('/usr/bin/manga-shelf'), /^Exec=\/usr\/bin\/manga-shelf --hidden$/m);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-xdg-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = { XDG_CONFIG_HOME: home, APPIMAGE: '/home/u/Manga.AppImage' };
    const file = linuxAutostartFile(env);
    setAutostart(null, true, { platform: 'linux', env });
    assert.match(fs.readFileSync(file, 'utf8'), /Exec=\/home\/u\/Manga\.AppImage --hidden/);
    setAutostart(null, false, { platform: 'linux', env });
    assert.equal(fs.existsSync(file), false);

    const settings = [];
    const app = { setLoginItemSettings: (s) => settings.push(s), getLoginItemSettings: () => ({ wasOpenedAtLogin: true }) };
    setAutostart(app, true, { platform: 'win32' });
    setAutostart(app, false, { platform: 'darwin' });
    assert.deepEqual(settings, [{ openAtLogin: true, args: ['--hidden'] }, { openAtLogin: false, args: [] }]);
    assert.equal(startedAtLogin(app, ['--hidden'], 'win32'), true);
    assert.equal(startedAtLogin(app, [], 'win32'), false);
    assert.equal(startedAtLogin(app, [], 'darwin'), true);
});
