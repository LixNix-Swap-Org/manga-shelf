process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectInstallMode, detectSupervisor } = require('../../services/update/installMode');

const FILE = 0o100000;
const DIR = 0o040000;

function fakeFs(entries, { cgroup = '' } = {}) {
    const stat = (p) => {
        const e = entries[p];
        if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return {
            uid: e.uid,
            mode: e.mode,
            isSymbolicLink: () => Boolean(e.link),
            isFile: () => (e.mode & 0o170000) === FILE,
            isDirectory: () => (e.mode & 0o170000) === DIR
        };
    };
    return {
        lstatSync: stat,
        statSync: stat,
        existsSync: (p) => Boolean(entries[p]),
        accessSync: (p) => {
            if (!entries[p] || entries[p].writable === false) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
        readFileSync: (p) => {
            if (p === '/proc/self/cgroup' && cgroup) return cgroup;
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
    };
}

const userBinary = (over = {}) => ({
    '/home/anna/bin/manga-shelf-server': { mode: FILE | 0o755, uid: 1000, ...over.file },
    '/home/anna/bin': { mode: DIR | 0o755, uid: 1000, ...over.dir }
});

const seaDeps = (over = {}) => ({
    isSea: true,
    platform: 'linux',
    arch: 'x64',
    uid: 1000,
    env: {},
    versions: {},
    execPath: '/home/anna/bin/manga-shelf-server',
    fs: fakeFs(userBinary(over)),
    ...over.deps
});

test('a user-owned binary may replace itself; unsupervised it asks for a manual restart', () => {
    const r = detectInstallMode(seaDeps());
    assert.equal(r.mode, 'sea-user');
    assert.equal(r.canInstall, true);
    assert.equal(r.assetName, 'manga-shelf-server-linux-x64');
    assert.equal(r.restart, 'manual');
    assert.equal(r.supervisor, null);
});

test('sea-user is refused for links, foreign owners, shared write access and system paths', () => {
    const cases = [
        [{ file: { link: true } }, 'symlink'],
        [{ dir: { link: true } }, 'symlink'],
        [{ file: { uid: 0 } }, 'foreign_owner'],
        [{ dir: { uid: 0 } }, 'foreign_owner'],
        [{ file: { mode: FILE | 0o775 } }, 'shared_writable'],
        [{ dir: { mode: DIR | 0o777 } }, 'shared_writable'],
        [{ dir: { writable: false } }, 'not_writable']
    ];
    for (const [over, reason] of cases) {
        const r = detectInstallMode(seaDeps(over));
        assert.equal(r.mode, 'sea-system', JSON.stringify(over));
        assert.equal(r.canInstall, false);
        assert.equal(r.reason, reason, JSON.stringify(over));
    }
    const system = detectInstallMode({
        ...seaDeps(),
        execPath: '/usr/local/bin/manga-shelf-server',
        fs: fakeFs({ '/usr/local/bin/manga-shelf-server': { mode: FILE | 0o755, uid: 1000 }, '/usr/local/bin': { mode: DIR | 0o755, uid: 1000 } })
    });
    assert.equal(system.mode, 'sea-system');
    assert.equal(system.reason, 'system_path');
});

test('supervisor detection uses positive markers only', () => {
    const fsx = fakeFs({}, { cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/manga-shelf.service\n' });
    assert.equal(detectSupervisor({ env: { INVOCATION_ID: 'x' }, platform: 'linux', fsx }), 'systemd');
    assert.equal(detectSupervisor({ env: { INVOCATION_ID: 'x' }, platform: 'linux', fsx: fakeFs({}, { cgroup: '0::/user.slice/tmux.scope\n' }) }), null, 'INVOCATION_ID alone (tmux under systemd) is no supervisor');
    assert.equal(detectSupervisor({ env: { XPC_SERVICE_NAME: 'de.manga-shelf.server' }, platform: 'darwin', fsx }), 'launchd');
    assert.equal(detectSupervisor({ env: { XPC_SERVICE_NAME: 'com.apple.Terminal' }, platform: 'darwin', fsx }), null);
    assert.equal(detectSupervisor({ env: { MANGA_SHELF_SUPERVISOR: 'launchd' }, platform: 'darwin', fsx }), 'launchd');
    assert.equal(detectSupervisor({ env: { MANGA_SHELF_SUPERVISOR: 'pm2' }, platform: 'linux', fsx }), null);
    assert.equal(detectSupervisor({ env: { P_SERVER_UUID: 'u' }, platform: 'linux', fsx }), 'wings');
    assert.equal(detectSupervisor({ env: {}, platform: 'linux', fsx }), null, 'ppid === 1 is never used');
});

test('restart decision: supervised binaries exit 75, Windows and unsupervised ones need a manual start', () => {
    const systemd = detectInstallMode(seaDeps({ deps: { env: { MANGA_SHELF_SUPERVISOR: 'systemd' } } }));
    assert.equal(systemd.restart, 'supervised');
    const mac = detectInstallMode(seaDeps({ deps: { platform: 'darwin', arch: 'arm64', env: { XPC_SERVICE_NAME: 'de.manga-shelf.server' } } }));
    assert.equal(mac.restart, 'supervised');
    assert.equal(mac.assetName, 'manga-shelf-server-macos-universal');
    const acl = {
        SID: { ADMINISTRATORS: 'S-1-5-32-544', SYSTEM: 'S-1-5-18' },
        currentSid: () => 'S-1-5-21-1',
        readWindowsSecurity: () => ({ owner: 'S-1-5-21-1', reparse: false, aces: [] }),
        foreignAces: () => []
    };
    const win = detectInstallMode({
        ...seaDeps(),
        platform: 'win32',
        execPath: 'C:\\Users\\anna\\manga-shelf-server.exe',
        env: { ProgramFiles: 'C:\\Program Files', MANGA_SHELF_SUPERVISOR: 'systemd' },
        windowsAcl: acl,
        fs: fakeFs({ 'C:\\Users\\anna\\manga-shelf-server.exe': { mode: FILE | 0o666, uid: 0 }, 'C:\\Users\\anna': { mode: DIR | 0o777, uid: 0 } })
    });
    assert.equal(win.mode, 'sea-user');
    assert.equal(win.restart, 'manual');
    assert.equal(win.assetName, 'manga-shelf-server-windows-x64.exe');
    const programFiles = detectInstallMode({ ...seaDeps(), platform: 'win32', execPath: 'C:\\Program Files\\Manga Shelf Server\\manga-shelf-server.exe', env: { ProgramFiles: 'C:\\Program Files' }, windowsAcl: acl });
    assert.equal(programFiles.mode, 'sea-system');
    const foreign = detectInstallMode({ ...seaDeps(), platform: 'win32', execPath: 'C:\\Users\\anna\\manga-shelf-server.exe', env: {}, windowsAcl: { ...acl, foreignAces: () => [{ sid: 'S-1-1-0' }] }, fs: fakeFs({ 'C:\\Users\\anna\\manga-shelf-server.exe': { mode: FILE | 0o666, uid: 0 }, 'C:\\Users\\anna': { mode: DIR | 0o777, uid: 0 } }) });
    assert.equal(foreign.reason, 'shared_writable');
});

test('a Windows binary whose entry handed in no ACL helpers is never installable', () => {
    const r = detectInstallMode({
        ...seaDeps(),
        platform: 'win32',
        execPath: 'C:\\Users\\anna\\manga-shelf-server.exe',
        env: {},
        fs: fakeFs({ 'C:\\Users\\anna\\manga-shelf-server.exe': { mode: FILE | 0o666, uid: 0 }, 'C:\\Users\\anna': { mode: DIR | 0o777, uid: 0 } })
    });
    assert.equal(r.mode, 'sea-system');
    assert.equal(r.canInstall, false);
    assert.equal(r.reason, 'acl_unavailable');
});

test('services/update never loads the binary-only scripts/server-bin modules', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'services', 'update');
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
        assert.doesNotMatch(fs.readFileSync(path.join(dir, name), 'utf8'), /require\([^)]*server-bin/, name);
    }
});

test('fixed order: desktop, binary, Pterodactyl, Docker, source', () => {
    const tree = { '/home/container/index.js': { mode: FILE | 0o644, uid: 1 }, '/home/container/package.json': { mode: FILE | 0o644, uid: 1 }, '/home/container': { mode: DIR | 0o755, uid: 1 }, '/.dockerenv': { mode: FILE, uid: 0 } };
    const base = { isSea: false, platform: 'linux', arch: 'x64', uid: 1, versions: {}, codeDir: '/home/container', fs: fakeFs(tree) };

    assert.equal(detectInstallMode({ ...base, versions: { electron: '44.0.0' }, env: { P_SERVER_UUID: 'u' } }).mode, 'desktop');
    const ptero = detectInstallMode({ ...base, env: { P_SERVER_UUID: 'u' } });
    assert.equal(ptero.mode, 'pterodactyl', '/.dockerenv inside a Pterodactyl container does not make it Docker');
    assert.equal(ptero.canInstall, true);
    assert.equal(ptero.restart, 'pterodactyl');
    assert.equal(ptero.supervisor, 'wings');
    assert.equal(ptero.assetName, 'pterodactyl-manga-shelf.zip');

    const readOnly = detectInstallMode({ ...base, env: { P_SERVER_UUID: 'u' }, fs: fakeFs({ ...tree, '/home/container': { mode: DIR | 0o755, uid: 1, writable: false } }) });
    assert.equal(readOnly.mode, 'pterodactyl');
    assert.equal(readOnly.canInstall, false);
    assert.equal(readOnly.reason, 'code_not_writable');

    const seaInPtero = detectInstallMode({ ...seaDeps(), env: { P_SERVER_UUID: 'u' } });
    assert.equal(seaInPtero.mode, 'sea-user', 'a binary under a generic egg is a binary, never a ZIP install');

    assert.equal(detectInstallMode({ ...base, env: {} }).mode, 'docker');
    const appData = detectInstallMode({ ...base, env: { DATA_DIR: '/app/data' }, fs: fakeFs({ '/app': { mode: DIR | 0o755, uid: 0, writable: false } }) });
    assert.equal(appData.mode, 'docker');
    const source = detectInstallMode({ ...base, env: {}, fs: fakeFs({}) });
    assert.equal(source.mode, 'source');
    assert.equal(source.canInstall, false);
});
