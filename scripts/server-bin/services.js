// install-service / uninstall-service: systemd (Linux), launchd (macOS), Task Scheduler (Windows). The plans are
// plain step lists so they can be tested without touching the system; runPlan() executes them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { UsageError } = require('./cli');
const { SID, SID_PATTERN, readWindowsSecurity, resolveAccountSid, serviceAclProblem, systemTool, protectArgs } = require('./acl');

const SERVICE_NAME = 'manga-shelf';
const SERVICE_USER = 'manga-shelf';
const SYSTEM_DATA_DIR = '/var/lib/manga-shelf';
const PACKAGED_BINARY = '/usr/bin/manga-shelf-server';
const INSTALLED_BINARY = '/usr/local/bin/manga-shelf-server';
const SYSTEM_UNIT = `/etc/systemd/system/${SERVICE_NAME}.service`;
const LAUNCHD_LABEL = 'de.manga-shelf.server';
const WINDOWS_TASK = 'Manga Shelf Server';

/** Arguments the service starts the binary with. */
function serverArgs({ port, host, dataDir, logFile = false }) {
    const args = ['--no-console'];
    if (logFile) args.push('--log-file');
    if (port !== null && port !== undefined) args.push('--port', String(port));
    if (host) args.push('--host', host);
    args.push('--data-dir', dataDir);
    return args;
}

