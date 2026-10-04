// Headless server binary: command line, service definitions, the embedded web portal and
// the esbuild bundle that becomes the SEA. The bundle test needs esbuild (frontend/node_modules); CI installs it.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseArgs, defaultDataDir, defaultCacheDir, UsageError } = require('../scripts/server-bin/cli');
const services = require('../scripts/server-bin/services');
const { webSource, prepareAppDir, portalDir, PORTAL_MARKER } = require('../scripts/server-bin/webAssets');
const { createRotatingLog, teeStreams } = require('../scripts/server-bin/logFile');
const acl = require('../scripts/server-bin/acl');
const buildSea = require('../scripts/server-bin/build-sea');

const root = path.join(__dirname, '..');
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Windows security descriptors as acl.readWindowsSecurity returns them
const ADMINS = 'S-1-5-32-544';
const userSid = 'S-1-5-21-1-2-3-1001';
const ace = (sid, extra = {}) => ({ sid, rights: 0x1f01ff, allow: true, inheritOnly: false, ...extra });
const sec = (aces, extra = {}) => ({ owner: ADMINS, reparse: false, aces, ...extra });
const privateAcl = sec([ace(ADMINS), ace('S-1-5-18'), ace('S-1-5-19')]);

describe('command line', () => {
    test('no arguments starts the server with defaults', () => {
        assert.deepEqual(parseArgs([]), {
            command: 'start', args: [],
            options: { port: null, host: null, dataDir: null, user: false, noConsole: false, logFile: false, account: null }
        });
    });

    test('flags with separate or inline values', () => {
        const { command, options } = parseArgs(['--port', '4000', '--host=127.0.0.1', '--data-dir', 'daten', '--no-console', '--log-file']);
        assert.equal(command, 'start');
        assert.equal(options.port, 4000);
        assert.equal(options.host, '127.0.0.1');
        assert.equal(options.dataDir, path.resolve('daten'));
        assert.equal(options.noConsole, true);
        assert.equal(options.logFile, true);
    });

    test('a console command keeps its own arguments; --data-dir counts anywhere', () => {
        assert.deepEqual(parseArgs(['passwort-reset', 'Kim', '--data-dir', '/srv/ms']), {
            command: 'console', args: ['passwort-reset', 'Kim'],
            options: { port: null, host: null, dataDir: path.resolve('/srv/ms'), user: false, noConsole: false, logFile: false, account: null }
        });
        assert.deepEqual(parseArgs(['quellen', 'setzen', 'mal', '--instanz']).args, ['quellen', 'setzen', 'mal', '--instanz']);
        assert.deepEqual(parseArgs(['rollback-aufraeumen', '--yes']).args, ['rollback-aufraeumen', '--yes']);
    });

    test('service commands, help and version', () => {
        const install = parseArgs(['install-service', '--user', '--port', '3100']);
        assert.equal(install.command, 'install-service');
        assert.equal(install.options.user, true);
        assert.equal(install.options.port, 3100);
        assert.equal(parseArgs(['uninstall-service']).command, 'uninstall-service');
        assert.equal(parseArgs(['--help']).command, 'help');
        assert.equal(parseArgs(['-v']).command, 'version');
        assert.equal(parseArgs(['start', '--port', '1']).command, 'start');
    });

    test('mistakes are usage errors with German texts', () => {
        assert.throws(() => parseArgs(['--bogus']), (e) => e instanceof UsageError && /Unbekannte Option --bogus/.test(e.message));
        assert.throws(() => parseArgs(['--port', '70000']), /Ungültiger Port/);
        assert.throws(() => parseArgs(['--port']), /braucht einen Wert/);
        assert.throws(() => parseArgs(['--user']), /nur für install-service/);
        assert.throws(() => parseArgs(['--log-file=ja']), /hat keinen Wert/);
        assert.throws(() => parseArgs(['--account', 'x']), /nur für install-service/);
        assert.equal(parseArgs(['install-service', '--account', 'NetworkService']).options.account, 'NetworkService');
    });

    test('default data and cache folders per platform never nest', () => {
        const env = { HOME: '/home/kim' };
        assert.equal(defaultDataDir('linux', env), '/home/kim/.local/share/manga-shelf');
        assert.equal(defaultCacheDir('linux', env), '/home/kim/.cache/manga-shelf');
        assert.equal(defaultCacheDir('linux', { ...env, CACHE_DIRECTORY: '/var/cache/manga-shelf' }), '/var/cache/manga-shelf');
        assert.equal(defaultDataDir('darwin', { HOME: '/Users/kim' }), '/Users/kim/Library/Application Support/manga-shelf');
        assert.equal(defaultCacheDir('darwin', { HOME: '/Users/kim' }), '/Users/kim/Library/Caches/manga-shelf');
        const win = { LOCALAPPDATA: 'C:\\Users\\kim\\AppData\\Local', CACHE_DIRECTORY: 'C:\\x' };
        assert.equal(defaultDataDir('win32', win), 'C:\\Users\\kim\\AppData\\Local\\manga-shelf\\data');
        assert.equal(defaultCacheDir('win32', win), 'C:\\Users\\kim\\AppData\\Local\\manga-shelf\\cache');
        assert.equal(defaultCacheDir('linux', { ...env, MANGA_SHELF_CACHE_DIR: '/opt/cache' }), '/opt/cache');
    });
});

