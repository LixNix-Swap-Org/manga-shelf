// Covers the app protocol, LAN address helpers and the static address/port pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveAppFile, registerAppProtocol, APP_START_URL, APP_ORIGIN, APP_SCHEME_PRIVILEGES } = require('../lib/appProtocol');
const { lanAddresses, serverAddress, connectLink } = require('../lib/lan');
const { addressPage, portPage, escapeHtml, dataUrl } = require('../lib/pages');
const { resolvePaths, resolveDataDir } = require('../lib/paths');

function appBuild(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-app-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(root, 'assets', 'index-abc.js'), 'x');
    fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg/>');
    return root;
}

test('app:// serves files, SPA routes and relative assets of deeper routes from the app build', (t) => {
    const root = appBuild(t);
    const index = path.join(root, 'index.html');
    assert.equal(resolveAppFile(root, '/'), index);
    assert.equal(resolveAppFile(root, '/server'), index);
    assert.equal(resolveAppFile(root, '/manga/12'), index);
    assert.equal(resolveAppFile(root, '/favicon.svg'), path.join(root, 'favicon.svg'));
    assert.equal(resolveAppFile(root, '/assets/index-abc.js'), path.join(root, 'assets', 'index-abc.js'));
    // base './': /manga/12 loads ./assets/x.js as /manga/assets/x.js
    assert.equal(resolveAppFile(root, '/manga/assets/index-abc.js'), path.join(root, 'assets', 'index-abc.js'));
    assert.equal(resolveAppFile(root, '/assets/missing.js'), null);
});

test('app:// never leaves the build folder', (t) => {
    const root = appBuild(t);
    fs.writeFileSync(path.join(path.dirname(root), 'secret.txt'), 'x');
    t.after(() => fs.rmSync(path.join(path.dirname(root), 'secret.txt'), { force: true }));
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt']) {
        const file = resolveAppFile(root, p);
        assert.ok(file === null || file.startsWith(root + path.sep), `${p} -> ${file}`);
    }
    assert.equal(resolveAppFile(root, '/%E0%A4%A'), null);
    assert.equal(resolveAppFile(root, '/a%00b'), null);
});

test('registerAppProtocol answers only app://manga-shelf and fetches the resolved file', async (t) => {
    const root = appBuild(t);
    let handler;
    const fetched = [];
    registerAppProtocol({ protocol: { handle: (scheme, fn) => { assert.equal(scheme, 'app'); handler = fn; } }, net: { fetch: async (url) => { fetched.push(url); return new Response('ok'); } } }, root);
    assert.equal((await handler(new Request('app://other/'))).status, 404);
    assert.equal((await handler(new Request('app://manga-shelf/assets/none.js'))).status, 404);
    await handler(new Request('app://manga-shelf/manga/3'));
    assert.match(fetched[0], /^file:\/\/.*index\.html$/);
    assert.equal(APP_START_URL, 'app://manga-shelf/');
    assert.equal(APP_ORIGIN, 'app://manga-shelf');
    assert.equal(APP_SCHEME_PRIVILEGES.standard, true);
    assert.equal(APP_SCHEME_PRIVILEGES.secure, true);
});

test('lanAddresses: IPv4 only, no loopback, home network before virtual adapters', () => {
    const interfaces = {
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
        utun3: [{ address: '100.101.1.2', family: 'IPv4', internal: false }],
        en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.10', family: 'IPv4', internal: false }],
        en5: [{ address: '169.254.3.3', family: 4, internal: false }]
    };
    assert.deepEqual(lanAddresses(interfaces), ['192.168.1.10', '169.254.3.3', '172.17.0.1', '100.101.1.2']);
    assert.deepEqual(lanAddresses(null), []);
});

test('serverAddress and connectLink', () => {
    const interfaces = { en0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }] };
    assert.equal(serverAddress('0.0.0.0', 3000, interfaces), 'http://10.0.0.5:3000');
    assert.equal(serverAddress('192.168.2.2', 8080, interfaces), 'http://192.168.2.2:8080');
    assert.equal(serverAddress('127.0.0.1', 3000, interfaces), null);
    assert.equal(serverAddress('0.0.0.0', 3000, {}), null);
    const link = connectLink({ url: 'http://10.0.0.5:3000', name: 'Manga Shelf', instanceId: 'abc' });
    assert.equal(link, 'manga-shelf://connect?url=http%3A%2F%2F10.0.0.5%3A3000&name=Manga+Shelf&id=abc');
});