const quoteSystemd = (arg) => (/[\s"\\]/.test(arg) ? `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : arg);
// BindPaths splits at ":" (source:destination) outside quotes
const quoteBindPath = (arg) => (/[\s"\\:]/.test(arg) ? `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : arg);
const HOME_ROOTS = ['/home', '/root', '/run/user'];
/** Paths that ProtectHome= covers. */
const isUnderHome = (dir) => {
    const normalized = path.posix.resolve(String(dir));
    return HOME_ROOTS.some((rootDir) => normalized === rootDir || normalized.startsWith(rootDir + '/'));
};
function quoteWindows(arg) {
    if (!/[\s"]/.test(arg)) return arg;
    let out = '"';
    let slashes = 0;
    for (const ch of arg) {
        if (ch === '\\') {
            slashes++;
            continue;
        }
        out += '\\'.repeat(ch === '"' ? slashes * 2 + 1 : slashes) + ch;
        slashes = 0;
    }
    return `${out}${'\\'.repeat(slashes * 2)}"`;
}
const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function systemdUnit({ binary, args, system = true }) {
    const lines = [
        '[Unit]',
        'Description=Manga Shelf Server',
        'Documentation=https://github.com/LixNix-Swap-Org/manga-shelf',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple'
    ];
    if (system) lines.push(`User=${SERVICE_USER}`, `Group=${SERVICE_USER}`);
    lines.push(
        `ExecStart=${[binary, ...args].map(quoteSystemd).join(' ')}`,
        'Environment=NODE_ENV=production',
        'CacheDirectory=manga-shelf',
        'Restart=on-failure',
        'RestartSec=5',
        'TimeoutStopSec=20',
        'UMask=0027',
        'NoNewPrivileges=true'
    );
    if (system) {
        const dataDir = args[args.indexOf('--data-dir') + 1];
        // ProtectHome=true hides a folder below /home even with ReadWritePaths; tmpfs + BindPaths shows only that one
        const home = isUnderHome(dataDir);
        lines.push('ProtectSystem=full', `ProtectHome=${home ? 'tmpfs' : 'true'}`, 'PrivateTmp=true');
        if (home) lines.push(`BindPaths=${quoteBindPath(dataDir)}`);
        lines.push(`ReadWritePaths=${quoteSystemd(dataDir)}`);
    }
    lines.push('', '[Install]', `WantedBy=${system ? 'multi-user.target' : 'default.target'}`, '');
    return lines.join('\n');
}

function launchdPlist({ binary, args, logDir }) {
    const strings = [binary, ...args].map((a) => `        <string>${xml(a)}</string>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${strings}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardErrorPath</key>
    <string>${xml(path.posix.join(logDir, 'launchd.log'))}</string>
</dict>
</plist>
`;
}

const WELL_KNOWN_ACCOUNTS = [
    { sid: SID.LOCAL_SERVICE, label: 'LOCAL SERVICE', names: ['localservice', 'local service', 'nt authority\\localservice', 'nt authority\\local service'] },
    { sid: SID.NETWORK_SERVICE, label: 'NETWORK SERVICE', names: ['networkservice', 'network service', 'nt authority\\networkservice', 'nt authority\\network service'] },
    { sid: SID.SYSTEM, label: 'SYSTEM', names: ['system', 'localsystem', 'nt authority\\system'] }
];

const ACCOUNT_NAME = /^[\p{L}\p{N}_ .@$-]+(\\[\p{L}\p{N}_ .@$-]+)?$/u;

/**
 * --account on Windows: LOCAL SERVICE when empty, a well-known service account by name or SID, anything else runs as
 * S4U (no stored password). sid is null until resolveWindowsAccount; grant is the icacls form (*SID).
 */
function windowsAccount(account, { env = {} } = {}) {
    const text = String(account || '').trim();
    const key = text.toLowerCase();
    const known = text ? WELL_KNOWN_ACCOUNTS.find((a) => a.sid.toLowerCase() === key || a.names.includes(key)) : WELL_KNOWN_ACCOUNTS[0];
    if (known) return { sid: known.sid, label: known.label, grant: `*${known.sid}`, s4u: false };
    if (SID_PATTERN.test(text)) {
        const sid = text.toUpperCase();
        return { sid, user: sid, label: sid, grant: `*${sid}`, s4u: true };
    }
    let user = text;
    if (text.startsWith('.\\')) {
        if (!env.COMPUTERNAME) throw new UsageError(`--account ${text}: COMPUTERNAME ist nicht gesetzt, Konto als COMPUTER\\name angeben`);
        user = `${env.COMPUTERNAME}\\${text.slice(2)}`;
    }
    if (!ACCOUNT_NAME.test(user) || user.split('\\').some((part) => /^[. ]*$/.test(part))) throw new UsageError(`Ungültiges Konto für --account: "${text}"`);
    return { sid: null, user, label: user, grant: null, s4u: true };
}

/** Resolves an S4U account to its SID (also checks that a given SID exists); well-known accounts stay as they are. */
function resolveWindowsAccount(account, resolveSid) {
    if (!account.s4u) return account;
    let sid;
    try {
        sid = resolveSid(account.user);
    } catch (err) {
        throw new UsageError(`Konto „${account.user}“ nicht gefunden (${String(err.message || err).trim()}); nichts geändert.`);
    }
    return { ...account, sid, grant: `*${sid}` };
}

// Task Scheduler instead of a service: a Node process is no Windows service without a wrapper (WinSW/NSSM, see README)
function windowsTaskXml({ binary, args, account = windowsAccount(null) }) {
    const principal = account.s4u
        ? `<UserId>${xml(account.user)}</UserId>\n      <LogonType>S4U</LogonType>`
        : `<UserId>${account.sid}</UserId>`;
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Manga Shelf Server (Web-Portal und API)</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      ${principal}
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(binary)}</Command>
      <Arguments>${xml(args.map(quoteWindows).join(' '))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Steps for install-service. ctx: { platform, options, execPath, env, uid, home, resolveSid }. Step kinds: run, write,
 * mkdir, install, ensureUser, windowsRoot, checkAcl, remove, note (see runPlan). Windows resolves the account first.
 */
function installPlan({ platform, options, execPath, env = {}, uid = null, home = os.homedir(), resolveSid = (name) => resolveAccountSid(name, { env }) }) {
    const steps = [];
    const note = (text) => steps.push({ kind: 'note', text });
    if (options.account && platform !== 'win32') throw new UsageError('--account gibt es nur unter Windows');
    if (platform === 'linux') {
        if (options.user) {
            if (uid === 0) throw new UsageError('--user nicht als root ausführen (ohne --user wird ein System-Dienst eingerichtet)');
            const dataDir = options.dataDir || env.DATA_DIR || path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'manga-shelf');
            const unitFile = path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'systemd', 'user', `${SERVICE_NAME}.service`);
            steps.push(
                { kind: 'mkdir', dir: dataDir, mode: 0o700 },
                { kind: 'write', file: unitFile, content: systemdUnit({ binary: execPath, args: serverArgs({ ...options, dataDir }), system: false }) },
                { kind: 'run', cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
                { kind: 'run', cmd: 'systemctl', args: ['--user', 'enable', '--now', SERVICE_NAME] }
            );
            note(`Benutzer-Dienst eingerichtet (${unitFile}), Daten in ${dataDir}.`);
            note('Damit er ohne Anmeldung startet: loginctl enable-linger $USER');
            note(`Logs und Einrichtungscode: journalctl --user -u ${SERVICE_NAME} -n 50`);
            return steps;
        }
        if (uid !== 0) throw new UsageError('install-service braucht root (sudo manga-shelf-server install-service) oder --user für einen Benutzer-Dienst');
        const dataDir = options.dataDir || SYSTEM_DATA_DIR;
        const binary = execPath === PACKAGED_BINARY ? PACKAGED_BINARY : INSTALLED_BINARY;
        steps.push({ kind: 'ensureUser', name: SERVICE_USER, home: SYSTEM_DATA_DIR });
        steps.push({ kind: 'mkdir', dir: dataDir, owner: SERVICE_USER, mode: 0o750 });
        if (binary !== execPath) {
            steps.push({ kind: 'run', cmd: 'systemctl', args: ['stop', SERVICE_NAME], allowFail: true });
            steps.push({ kind: 'install', from: execPath, to: binary });
        }
        steps.push(
            { kind: 'write', file: SYSTEM_UNIT, content: systemdUnit({ binary, args: serverArgs({ ...options, dataDir }), system: true }) },
            { kind: 'run', cmd: 'systemctl', args: ['daemon-reload'] },
            { kind: 'run', cmd: 'systemctl', args: ['enable', SERVICE_NAME] },
            { kind: 'run', cmd: 'systemctl', args: ['restart', SERVICE_NAME] }
        );
        note(`System-Dienst ${SERVICE_NAME} eingerichtet: ${binary}, Benutzer ${SERVICE_USER}, Daten in ${dataDir}.`);
        if (isUnderHome(dataDir)) note(`Der Datenordner liegt unter ${HOME_ROOTS.join(', ')}: der Dienst sieht dort nur ${dataDir} (ProtectHome=tmpfs, BindPaths); für einen Dienst ohne root gibt es --user.`);
        note(`Logs und Einrichtungscode: journalctl -u ${SERVICE_NAME} -n 50`);
        return steps;
    }
    if (platform === 'darwin') {
        const dataDir = options.dataDir || env.DATA_DIR || path.posix.join(home, 'Library', 'Application Support', 'manga-shelf');
        const plistFile = path.posix.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
        const logDir = path.posix.join(home, 'Library', 'Logs', 'manga-shelf');
        const domain = `gui/${uid}`;
        steps.push(
            { kind: 'run', cmd: 'xattr', args: ['-d', 'com.apple.quarantine', execPath], allowFail: true },
            { kind: 'mkdir', dir: dataDir, mode: 0o700 },
            { kind: 'mkdir', dir: logDir },
            { kind: 'run', cmd: 'launchctl', args: ['bootout', `${domain}/${LAUNCHD_LABEL}`], allowFail: true },
            { kind: 'write', file: plistFile, content: launchdPlist({ binary: execPath, args: serverArgs({ ...options, dataDir, logFile: true }), logDir }) },
            { kind: 'run', cmd: 'launchctl', args: ['bootstrap', domain, plistFile] }
        );
        note(`LaunchAgent ${LAUNCHD_LABEL} eingerichtet (${plistFile}), startet bei der Anmeldung; Daten in ${dataDir}.`);
        note(`Logs und Einrichtungscode: ${path.posix.join(dataDir, 'logs', 'manga-shelf.log')}`);
        note(`Die Binärdatei bleibt in ${execPath}; nach dem Verschieben install-service erneut ausführen.`);
        return steps;
    }
    if (platform === 'win32') {
        const programData = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
        const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
        const dataDir = options.dataDir || path.win32.join(programData, 'manga-shelf', 'data');
        // the default folder is protected from its parent on, so nobody can swap the data folder underneath
        const aclRoot = options.dataDir ? dataDir : path.win32.dirname(dataDir);
        const account = resolveWindowsAccount(windowsAccount(options.account, { env }), resolveSid);
        const binary = path.win32.join(programFiles, 'Manga Shelf Server', 'manga-shelf-server.exe');
        const xmlFile = path.win32.join(env.TEMP || env.TMP || programData, 'manga-shelf-task.xml');
        const tool = (name) => systemTool(name, env);
        const inData = (...parts) => path.win32.join(dataDir, ...parts);
        steps.push(
            { kind: 'windowsRoot', root: aclRoot, dataDir },
            { kind: 'run', cmd: tool('icacls.exe'), args: [aclRoot, '/setowner', `*${SID.ADMINISTRATORS}`, '/T', '/Q'] },
            { kind: 'run', cmd: tool('powershell.exe'), args: protectArgs(), env: { MANGA_SHELF_ROOT: aclRoot, MANGA_SHELF_SID: account.sid } },
            { kind: 'checkAcl', paths: [dataDir, inData('logs'), inData('logs', 'manga-shelf.log'), inData('secret.key'), inData('.env')], sid: account.sid },
            { kind: 'run', cmd: tool('schtasks.exe'), args: ['/End', '/TN', WINDOWS_TASK], allowFail: true }
        );
        if (path.win32.resolve(execPath).toLowerCase() !== binary.toLowerCase()) steps.push({ kind: 'install', from: execPath, to: binary });
        steps.push(
            { kind: 'write', file: xmlFile, content: windowsTaskXml({ binary, args: serverArgs({ ...options, dataDir, logFile: true }), account }), encoding: 'utf16le' },
            { kind: 'run', cmd: tool('schtasks.exe'), args: ['/Create', '/TN', WINDOWS_TASK, '/XML', xmlFile, '/F'] },
            { kind: 'remove', file: xmlFile },
            { kind: 'run', cmd: tool('schtasks.exe'), args: ['/Run', '/TN', WINDOWS_TASK] }
        );
        note(`Geplante Aufgabe „${WINDOWS_TASK}“ eingerichtet (beim Systemstart, als ${account.label}, ohne Anmeldung): ${binary}, Daten in ${dataDir}.`);
        note(`Der Datenordner ist nur für ${account.label}, SYSTEM und die Administratoren zugänglich.`);
        if (account.sid === SID.SYSTEM) note('Hinweis: als SYSTEM hat der Server alle Rechte auf diesem Computer; LOCAL SERVICE (Standard) reicht.');
        note(`Logs und Einrichtungscode: ${path.win32.join(dataDir, 'logs', 'manga-shelf.log')} (als Administrator lesen)`);
        note(`Konsolenbefehle als Administrator: "${binary}" <befehl> --data-dir "${dataDir}"`);
        note(`Für andere Geräte im Netz den Port in der Windows-Firewall freigeben (z. B. netsh advfirewall firewall add rule name="${WINDOWS_TASK}" dir=in action=allow protocol=TCP localport=${options.port || 3000}).`);
        return steps;
    }
    throw new UsageError(`install-service gibt es für ${platform} nicht`);
}

function uninstallPlan({ platform, options, env = {}, uid = null, home = os.homedir() }) {
    const steps = [];
    const note = (text) => steps.push({ kind: 'note', text });
    if (platform === 'linux') {
        if (options.user) {
            const unitFile = path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'systemd', 'user', `${SERVICE_NAME}.service`);
            steps.push(
                { kind: 'run', cmd: 'systemctl', args: ['--user', 'disable', '--now', SERVICE_NAME], allowFail: true },
                { kind: 'remove', file: unitFile },
                { kind: 'run', cmd: 'systemctl', args: ['--user', 'daemon-reload'] }
            );
        } else {
            if (uid !== 0) throw new UsageError('uninstall-service braucht root (sudo) oder --user für den Benutzer-Dienst');
            steps.push(
                { kind: 'run', cmd: 'systemctl', args: ['disable', '--now', SERVICE_NAME], allowFail: true },
                { kind: 'remove', file: SYSTEM_UNIT },
                { kind: 'remove', file: INSTALLED_BINARY },
                { kind: 'run', cmd: 'systemctl', args: ['daemon-reload'] }
            );
            note(`Datenordner ${SYSTEM_DATA_DIR} und Benutzer ${SERVICE_USER} bleiben erhalten.`);
        }
        note('Dienst entfernt; die Daten bleiben erhalten.');
        return steps;
    }
    if (platform === 'darwin') {
        const plistFile = path.posix.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
        steps.push(
            { kind: 'run', cmd: 'launchctl', args: ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], allowFail: true },
            { kind: 'remove', file: plistFile }
        );
        note('LaunchAgent entfernt; die Daten bleiben erhalten.');
        return steps;
    }
    if (platform === 'win32') {
        const schtasks = systemTool('schtasks.exe', env);
        steps.push(
            { kind: 'run', cmd: schtasks, args: ['/End', '/TN', WINDOWS_TASK], allowFail: true },
            { kind: 'run', cmd: schtasks, args: ['/Delete', '/TN', WINDOWS_TASK, '/F'] }
        );
        note('Geplante Aufgabe entfernt; Programm und Daten bleiben erhalten.');
        return steps;
    }
    throw new UsageError(`uninstall-service gibt es für ${platform} nicht`);
}

function defaultExec(cmd, args, { quiet = false, env = null } = {}) {
    execFileSync(cmd, args, { stdio: ['ignore', quiet ? 'ignore' : 'inherit', quiet ? 'ignore' : 'inherit'], ...(env ? { env: { ...process.env, ...env } } : {}), windowsHide: true });
}

const lstatOrNull = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) || null;

/** The folders from `root` down to `dir` (just root when dir is not below it). */
function folderChain(root, dir) {
    const chain = [];
    for (let p = path.resolve(dir); ; p = path.dirname(p)) {
        chain.unshift(p);
        if (p === path.resolve(root) || path.dirname(p) === p) break;
    }
    return chain[0] === path.resolve(root) ? chain : [path.resolve(root)];
}

/** Windows: the data folder chain holds no links, the root (when it exists already) belongs to Administrators/SYSTEM. */
function prepareWindowsRoot({ root, dataDir }, readSecurity) {
    const fail = (p, reason) => { throw new Error(`${p} ${reason}; Einrichtung abgebrochen.`); };
    const assertPlain = (p) => {
        const st = lstatOrNull(p);
        if (!st) return null;
        if (st.isSymbolicLink()) fail(p, 'ist eine Verknüpfung (Junction/Symlink)');
        if (!st.isDirectory()) fail(p, 'ist kein Ordner');
        const security = readSecurity(p);
        if (security.reparse) fail(p, 'ist eine Verknüpfung (Reparse-Punkt)');
        return security;
    };
    const chain = folderChain(root, dataDir);
    const created = [];
    for (let p = path.dirname(chain[0]); !lstatOrNull(p) && path.dirname(p) !== p; p = path.dirname(p)) created.unshift(p);
    for (const p of chain) {
        const security = assertPlain(p);
        if (!security) created.push(p);
        else if (p === chain[0] && ![SID.ADMINISTRATORS, SID.SYSTEM].includes(security.owner)) {
            fail(p, `gehört nicht den Administratoren (Besitzer ${security.owner}). Ordner prüfen und, falls er sicher ist, als Administrator übernehmen: icacls "${p}" /setowner *${SID.ADMINISTRATORS} /T`);
        }
    }
    fs.mkdirSync(dataDir, { recursive: true });
    for (const p of created) {
        if (!assertPlain(p)) fail(p, 'fehlt');
    }
}

function runPlan(steps, { exec = defaultExec, readSecurity = readWindowsSecurity, out = (text) => process.stdout.write(text + '\n') } = {}) {
    for (const step of steps) {
        switch (step.kind) {
            case 'note':
                out(step.text);
                break;
            case 'mkdir':
                fs.mkdirSync(step.dir, { recursive: true });
                if (step.mode !== undefined) fs.chmodSync(step.dir, step.mode);
                if (step.owner) exec('chown', ['-R', `${step.owner}:${step.owner}`, step.dir]);
                break;
            case 'windowsRoot':
                prepareWindowsRoot(step, readSecurity);
                break;
            case 'checkAcl':
                step.paths.forEach((p, i) => {
                    const st = lstatOrNull(p);
                    if (!st && i > 0) return;
                    const problem = st && st.isSymbolicLink() ? 'ist eine Verknüpfung (Junction/Symlink)' : serviceAclProblem(readSecurity(p), step.sid);
                    if (problem) throw new Error(`${p}: ${problem}; Einrichtung abgebrochen.`);
                });
                break;
            case 'write':
                fs.mkdirSync(path.dirname(step.file), { recursive: true });
                fs.writeFileSync(step.file, step.encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(step.content, 'utf16le')]) : step.content);
                break;
            case 'install': {
                // a running binary cannot be overwritten in place, a renamed copy can replace it
                fs.mkdirSync(path.dirname(step.to), { recursive: true });
                const tmp = `${step.to}.new`;
                fs.copyFileSync(step.from, tmp);
                fs.chmodSync(tmp, 0o755);
                fs.renameSync(tmp, step.to);
                break;
            }
            case 'remove':
                fs.rmSync(step.file, { force: true });
                break;
            case 'ensureUser':
                try {
                    exec('id', ['-u', step.name], { quiet: true });
                } catch (e) {
                    exec('useradd', ['--system', '--user-group', '--home-dir', step.home, '--no-create-home', '--shell', '/usr/sbin/nologin', step.name]);
                }
                break;
            case 'run':
                try {
                    exec(step.cmd, step.args, step.env ? { env: step.env } : undefined);
                } catch (err) {
                    if (!step.allowFail) throw new Error(`${step.cmd} ${step.args.join(' ')} fehlgeschlagen: ${err.message}`);
                }
                break;
            default:
                throw new Error(`Unbekannter Schritt ${step.kind}`);
        }
    }
}

module.exports = {
    serverArgs, systemdUnit, isUnderHome, launchdPlist, windowsTaskXml, windowsAccount, resolveWindowsAccount, installPlan, uninstallPlan, runPlan, folderChain,
    SERVICE_NAME, SERVICE_USER, SYSTEM_DATA_DIR, PACKAGED_BINARY, INSTALLED_BINARY, LAUNCHD_LABEL, WINDOWS_TASK
};