describe('install-service / uninstall-service', () => {
    const PACKAGED = services.PACKAGED_BINARY;
    const kinds = (steps) => steps.map(s => s.kind === 'run' ? `run ${s.cmd} ${s.args.join(' ')}` : s.kind);

    test('the packaged systemd unit is the generated one', () => {
        const generated = services.systemdUnit({
            binary: services.PACKAGED_BINARY,
            args: services.serverArgs({ dataDir: services.SYSTEM_DATA_DIR }),
            system: true
        });
        assert.equal(fs.readFileSync(path.join(root, 'scripts/server-bin/packaging/manga-shelf.service'), 'utf8'), generated);
        assert.match(generated, /^User=manga-shelf$/m);
        assert.match(generated, /^ExecStart=\/usr\/bin\/manga-shelf-server --no-console --data-dir \/var\/lib\/manga-shelf$/m);
        assert.match(generated, /^CacheDirectory=manga-shelf$/m);
        assert.match(generated, /^UMask=0027$/m, 'new files are not readable by other users');
        assert.match(generated, /^WantedBy=multi-user\.target$/m);
        assert.doesNotMatch(generated, /MemoryDenyWriteExecute/, 'V8 needs executable memory');
    });

    test('ExecStart quotes paths with spaces', () => {
        const unit = services.systemdUnit({ binary: '/opt/m s/bin', args: services.serverArgs({ dataDir: '/srv/manga daten', port: 3001 }), system: false });
        assert.match(unit, /^ExecStart="\/opt\/m s\/bin" --no-console --port 3001 --data-dir "\/srv\/manga daten"$/m);
        assert.doesNotMatch(unit, /^User=/m);
        assert.match(unit, /^WantedBy=default\.target$/m);
    });

    test('Linux system service: needs root, creates the user, installs the binary and enables the unit', () => {
        const ctx = { platform: 'linux', options: parseArgs(['install-service', '--port', '3005']).options, execPath: '/home/kim/manga-shelf-server-linux-x64', env: {}, home: '/root' };
        assert.throws(() => services.installPlan({ ...ctx, uid: 1000 }), /braucht root/);
        const steps = services.installPlan({ ...ctx, uid: 0 });
        assert.deepEqual(kinds(steps).filter(k => k !== 'note'), [
            'ensureUser', 'mkdir', 'run systemctl stop manga-shelf', 'install', 'write',
            'run systemctl daemon-reload', 'run systemctl enable manga-shelf', 'run systemctl restart manga-shelf'
        ]);
        assert.equal(steps.find(s => s.kind === 'install').to, '/usr/local/bin/manga-shelf-server');
        const unit = steps.find(s => s.kind === 'write');
        assert.equal(unit.file, '/etc/systemd/system/manga-shelf.service');
        assert.match(unit.content, /ExecStart=\/usr\/local\/bin\/manga-shelf-server --no-console --port 3005 --data-dir \/var\/lib\/manga-shelf/);
        assert.equal(steps.find(s => s.kind === 'mkdir').owner, 'manga-shelf');
        assert.equal(steps.find(s => s.kind === 'mkdir').mode, 0o750);
        assert.throws(() => services.installPlan({ ...ctx, uid: 0, options: { ...ctx.options, account: 'x' } }), /nur unter Windows/);
    });

    test('Linux system service with a data folder below /home: ProtectHome=tmpfs and only that folder bound in', () => {
        const dataDir = '/home/u/manga daten:1';
        const steps = services.installPlan({ platform: 'linux', options: parseArgs(['install-service', '--data-dir', dataDir]).options, execPath: PACKAGED, uid: 0 });
        const unit = steps.find(s => s.kind === 'write').content;
        assert.match(unit, /^ProtectHome=tmpfs$/m);
        assert.doesNotMatch(unit, /^ProtectHome=true$/m);
        assert.match(unit, /^BindPaths="\/home\/u\/manga daten:1"$/m, 'quoted, so ":" is no source:destination split');
        assert.match(unit, /^ReadWritePaths="\/home\/u\/manga daten:1"$/m);
        assert.ok(steps.some(s => s.kind === 'note' && /ProtectHome=tmpfs/.test(s.text) && /--user/.test(s.text)));
        for (const dir of ['/root/manga', '/run/user/1000/manga', '/home']) {
            assert.match(services.systemdUnit({ binary: PACKAGED, args: services.serverArgs({ dataDir: dir }), system: true }), /^ProtectHome=tmpfs$/m, dir);
        }
        for (const dir of ['/var/lib/manga-shelf', '/srv/home/manga', '/homeserver/manga']) {
            const other = services.systemdUnit({ binary: PACKAGED, args: services.serverArgs({ dataDir: dir }), system: true });
            assert.match(other, /^ProtectHome=true$/m, dir);
            assert.doesNotMatch(other, /^BindPaths=/m, dir);
            assert.match(other, new RegExp(`^ReadWritePaths=${dir}$`, 'm'));
        }
        assert.ok(!services.installPlan({ platform: 'linux', options: { user: false }, execPath: PACKAGED, uid: 0 }).some(s => s.kind === 'note' && /ProtectHome/.test(s.text)));
    });

    test('Linux from the .deb binary keeps it in place; --user writes a user unit', () => {
        const packaged = services.installPlan({ platform: 'linux', options: { user: false }, execPath: '/usr/bin/manga-shelf-server', uid: 0 });
        assert.ok(!packaged.some(s => s.kind === 'install'));
        const user = services.installPlan({ platform: 'linux', options: { user: true, dataDir: null }, execPath: '/home/kim/bin/ms', uid: 1000, env: {}, home: '/home/kim' });
        const unit = user.find(s => s.kind === 'write');
        assert.equal(unit.file, '/home/kim/.config/systemd/user/manga-shelf.service');
        assert.match(unit.content, /--data-dir \/home\/kim\/\.local\/share\/manga-shelf/);
        assert.ok(kinds(user).includes('run systemctl --user enable --now manga-shelf'));
        assert.equal(user.find(s => s.kind === 'mkdir').mode, 0o700);
        assert.match(unit.content, /^UMask=0027$/m);
        assert.throws(() => services.installPlan({ platform: 'linux', options: { user: true }, execPath: '/x', uid: 0 }), /nicht als root/);
    });

    test('macOS: a LaunchAgent with KeepAlive and a rotating log file', () => {
        const steps = services.installPlan({ platform: 'darwin', options: { port: null }, execPath: '/Users/kim/manga-shelf-server-macos-universal', uid: 501, env: {}, home: '/Users/kim' });
        const plist = steps.find(s => s.kind === 'write');
        assert.equal(plist.file, '/Users/kim/Library/LaunchAgents/de.manga-shelf.server.plist');
        assert.match(plist.content, /<key>KeepAlive<\/key>\s*<true\/>/);
        assert.match(plist.content, /<string>--log-file<\/string>/);
        assert.match(plist.content, /<string>\/Users\/kim\/Library\/Application Support\/manga-shelf<\/string>/);
        assert.ok(kinds(steps).includes('run launchctl bootstrap gui/501 /Users/kim/Library/LaunchAgents/de.manga-shelf.server.plist'));
        assert.ok(steps.find(s => s.cmd === 'xattr').allowFail);
    });

    const winEnv = { ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files', TEMP: 'C:\\Temp', SystemRoot: 'C:\\WINDOWS', COMPUTERNAME: 'HAUS-PC' };
    const resolved = [];
    const resolveSid = (name) => { resolved.push(name); return userSid; };
    const winPlan = (options = {}) => services.installPlan({ platform: 'win32', options: { port: 3000, ...options }, execPath: 'C:\\Users\\kim\\Downloads\\manga-shelf-server-windows-x64.exe', env: winEnv, resolveSid });
    const tool = (name) => acl.systemTool(name, winEnv);
    const decoded = (step) => Buffer.from(step.args.at(-1), 'base64').toString('utf16le');

    test('Windows: a LOCAL SERVICE task at boot without time limit, written as UTF-16', () => {
        const steps = winPlan();
        const task = steps.find(s => s.kind === 'write');
        assert.equal(task.encoding, 'utf16le');
        assert.match(task.content, /<UserId>S-1-5-19<\/UserId>/);
        assert.doesNotMatch(task.content, /S-1-5-18|HighestAvailable|S4U/);
        assert.match(task.content, /<RunLevel>LeastPrivilege<\/RunLevel>/);
        assert.match(task.content, /<BootTrigger>/);
        assert.match(task.content, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
        assert.match(task.content, /<Command>C:\\Program Files\\Manga Shelf Server\\manga-shelf-server\.exe<\/Command>/);
        assert.match(task.content, /<Arguments>--no-console --log-file --port 3000 --data-dir C:\\ProgramData\\manga-shelf\\data<\/Arguments>/);
        assert.ok(kinds(steps).includes(`run ${tool('schtasks.exe')} /Create /TN Manga Shelf Server /XML C:\\Temp\\manga-shelf-task.xml /F`));
        assert.equal(steps.find(s => s.kind === 'install').to, 'C:\\Program Files\\Manga Shelf Server\\manga-shelf-server.exe');
        assert.ok(steps.some(s => s.kind === 'note' && /als LOCAL SERVICE/.test(s.text)));
    });

    test('Windows tools are spawned from System32 by absolute path', () => {
        assert.equal(acl.systemTool('icacls.exe', { SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\icacls.exe');
        assert.equal(acl.systemTool('powershell.exe', { SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        assert.equal(acl.systemTool('whoami.exe', {}), 'C:\\Windows\\System32\\whoami.exe');
        const cmds = [...winPlan(), ...services.uninstallPlan({ platform: 'win32', options: {}, env: winEnv })].filter(s => s.kind === 'run').map(s => s.cmd);
        assert.ok(cmds.length >= 6);
        for (const cmd of cmds) assert.match(cmd, /^C:\\WINDOWS\\System32\\(icacls|schtasks)\.exe$|^C:\\WINDOWS\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    });

    test('Windows: a fresh protected DACL before the task is stopped; owner and DACL steps are fatal', () => {
        const steps = winPlan();
        const order = kinds(steps).filter(k => k !== 'note').map(k => k.replace(/-EncodedCommand \S+/, '-EncodedCommand …'));
        assert.deepEqual(order, [
            'windowsRoot',
            `run ${tool('icacls.exe')} C:\\ProgramData\\manga-shelf /setowner *S-1-5-32-544 /T /Q`,
            `run ${tool('powershell.exe')} -NoProfile -NonInteractive -EncodedCommand …`,
            'checkAcl',
            `run ${tool('schtasks.exe')} /End /TN Manga Shelf Server`,
            'install', 'write',
            `run ${tool('schtasks.exe')} /Create /TN Manga Shelf Server /XML C:\\Temp\\manga-shelf-task.xml /F`, 'remove',
            `run ${tool('schtasks.exe')} /Run /TN Manga Shelf Server`
        ]);
        assert.deepEqual(steps.filter(s => s.allowFail).map(s => s.args[0]), ['/End'], 'only ending the old task may fail');
        assert.ok(!steps.some(s => s.kind === 'run' && s.args.includes('/C')), 'icacls never skips errors');
        assert.deepEqual(steps.find(s => s.kind === 'windowsRoot'), { kind: 'windowsRoot', root: 'C:\\ProgramData\\manga-shelf', dataDir: 'C:\\ProgramData\\manga-shelf\\data' });
        const protect = steps.find(s => s.kind === 'run' && /powershell/.test(s.cmd));
        assert.deepEqual(protect.env, { MANGA_SHELF_ROOT: 'C:\\ProgramData\\manga-shelf', MANGA_SHELF_SID: 'S-1-5-19' });
        const script = decoded(protect);
        assert.match(script, /New-Object System\.Security\.AccessControl\.DirectorySecurity/);
        assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
        assert.match(script, /'S-1-5-32-544', 'S-1-5-18', \$env:MANGA_SHELF_SID/);
        assert.match(script, /RemoveAccessRuleSpecific/, 'explicit entries below the root are dropped');
        assert.match(script, /-band 1024\) -ne 0\) \{ throw/, 'reparse points stop it');
        assert.match(script, /exit 1/);
        assert.deepEqual(steps.find(s => s.kind === 'checkAcl'), {
            kind: 'checkAcl', sid: 'S-1-5-19',
            paths: ['data', 'data\\logs', 'data\\logs\\manga-shelf.log', 'data\\secret.key', 'data\\.env'].map(p => `C:\\ProgramData\\manga-shelf\\${p}`)
        });
        const own = services.installPlan({ platform: 'win32', options: { dataDir: 'D:\\Manga' }, execPath: 'C:\\Program Files\\Manga Shelf Server\\manga-shelf-server.exe', env: winEnv });
        assert.ok(!own.some(s => s.kind === 'install'));
        assert.equal(own.find(s => s.kind === 'windowsRoot').root, 'D:\\Manga');
        assert.equal(own.find(s => /icacls/.test(s.cmd || '')).args[0], 'D:\\Manga');
    });

    test('Windows --account: Unicode names, SIDs and .\\name; other accounts resolve to their SID before any step', () => {
        assert.deepEqual(services.windowsAccount(null), { sid: 'S-1-5-19', label: 'LOCAL SERVICE', grant: '*S-1-5-19', s4u: false });
        assert.equal(services.windowsAccount('NT AUTHORITY\\Network Service').sid, 'S-1-5-20');
        assert.equal(services.windowsAccount('s-1-5-20').s4u, false);
        assert.deepEqual(services.windowsAccount('s-1-5-21-1-2-3-1001'), { sid: userSid, user: userSid, label: userSid, grant: `*${userSid}`, s4u: true });
        for (const name of ['DOMÄNE\\name', 'PC\\Müller', 'Jürgen', 'kim@haus.lan']) assert.equal(services.windowsAccount(name).user, name);
        assert.equal(services.windowsAccount('.\\Jürgen', { env: winEnv }).user, 'HAUS-PC\\Jürgen');
        assert.throws(() => services.windowsAccount('.\\Jürgen', { env: {} }), /COMPUTERNAME/);
        for (const bad of ['a"b', 'x:(F)', '..', 'a\\b\\c', 'x /grant *S-1-1-0:F', 'PC\\..', '.\\']) assert.throws(() => services.windowsAccount(bad, { env: winEnv }), /Ungültiges Konto/, bad);

        const system = winPlan({ account: 'LocalSystem' });
        assert.match(system.find(s => s.kind === 'write').content, /<UserId>S-1-5-18<\/UserId>/);
        assert.ok(system.some(s => s.kind === 'note' && /alle Rechte/.test(s.text)));

        resolved.length = 0;
        const user = winPlan({ account: '.\\manga' });
        assert.deepEqual(resolved, ['HAUS-PC\\manga']);
        assert.match(user.find(s => s.kind === 'write').content, /<UserId>HAUS-PC\\manga<\/UserId>\s*<LogonType>S4U<\/LogonType>/);
        assert.equal(user.find(s => s.kind === 'checkAcl').sid, userSid);
        assert.equal(user.find(s => /powershell/.test(s.cmd || '')).env.MANGA_SHELF_SID, userSid);

        const bySid = winPlan({ account: userSid });
        assert.match(bySid.find(s => s.kind === 'write').content, /<UserId>S-1-5-21-1-2-3-1001<\/UserId>\s*<LogonType>S4U<\/LogonType>/);
        assert.equal(bySid.find(s => s.kind === 'checkAcl').sid, userSid);

        resolved.length = 0;
        assert.throws(() => services.installPlan({ platform: 'win32', options: { account: 'HAUS\\gibtsnicht' }, execPath: 'C:\\x.exe', env: winEnv, resolveSid: () => { throw new Error('Einige oder alle Identitätsverweise konnten nicht übersetzt werden.'); } }),
            (err) => err instanceof UsageError && /HAUS\\gibtsnicht.*nicht gefunden.*nichts geändert/.test(err.message));
    });

    test('resolveAccountSid asks PowerShell (System32) for the SID and refuses anything else', () => {
        const calls = [];
        const capture = (cmd, args, { env }) => { calls.push({ cmd, account: env.MANGA_SHELF_ACCOUNT, script: Buffer.from(args.at(-1), 'base64').toString('utf16le') }); return 's-1-5-21-7-8-9-1002\r\n'; };
        assert.equal(acl.resolveAccountSid('HAUS\\kim', { capture, env: { SystemRoot: 'C:\\Windows' } }), 'S-1-5-21-7-8-9-1002');
        assert.equal(calls[0].cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        assert.equal(calls[0].account, 'HAUS\\kim');
        assert.match(calls[0].script, /NTAccount\(\$a\)\)\.Translate\(\[System\.Security\.Principal\.SecurityIdentifier\]\)/);
        assert.throws(() => acl.resolveAccountSid('x', { capture: () => 'HAUS\\kim', env: {} }), /keine SID/);
    });

    test('uninstall keeps the data on every platform', () => {
        assert.throws(() => services.uninstallPlan({ platform: 'linux', options: { user: false }, uid: 1000 }), /root/);
        for (const ctx of [
            { platform: 'linux', options: { user: false }, uid: 0 },
            { platform: 'linux', options: { user: true }, uid: 1000, home: '/home/kim' },
            { platform: 'darwin', options: {}, uid: 501, home: '/Users/kim' },
            { platform: 'win32', options: {} }
        ]) {
            const steps = services.uninstallPlan(ctx);
            assert.ok(!steps.some(s => s.kind === 'remove' && /manga-shelf$|data/.test(s.file) && !/bin/.test(s.file)), ctx.platform);
            assert.ok(steps.some(s => s.kind === 'note' && /bleiben erhalten/.test(s.text)), ctx.platform);
        }
    });

    test('runPlan writes, installs and removes files; allowFail swallows a failing command', () => {
        const dir = tmpDir('ms-plan-');
        try {
            const calls = [];
            const exec = (cmd, args) => {
                calls.push(`${cmd} ${args.join(' ')}`);
                if (cmd === 'false' || (cmd === 'id')) throw new Error('exit 1');
            };
            fs.writeFileSync(path.join(dir, 'bin'), 'binary');
            services.runPlan([
                { kind: 'write', file: path.join(dir, 'a', 'unit'), content: 'x' },
                { kind: 'write', file: path.join(dir, 'task.xml'), content: 'ä', encoding: 'utf16le' },
                { kind: 'install', from: path.join(dir, 'bin'), to: path.join(dir, 'usr', 'manga-shelf-server') },
                { kind: 'ensureUser', name: 'manga-shelf', home: '/var/lib/manga-shelf' },
                { kind: 'run', cmd: 'false', args: [], allowFail: true },
                { kind: 'remove', file: path.join(dir, 'a', 'unit') },
                { kind: 'note', text: 'fertig' }
            ], { exec, out: (t) => calls.push(`note ${t}`) });
            assert.ok(!fs.existsSync(path.join(dir, 'a', 'unit')));
            assert.deepEqual([...fs.readFileSync(path.join(dir, 'task.xml'))], [0xff, 0xfe, 0xe4, 0x00]);
            assert.equal(fs.readFileSync(path.join(dir, 'usr', 'manga-shelf-server'), 'utf8'), 'binary');
            if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'usr', 'manga-shelf-server')).mode & 0o777, 0o755);
            assert.deepEqual(calls, [
                'id -u manga-shelf',
                'useradd --system --user-group --home-dir /var/lib/manga-shelf --no-create-home --shell /usr/sbin/nologin manga-shelf',
                'false ',
                'note fertig'
            ]);
            assert.throws(() => services.runPlan([{ kind: 'run', cmd: 'false', args: [] }], { exec }), /fehlgeschlagen/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });


    test('runPlan sets the folder mode; checkAcl is an allow-list over the data folder, logs, secret.key and .env', () => {
        const dir = tmpDir('ms-plan-mode-');
        try {
            const data = path.join(dir, 'daten');
            services.runPlan([{ kind: 'mkdir', dir: data, mode: 0o750 }], { exec: () => {} });
            if (process.platform !== 'win32') assert.equal(fs.statSync(data).mode & 0o777, 0o750);
            const paths = [data, path.join(data, 'logs'), path.join(data, 'secret.key'), path.join(data, '.env')];
            const check = (byPath) => () => services.runPlan([{ kind: 'checkAcl', paths, sid: 'S-1-5-19' }], { readSecurity: (p) => byPath(p) });
            assert.doesNotThrow(check(() => privateAcl), 'missing logs/secret.key/.env are skipped');
            assert.doesNotThrow(check(() => sec([...privateAcl.aces, ace('S-1-3-0', { inheritOnly: true }), ace('S-1-1-0', { allow: false })])), 'CREATOR OWNER inherit-only and other deny entries are fine');
            assert.throws(check(() => sec([...privateAcl.aces, ace(userSid)])), new RegExp(`${userSid}.*abgebrochen`), 'pre-created folder with a foreign ACE');
            assert.throws(check(() => sec([...privateAcl.aces, ace('S-1-5-32-545', { rights: 0x1200a9 })])), /S-1-5-32-545.*abgebrochen/);
            assert.throws(check(() => sec([...privateAcl.aces, ace('S-1-3-0')])), /S-1-3-0/, 'CREATOR OWNER on the object itself');
            assert.throws(check(() => sec([...privateAcl.aces, ace('S-1-5-19', { allow: false, rights: 0x2 })])), /S-1-5-19 wird ausgesperrt/, 'deny for the account');
            assert.throws(check(() => sec([ace(ADMINS)])), /Dienstkonto S-1-5-19 hat keinen Zugriff/);
            assert.throws(check(() => sec(privateAcl.aces, { owner: userSid })), new RegExp(`gehört ${userSid}`));
            assert.throws(check(() => sec(privateAcl.aces, { reparse: true })), /Verknüpfung/);
            assert.throws(() => services.runPlan([{ kind: 'checkAcl', paths, sid: 'S-1-5-19' }], { readSecurity: () => { throw new Error('keine SID in der ACL-Ausgabe ("Jeder")'); } }), /Jeder/, 'an unreadable ACL fails');

            fs.writeFileSync(paths[3], 'X=1');
            assert.throws(check((p) => (p === paths[3] ? sec([...privateAcl.aces, ace(userSid, { rights: 0x6 })]) : privateAcl)), /\.env: ist noch für andere Konten zugänglich/);
            fs.rmSync(paths[3]);
            if (process.platform !== 'win32') {
                fs.symlinkSync(dir, paths[1]);
                assert.throws(check(() => privateAcl), /logs: ist eine Verknüpfung/);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('windowsRoot: a pre-created root of another owner or any link stops the setup; missing folders are created', () => {
        const dir = tmpDir('ms-root-');
        try {
            const root = path.join(dir, 'manga-shelf');
            const data = path.join(root, 'data');
            const seen = [];
            const step = { kind: 'windowsRoot', root, dataDir: data };
            const run = (readSecurity) => services.runPlan([step], { readSecurity: (p) => { seen.push(p); return readSecurity(p); } });
            run(() => privateAcl);
            assert.ok(fs.statSync(data).isDirectory());
            assert.deepEqual(seen, [root, data], 'new folders are checked after creating them');
            seen.length = 0;
            run(() => sec([], { owner: 'S-1-5-18' }));
            assert.deepEqual(seen, [root, data]);
            assert.throws(() => run((p) => (p === root ? sec([ace(userSid)], { owner: userSid }) : privateAcl)), new RegExp(`gehört nicht den Administratoren \\(Besitzer ${userSid}\\).*setowner`));
            assert.throws(() => run((p) => (p === data ? sec([], { reparse: true }) : privateAcl)), /data ist eine Verknüpfung \(Reparse-Punkt\)/);
            if (process.platform !== 'win32') {
                const elsewhere = path.join(dir, 'fremd');
                fs.mkdirSync(elsewhere);
                const linked = path.join(dir, 'link-root');
                fs.symlinkSync(elsewhere, linked);
                assert.throws(() => services.runPlan([{ kind: 'windowsRoot', root: linked, dataDir: path.join(linked, 'data') }], { readSecurity: () => privateAcl }), /link-root ist eine Verknüpfung \(Junction\/Symlink\)/);
                assert.ok(!fs.existsSync(path.join(elsewhere, 'data')), 'nothing is created behind a link');
            }
            const fileRoot = path.join(dir, 'datei');
            fs.writeFileSync(fileRoot, 'x');
            assert.throws(() => services.runPlan([{ kind: 'windowsRoot', root: fileRoot, dataDir: fileRoot }], { readSecurity: () => privateAcl }), /ist kein Ordner/);
            assert.deepEqual(services.folderChain(root, data), [root, data]);
            assert.deepEqual(services.folderChain(data, data), [data]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a failing setowner or DACL step stops the Windows install before the old task is ended or the binary copied', () => {
        const dir = tmpDir('ms-win-run-');
        try {
            const data = path.join(dir, 'Manga');
            const steps = services.installPlan({ platform: 'win32', options: { dataDir: data }, execPath: 'C:\\Users\\kim\\Downloads\\ms.exe', env: winEnv, resolveSid });
            const runWith = (failing) => {
                const calls = [];
                const exec = (cmd, args, opts) => {
                    calls.push({ cmd: path.win32.basename(cmd), first: args[0], env: opts?.env });
                    if (failing(cmd, args)) throw new Error('Zugriff verweigert (exit 5)');
                };
                let error = null;
                try {
                    services.runPlan(steps.filter(s => s.kind !== 'install' && s.kind !== 'write' && s.kind !== 'remove'), { exec, readSecurity: () => privateAcl, out: () => {} });
                } catch (err) {
                    error = err;
                }
                return { calls, error };
            };
            const owner = runWith((cmd, args) => args.includes('/setowner'));
            assert.match(owner.error.message, /icacls\.exe .*\/setowner.*fehlgeschlagen: Zugriff verweigert/);
            assert.deepEqual(owner.calls.map(c => c.cmd), ['icacls.exe']);
            const dacl = runWith((cmd) => /powershell/.test(cmd));
            assert.match(dacl.error.message, /powershell\.exe .*fehlgeschlagen/);
            assert.deepEqual(dacl.calls.map(c => c.cmd), ['icacls.exe', 'powershell.exe']);
            assert.deepEqual(dacl.calls[1].env, { MANGA_SHELF_ROOT: data, MANGA_SHELF_SID: 'S-1-5-19' });
            const ok = runWith(() => false);
            assert.equal(ok.error, null);
            assert.deepEqual(ok.calls.map(c => `${c.cmd} ${c.first}`), ['icacls.exe ' + data, 'powershell.exe -NoProfile', 'schtasks.exe /End', 'schtasks.exe /Create', 'schtasks.exe /Run']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('permissions (acl.js)', () => {
    test('the PowerShell security dump is parsed as SIDs only; a name (failed or skipped translation) throws', () => {
        const parsed = acl.parseSecurity('{"owner":"S-1-5-32-544","reparse":false,"aces":[{"sid":"S-1-5-32-545","rights":-1610612736,"type":"Allow","inheritOnly":false},{"sid":"s-1-3-0","rights":268435456,"type":"Allow","inheritOnly":true},{"sid":"S-1-1-0","rights":278,"type":"Deny","inheritOnly":false}]}');
        assert.equal(parsed.owner, 'S-1-5-32-544');
        assert.equal(parsed.aces[0].rights, 0xa0000000);
        assert.deepEqual(parsed.aces[1], { sid: 'S-1-3-0', rights: 0x10000000, allow: true, inheritOnly: true });
        assert.equal(parsed.aces[2].allow, false);
        assert.deepEqual(acl.parseSecurity('{"owner":"S-1-5-19","reparse":true,"aces":{"sid":"S-1-5-19","rights":1,"type":"Allow"}}').aces.length, 1);
        assert.throws(() => acl.parseSecurity('{"owner":"S-1-5-19","aces":[{"sid":"Jeder","rights":2032127,"type":"Allow"}]}'), /keine SID.*Jeder/);
        assert.throws(() => acl.parseSecurity('{"owner":"VORDEFINIERT\\\\Administratoren","aces":[]}'), /keine SID/);
        assert.throws(() => acl.parseSecurity('[{"sid":"S-1-5-19","rights":1,"type":"Allow"}]'), /unerwartete/);
        assert.throws(() => acl.parseSecurity(''));
        const script = Buffer.from(acl.aclCommandArgs().at(-1), 'base64').toString('utf16le');
        assert.match(script, /Get-Acl -LiteralPath \$p/);
        assert.match(script, /GetAccessRules\(\$true, \$true, \$sid\)/);
        assert.match(script, /GetOwner\(\$sid\)/);
        assert.doesNotMatch(script, /Translate|catch/, 'no fallback to account names');
    });

    test('foreignAces: an allow-list; with write only entries that can change the object', () => {
        const security = sec([ace(ADMINS), ace(userSid, { rights: 0x1200a9 }), ace('S-1-5-11', { rights: 0x6 }), ace('S-1-3-0', { inheritOnly: true }), ace('S-1-5-19', { allow: false })]);
        assert.deepEqual(acl.foreignAces(security, [ADMINS]).map(a => a.sid), [userSid, 'S-1-5-11']);
        assert.deepEqual(acl.foreignAces(security, [ADMINS], { write: true }).map(a => a.sid), ['S-1-5-11']);
        assert.deepEqual(acl.foreignAces(security, [ADMINS, userSid, 'S-1-5-11'], { denyFor: ['s-1-5-19'] }).map(a => a.allow), [false]);
    });

    test('a .env other users may change, own or link to stops the start (Windows allow-list); none or a private one is fine', () => {
        const dir = tmpDir('ms-env-');
        try {
            const win = (security, extra = {}) => acl.readEnvFile(dir, { platform: 'win32', sid: userSid, readSecurity: typeof security === 'function' ? security : () => security, ...extra });
            assert.deepEqual(win(() => { throw new Error('nie'); }), { content: null, problem: null }, 'no .env, no check');
            const file = path.join(dir, '.env');
            fs.writeFileSync(file, 'PORT=3001\n');
            const mine = sec([ace(userSid), ace(ADMINS), ace('S-1-5-18')], { owner: userSid });
            assert.equal(win(mine).content.toString(), 'PORT=3001\n', 'read once through the checked descriptor');
            assert.equal(win(sec([...mine.aces, ace('S-1-5-32-545', { rights: 0x1200a9 })], { owner: userSid })).problem, null, 'reading is not enough');
            assert.match(win(sec([...mine.aces, ace('S-1-5-21-9-9-9-1005', { rights: 0x6 })], { owner: userSid })).problem, /andere Benutzer ändern.*icacls.*\*S-1-5-21-1-2-3-1001:F/);
            assert.match(win(sec(mine.aces, { owner: 'S-1-5-21-9-9-9-1005' })).problem, /gehört einem anderen Konto \(S-1-5-21-9-9-9-1005\)/);
            assert.equal(win(sec(mine.aces, { owner: ADMINS })).problem, null);
            assert.match(win(sec(mine.aces, { owner: userSid, reparse: true })).problem, /Verknüpfung/);
            assert.match(win(() => { throw new Error('kein PowerShell'); }).problem, /nicht prüfen.*kein PowerShell.*startet so nicht/);
            assert.match(win(() => acl.parseSecurity('{"owner":"S-1-5-19","aces":[{"sid":"Jeder","rights":2032127,"type":"Allow"}]}')).problem, /nicht prüfen.*Jeder/, 'fails closed when SIDs are missing');
            assert.match(acl.readEnvFile(dir, { platform: 'win32', readSecurity: () => mine, capture: () => 'kaputt' }).problem, /nicht prüfen.*eigenes Konto/);
            assert.equal(acl.readEnvFile(dir, { platform: 'win32', readSecurity: () => mine, capture: (cmd) => { assert.equal(cmd, acl.systemTool('whoami.exe')); return `"haus\\kim","${userSid}"`; } }).problem, null);
            if (process.platform !== 'win32') {
                const real = path.join(dir, 'echt.env');
                fs.renameSync(file, real);
                fs.symlinkSync(real, file);
                assert.match(acl.envFileProblem(dir, { platform: 'linux' }), /ist eine Verknüpfung/);
                assert.match(win(mine).problem, /ist eine Verknüpfung/);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('Unix .env rules: owner, g+w/o+w, a folder others may change, a sticky folder', { skip: process.platform === 'win32' }, () => {
        const dir = tmpDir('ms-env-unix-');
        try {
            const file = path.join(dir, '.env');
            fs.writeFileSync(file, 'PORT=3001\n');
            fs.chmodSync(file, 0o600);
            const me = process.getuid();
            const ok = acl.readEnvFile(dir, { platform: 'linux' });
            assert.deepEqual(ok, { content: Buffer.from('PORT=3001\n'), problem: null });
            for (const mode of [0o620, 0o602, 0o666]) {
                fs.chmodSync(file, mode);
                assert.match(acl.envFileProblem(dir, { platform: 'linux' }), /andere Benutzer ändern.*chmod 600/, mode.toString(8));
            }
            fs.chmodSync(file, 0o644);
            assert.match(acl.envFileProblem(dir, { platform: 'darwin', uid: me + 1 }), new RegExp(`gehört einem anderen Benutzer \\(uid ${me}\\)`));
            const problem = (st, dirSt, uid = 1000) => acl.unixEnvProblem({ file: '/d/.env', dataDir: '/d', st, dir: dirSt, uid });
            assert.equal(problem({ uid: 0, mode: 0o100644 }, { uid: 1000, mode: 0o40700 }), null, 'a root-owned .env is fine');
            assert.match(problem({ uid: 1000, mode: 0o100644 }, { uid: 1001, mode: 0o40777 }), /Datenordner \/d dürfen auch andere.*chmod 700/);
            assert.match(problem({ uid: 1000, mode: 0o100644 }, { uid: 1001, mode: 0o40775 }), /Datenordner/);
            assert.equal(problem({ uid: 1000, mode: 0o100644 }, { uid: 1000, mode: 0o40777 }), null, 'our own folder');
            assert.equal(problem({ uid: 1000, mode: 0o100644 }, { uid: 0, mode: 0o41777 }), null, 'sticky, our .env');
            assert.match(problem({ uid: 0, mode: 0o100644 }, { uid: 0, mode: 0o41777 }), /Sticky-Bit/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the binary refuses to start with a world-writable .env and loads a private one without overriding the environment', { skip: process.platform === 'win32' }, () => {
        const dir = tmpDir('ms-env-start-');
        try {
            fs.writeFileSync(path.join(dir, '.env'), 'JWT_SECRET=x\n');
            fs.chmodSync(path.join(dir, '.env'), 0o666);
            const run = spawnSync(process.execPath, [path.join(root, 'scripts/server-bin/main.js'), 'status', '--data-dir', dir], { encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent' } });
            assert.equal(run.status, 1);
            assert.match(run.stderr, /andere Benutzer ändern/);
            fs.chmodSync(path.join(dir, '.env'), 0o600);
            fs.writeFileSync(path.join(dir, '.env'), 'LOG_LEVEL=info\n');
            const status = (env) => spawnSync(process.execPath, [path.join(root, 'scripts/server-bin/main.js'), 'status', '--data-dir', dir], { encoding: 'utf8', env });
            const withoutLevel = { ...process.env };
            delete withoutLevel.LOG_LEVEL;
            const loaded = status(withoutLevel);
            assert.equal(loaded.status, 0, loaded.stderr);
            assert.match(loaded.stdout + loaded.stderr, /Console command: status/, 'LOG_LEVEL from the .env');
            const overridden = status({ ...withoutLevel, LOG_LEVEL: 'silent' });
            assert.equal(overridden.status, 0, overridden.stderr);
            assert.doesNotMatch(overridden.stdout + overridden.stderr, /Console command/, 'the environment wins over the .env');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('Windows owner-only files: only files others can open, for this account (whoami) and the Administrators', () => {
        const dir = tmpDir('ms-own-');
        try {
            for (const name of ['secret.key', 'reset-kim.txt', 'manga.db']) fs.writeFileSync(path.join(dir, name), 'x');
            assert.equal(acl.parseWhoami('"nt authority\\lokaler dienst","S-1-5-19"\r\n'), 'S-1-5-19');
            assert.equal(acl.parseWhoami('kaputt'), null);
            const calls = [];
            const capture = (cmd, args) => {
                calls.push([path.win32.basename(cmd), ...args].join(' '));
                return /whoami/.test(cmd) ? `"haus\\kim","${userSid}"` : '';
            };
            const open = new Set([path.join(dir, 'secret.key'), path.join(dir, 'reset-kim.txt')]);
            const readSecurity = (file) => (open.has(file) ? sec([ace(userSid), ace('S-1-5-21-9-9-9-1005', { rights: 0x1200a9 })]) : sec([ace(userSid), ace(ADMINS), ace('S-1-5-18')]));
            assert.deepEqual(acl.restrictWindowsFiles(dir, { capture, readSecurity }), []);
            assert.equal(calls[0], 'whoami.exe /user /fo csv /nh');
            assert.deepEqual(calls.slice(1).sort(), ['reset-kim.txt', 'secret.key'].map(n => `icacls.exe ${path.join(dir, n)} /inheritance:r /grant:r *${userSid}:F *S-1-5-32-544:F /Q`));
            calls.length = 0;
            assert.deepEqual(acl.restrictWindowsFiles(dir, { capture, readSecurity: () => sec([ace(userSid), ace(ADMINS), ace('S-1-5-18')]) }), []);
            assert.deepEqual(calls, ['whoami.exe /user /fo csv /nh'], 'a private folder (the service) is left alone');
            const failing = (cmd) => { if (/icacls/.test(cmd)) throw new Error('Zugriff verweigert'); return '"a","S-1-5-19"'; };
            assert.deepEqual(acl.restrictWindowsFiles(dir, { capture: failing, readSecurity, files: ['secret.key'] }), [path.join(dir, 'secret.key')]);
            assert.deepEqual(acl.restrictWindowsFiles(dir, { capture, readSecurity: () => { throw new Error('keine SID'); }, files: ['secret.key'] }), [path.join(dir, 'secret.key')], 'an unreadable ACL counts as failed');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('TLS certificates of the binary', () => {
    const { applySslDefaults } = require('../scripts/server-bin/main');

    test('default to <data dir>/ssl, fullchain.pem before cert.pem; set values stay', () => {
        const dir = tmpDir('ms-ssl-');
        try {
            const env = {};
            applySslDefaults(dir, env);
            assert.equal(env.SSL_KEY_PATH, path.join(dir, 'ssl', 'privkey.pem'));
            assert.equal(env.SSL_CERT_PATH, path.join(dir, 'ssl', 'cert.pem'));
            fs.mkdirSync(path.join(dir, 'ssl'));
            fs.writeFileSync(path.join(dir, 'ssl', 'fullchain.pem'), 'x');
            const withChain = { SSL_KEY_PATH: ' ' };
            applySslDefaults(dir, withChain);
            assert.equal(withChain.SSL_KEY_PATH, path.join(dir, 'ssl', 'privkey.pem'));
            assert.equal(withChain.SSL_CERT_PATH, path.join(dir, 'ssl', 'fullchain.pem'));
            const own = { SSL_KEY_PATH: '/etc/tls/key.pem', SSL_CERT_PATH: '/etc/tls/cert.pem' };
            applySslDefaults(dir, own);
            assert.deepEqual(own, { SSL_KEY_PATH: '/etc/tls/key.pem', SSL_CERT_PATH: '/etc/tls/cert.pem' });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the server config reads them from the data folder, never from the portal cache; the .env still wins', { skip: process.platform === 'win32' }, () => {
        const dir = tmpDir('ms-ssl-start-');
        const probe = `const m = require(${JSON.stringify(path.join(root, 'scripts/server-bin/main.js'))});
            m.prepareEnvironment({ dataDir: process.argv[1] }, { unpackWeb: false });
            const { config } = require(${JSON.stringify(path.join(root, 'utils/config.js'))});
            process.stdout.write(JSON.stringify([config.sslKeyPath, config.sslCertPath]));`;
        const env = { ...process.env };
        delete env.SSL_KEY_PATH;
        delete env.SSL_CERT_PATH;
        const paths = () => {
            const run = spawnSync(process.execPath, ['-e', probe, dir], { encoding: 'utf8', env });
            assert.equal(run.status, 0, run.stderr);
            return JSON.parse(run.stdout);
        };
        try {
            fs.mkdirSync(path.join(dir, 'ssl'));
            fs.writeFileSync(path.join(dir, 'ssl', 'fullchain.pem'), 'x');
            assert.deepEqual(paths(), [path.join(dir, 'ssl', 'privkey.pem'), path.join(dir, 'ssl', 'fullchain.pem')]);
            fs.writeFileSync(path.join(dir, '.env'), 'SSL_KEY_PATH=/etc/tls/key.pem\n', { mode: 0o600 });
            assert.deepEqual(paths(), ['/etc/tls/key.pem', path.join(dir, 'ssl', 'fullchain.pem')]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('embedded web portal', () => {
    let dir;
    before(() => { dir = tmpDir('ms-web-'); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    function source(id) {
        const files = { 'index.html': '<div id="root"></div>', 'assets/app.js': 'x' };
        return { id, files: Object.keys(files), read: (rel) => Buffer.from(files[rel]) };
    }

    test('is unpacked once per build into its own cache folder and old builds are removed there', () => {
        const cacheDir = path.join(dir, 'cache');
        fs.mkdirSync(cacheDir);
        const first = prepareAppDir({ cacheDir, source: source('1.0.0-aaa'), dataDir: path.join(dir, 'data') });
        assert.equal(path.dirname(first), portalDir(cacheDir));
        assert.equal(fs.readFileSync(path.join(first, 'frontend', 'dist', 'assets', 'app.js'), 'utf8'), 'x');
        fs.writeFileSync(path.join(first, 'frontend', 'dist', 'marker'), '');
        assert.equal(prepareAppDir({ cacheDir, source: source('1.0.0-aaa') }), first);
        assert.ok(fs.existsSync(path.join(first, 'frontend', 'dist', 'marker')), 'an unpacked build is reused');
        const second = prepareAppDir({ cacheDir, source: source('1.0.1-bbb') });
        assert.deepEqual(fs.readdirSync(portalDir(cacheDir)).sort(), [PORTAL_MARKER, path.basename(second)].sort());
    });

    test('never deletes other server-* entries of a shared cache folder, nor in a portal folder it did not create', () => {
        const shared = path.join(dir, 'shared');
        fs.mkdirSync(path.join(shared, 'server-important'), { recursive: true });
        fs.writeFileSync(path.join(shared, 'server-important', 'keep'), 'x');
        fs.writeFileSync(path.join(shared, 'server-notes.txt'), 'x');
        prepareAppDir({ cacheDir: shared, source: source('2.0.0-a') });
        prepareAppDir({ cacheDir: shared, source: source('2.0.1-b') });
        assert.ok(fs.existsSync(path.join(shared, 'server-important', 'keep')));
        assert.ok(fs.existsSync(path.join(shared, 'server-notes.txt')));
        assert.deepEqual(fs.readdirSync(portalDir(shared)).filter(n => n.startsWith('server-')), ['server-2.0.1-b']);

        const foreign = path.join(dir, 'foreign');
        fs.mkdirSync(path.join(portalDir(foreign), 'server-mine'), { recursive: true });
        prepareAppDir({ cacheDir: foreign, source: source('3.0.0') });
        assert.ok(fs.existsSync(path.join(portalDir(foreign), 'server-mine')), 'no marker: nothing is removed');
        assert.ok(!fs.existsSync(path.join(portalDir(foreign), PORTAL_MARKER)));
    });

    test('refuses a cache inside the data folder (index.js would not serve it)', () => {
        const dataDir = path.join(dir, 'data2');
        assert.throws(() => prepareAppDir({ cacheDir: path.join(dataDir, 'cache'), source: source('x'), dataDir }), /MANGA_SHELF_CACHE_DIR/);
    });

    test('the plain bundle reads web/ and web-manifest.json next to it', () => {
        const bundleDir = path.join(dir, 'bundle');
        fs.mkdirSync(path.join(bundleDir, 'web', 'assets'), { recursive: true });
        fs.writeFileSync(path.join(bundleDir, 'web', 'assets', 'a.js'), 'a');
        fs.writeFileSync(path.join(bundleDir, 'web-manifest.json'), JSON.stringify({ id: 'v-1', files: ['assets/a.js'] }));
        const src = webSource(bundleDir);
        assert.equal(src.id, 'v-1');
        assert.equal(src.read('assets/a.js').toString(), 'a');
        assert.equal(webSource(path.join(dir, 'none')), null);
    });
});

describe('--log-file', () => {
    test('rotates at the size limit and keeps the given number of files', () => {
        const dir = tmpDir('ms-log-');
        try {
            const log = createRotatingLog(dir, { maxBytes: 10, keep: 2 });
            for (const line of ['aaaaaa\n', 'bbbbbb\n', 'cccccc\n', 'dddddd\n']) log.write(line);
            log.close();
            assert.deepEqual(fs.readdirSync(dir).sort(), ['manga-shelf.log', 'manga-shelf.log.1', 'manga-shelf.log.2']);
            assert.equal(fs.readFileSync(path.join(dir, 'manga-shelf.log'), 'utf8'), 'dddddd\n');
            assert.equal(fs.readFileSync(path.join(dir, 'manga-shelf.log.2'), 'utf8'), 'bbbbbb\n');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the log is owner-only and every opened file passes through onOpen', () => {
        const dir = tmpDir('ms-log-mode-');
        try {
            const old = path.join(dir, 'manga-shelf.log');
            fs.writeFileSync(old, 'alt\n', { mode: 0o644 });
            if (process.platform !== 'win32') fs.chmodSync(old, 0o644);
            const opened = [];
            const log = createRotatingLog(dir, { maxBytes: 8, keep: 1, onOpen: (f) => opened.push(path.basename(f)) });
            log.write('Einrichtungscode\n');
            log.close();
            assert.deepEqual(opened, ['manga-shelf.log', 'manga-shelf.log']);
            if (process.platform !== 'win32') {
                assert.equal(fs.statSync(old).mode & 0o777, 0o600);
                assert.equal(fs.statSync(`${old}.1`).mode & 0o777, 0o600);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('tees a stream without changing what it writes', () => {
        const written = [];
        const stream = { write(chunk) { written.push(String(chunk)); return true; } };
        const copy = [];
        const undo = teeStreams({ write: (c) => copy.push(String(c)) }, [stream]);
        stream.write('hallo\n', 'utf8');
        undo();
        stream.write('weg\n');
        assert.deepEqual(written, ['hallo\n', 'weg\n']);
        assert.deepEqual(copy, ['hallo\n']);
    });
});

describe('build-sea.js', () => {
    test('targets and names', () => {
        assert.equal(buildSea.hostTarget('linux', 'x64'), 'linux-x64');
        assert.equal(buildSea.hostTarget('darwin', 'arm64'), 'macos-arm64');
        assert.equal(buildSea.hostTarget('win32', 'x64'), 'windows-x64');
        assert.equal(buildSea.hostTarget('freebsd', 'x64'), null);
        assert.equal(buildSea.binaryName('windows-x64'), 'manga-shelf-server-windows-x64.exe');
        assert.equal(buildSea.binaryName('macos-universal'), 'manga-shelf-server-macos-universal');
        assert.deepEqual(buildSea.parseArgs(['--target', 'linux-x64,linux-arm64', '--bundle-only']).targets, ['linux-x64', 'linux-arm64']);
        assert.throws(() => buildSea.parseArgs(['--target', 'amiga']), /Unbekanntes Ziel/);
        assert.throws(() => buildSea.parseArgs(['--target', 'linux-x64,windows-x64', '--node-binary', 'x']), /genau einem Ziel/);
    });

    test('binaryTarget reads OS and CPU from ELF, PE and Mach-O headers', () => {
        const dir = tmpDir('ms-hdr-');
        try {
            const write = (name, bytes) => {
                const buf = Buffer.alloc(4096);
                bytes(buf);
                fs.writeFileSync(path.join(dir, name), buf);
                return buildSea.binaryTarget(path.join(dir, name));
            };
            assert.equal(write('elf-x64', b => { b.writeUInt32BE(0x7f454c46, 0); b.writeUInt16LE(0x3e, 18); }), 'linux-x64');
            assert.equal(write('elf-arm', b => { b.writeUInt32BE(0x7f454c46, 0); b.writeUInt16LE(0xb7, 18); }), 'linux-arm64');
            assert.equal(write('pe', b => { b.write('MZ', 0, 'latin1'); b.writeUInt32LE(0x80, 0x3c); b.write('PE\0\0', 0x80, 'latin1'); b.writeUInt16LE(0x8664, 0x84); }), 'windows-x64');
            assert.equal(write('macho', b => { b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(0x0100000c, 4); }), 'macos-arm64');
            assert.equal(write('text', b => b.write('hello')), null);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('dirnamePlugin strips a shebang behind the __dirname shim, with LF and with the CRLF of a Windows checkout', async () => {
        const root = tmpDir('ms-shim-');
        try {
            fs.mkdirSync(path.join(root, 'scripts'));
            const load = (name, text) => {
                const file = path.join(root, 'scripts', name);
                fs.writeFileSync(file, text);
                let onLoad;
                buildSea.dirnamePlugin(root).setup({ onLoad: (_filter, fn) => { onLoad = fn; } });
                return onLoad({ path: file });
            };
            for (const [name, eol] of [['lf.js', '\n'], ['crlf.js', '\r\n']]) {
                const out = await load(name, `#!/usr/bin/env node${eol}const here = __dirname;${eol}`);
                assert.ok(out.contents.startsWith('var __dirname = require("path").join('), name);
                assert.ok(!out.contents.includes('#!'), `${name}: shebang must not survive behind the shim`);
                assert.match(out.contents, /const here = __dirname;/);
            }
            assert.equal(await load('plain.js', 'const x = 1;\n'), null, 'files without __dirname are left to esbuild');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('runtimeRequires finds every require the bundle leaves for run time', () => {
        const code = 'require("fs"); require("node:sqlite"); require(name); __require("x"); function __require() {}';
        assert.deepEqual(buildSea.runtimeRequires(code), ['require(name)', '__require("x")']);
    });
});

function esbuildAvailable() {
    for (const base of [root, path.join(root, 'frontend')]) {
        try {
            require.resolve('esbuild', { paths: [base] });
            return true;
        } catch (e) { /* next */ }
    }
    return false;
}

// CI installs the frontend toolchain in the backend job: there a missing esbuild is a failure, not a skip
const bundleSkip = !esbuildAvailable() && !process.env.CI ? 'esbuild fehlt (cd frontend && npm ci)' : false;

describe('esbuild bundle of the server', { skip: bundleSkip }, () => {
    let dir;
    let outDir;
    let bundlePath;
    let metafile;

    before(async () => {
        dir = tmpDir('ms-sea-bundle-');
        const frontend = path.join(dir, 'frontend');
        fs.mkdirSync(path.join(frontend, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(frontend, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
        fs.writeFileSync(path.join(frontend, 'assets', 'app.js'), 'console.log(1)');
        outDir = path.join(dir, 'out');
        bundlePath = (await buildSea.build({ targets: [], out: outDir, frontend, nodeBinary: null, bundleOnly: true })).bundle;
        metafile = (await buildSea.bundle(path.join(dir, 'meta'))).metafile;
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('leaves no dynamic require except two that never run in the server', () => {
        // express/lib/view.js loads template engines (no views here); db.js falls back to better-sqlite3 only without node:sqlite
        assert.deepEqual(buildSea.runtimeRequires(fs.readFileSync(bundlePath, 'utf8')).sort(), ['require("better-sqlite3")', 'require(mod)']);
    });

    test('contains the core route table, every core handler and every server route', () => {
        const inputs = new Set(Object.keys(metafile.inputs).map(p => p.split(path.sep).join('/')));
        const expected = ['core/routes.js', 'index.js', 'scripts/admin.js', 'services/console.js',
            ...fs.readdirSync(path.join(root, 'core', 'handlers')).filter(f => f.endsWith('.js')).map(f => `core/handlers/${f}`),
            ...['auth', 'apiKeys', 'core', 'backups', 'system', 'uploads'].map(f => `routes/${f}.js`)];
        for (const rel of expected) assert.ok(inputs.has(rel), `${rel} fehlt im Bundle`);
        assert.ok(![...inputs].some(p => p.startsWith('test/') || p.startsWith('frontend/')), 'test or frontend code in the bundle');
    });

    test('gives each repository module its own __dirname below the app folder', () => {
        const code = fs.readFileSync(bundlePath, 'utf8');
        assert.match(code, /globalThis\.__MANGA_SHELF_APP_DIR__ \|\| process\.cwd\(\), "utils"\)/);
        assert.match(code, /globalThis\.__MANGA_SHELF_APP_DIR__ \|\| process\.cwd\(\), "\."\)/);
    });

    test('starts with a temporary data folder: health, portal, API, status command, log file', async () => {
        const { smoke } = require('../scripts/server-bin/smoke');
        assert.equal(await smoke(bundlePath), true);
    });

    test('--version and unknown options', () => {
        const env = { ...process.env, MANGA_SHELF_CACHE_DIR: path.join(dir, 'cache') };
        const version = spawnSync(process.execPath, [bundlePath, '--version'], { encoding: 'utf8', env });
        assert.equal(version.status, 0);
        assert.match(version.stdout, new RegExp(`^manga-shelf-server v${require('../package.json').version.replace(/\./g, '\\.')} `));
        const bad = spawnSync(process.execPath, [bundlePath, '--bogus'], { encoding: 'utf8', env });
        assert.equal(bad.status, 2);
        assert.match(bad.stderr, /Unbekannte Option/);
        const service = spawnSync(process.execPath, [bundlePath, 'install-service'], { encoding: 'utf8', env });
        assert.equal(service.status, 2, 'install-service only from the built binary');
        assert.match(service.stderr, /nur mit der gebauten Binärdatei/);
    });
});