test('connectLink matches the frontend parser (deepLink.js)', async () => {
    const { parseConnectLink, buildConnectLink } = await import('../../frontend/src/app/deepLink.js');
    const input = { url: 'http://192.168.1.10:3000', name: 'Zuhause & Büro', instanceId: 'id-1' };
    assert.equal(connectLink(input), buildConnectLink(input));
    assert.deepEqual(parseConnectLink(connectLink(input)), input);
});

test('address page shows the address, a QR code and escapes everything', () => {
    const html = addressPage({ address: 'http://192.168.1.10:3000', link: 'manga-shelf://connect?url=x&name=<b>', qr: { size: 29, path: 'M4,4h1v1h-1z' }, others: ['http://10.0.0.2:3000'] });
    assert.match(html, /Adresse für andere Geräte/);
    assert.match(html, /http:\/\/192\.168\.1\.10:3000/);
    assert.match(html, /<svg class="qr" viewBox="0 0 29 29"/);
    assert.match(html, /aria-label="QR-Code für die Manga-Shelf-App"/);
    assert.ok(!html.includes('name=<b>'));
    assert.match(html, /name=&lt;b&gt;/);
    assert.match(html, /10\.0\.0\.2/);
    assert.match(html, /<html lang="de">/);
    assert.equal(escapeHtml(`<"'&>`), '&lt;&quot;&#39;&amp;&gt;');
    assert.ok(dataUrl(html).startsWith('data:text/html;charset=utf-8,'));
});

test('port page validates 1-65535 before it submits', () => {
    const html = portPage({ port: 3000, hint: 'Hinweis <x>' });
    assert.match(html, /value="3000"/);
    assert.match(html, /Hinweis &lt;x&gt;/);
    assert.match(html, /Bitte eine Zahl von 1 bis 65535 eingeben/);
    assert.match(html, /desktopDialog\.submit\(n\)/);
});

test('resolvePaths: resources in the package, the repository in development', () => {
    const packaged = resolvePaths({ isPackaged: true, resourcesPath: '/r', desktopDir: '/r/app.asar', env: {} });
    assert.equal(packaged.serverDir, path.join('/r', 'server'));
    assert.equal(packaged.appFrontendDir, path.join('/r', 'app-frontend'));
    assert.equal(packaged.qrModule, path.join('/r', 'qr.mjs'));
    const desktopDir = path.resolve(__dirname, '..');
    const dev = resolvePaths({ isPackaged: false, resourcesPath: '/x', desktopDir, env: {} });
    assert.ok(fs.existsSync(path.join(dev.serverDir, 'index.js')));
    assert.ok(fs.existsSync(dev.qrModule));
    assert.ok(fs.existsSync(dev.trayIcon));
    assert.ok(fs.existsSync(dev.windowIcon));
    assert.equal(resolvePaths({ isPackaged: false, desktopDir, env: { MANGA_SHELF_APP_DIST: '/tmp/app' } }).appFrontendDir, path.resolve('/tmp/app'));
    assert.equal(resolveDataDir(null, '/u'), path.join('/u', 'data'));
    assert.equal(resolveDataDir('rel', '/u'), path.resolve('rel'));
});

test('originOf: app:// has its own origin, file:/data:/javascript: never match an allowed one', () => {
    const { originOf } = require('../lib/appProtocol');
    assert.equal(originOf('app://manga-shelf/server?x=1'), 'app://manga-shelf');
    assert.equal(originOf('http://127.0.0.1:37210/manga/1'), 'http://127.0.0.1:37210');
    assert.equal(originOf('https://anilist.co/a'), 'https://anilist.co');
    for (const url of ['file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)', 'about:blank', '', 'kein url']) {
        assert.equal(originOf(url), null, url);
    }
});

test('QR code of the connect link from the frontend encoder, also as the staged .mjs copy', async (t) => {
    const { qrSvgData } = require('../lib/qrCode');
    const source = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'app', 'qr.js');
    const link = connectLink({ url: 'http://192.168.1.10:3000', name: 'Manga Shelf', instanceId: 'abc' });
    const qr = await qrSvgData(link, source);
    assert.ok(qr.size >= 29 && qr.size <= 105);
    assert.match(qr.path, /^M\d+,\d+h1v1h-1z/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-qr-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.copyFileSync(source, path.join(dir, 'qr.mjs'));
    assert.deepEqual(await qrSvgData(link, path.join(dir, 'qr.mjs')), qr);
});
