const fs = require('fs');
const path = require('path');
const { ZIP_ASSET, SEA_ASSETS } = require('./constants');

const SYSTEM_DIRS = ['/usr/bin', '/usr/local/bin', '/usr/sbin', '/bin', '/sbin'];
const LAUNCHD_LABEL = 'de.manga-shelf.server';
const SYSTEMD_UNIT = '/manga-shelf.service';

function seaCheck() {
    try {
        return require('node:sea').isSea();
    } catch (e) {
        return false;
    }
}

function readCgroup(fsx) {
    try {
        return String(fsx.readFileSync('/proc/self/cgroup', 'utf8'));
    } catch (e) {
        return '';
    }
}

/** systemd | launchd | wings from positive markers only; null for everything else. */
function detectSupervisor({ env, platform, fsx }) {
    if (env.P_SERVER_UUID) return 'wings';
    if (env.MANGA_SHELF_SUPERVISOR === 'systemd' || env.MANGA_SHELF_SUPERVISOR === 'launchd') return env.MANGA_SHELF_SUPERVISOR;
    if (platform === 'linux' && env.INVOCATION_ID) {
        const inUnit = readCgroup(fsx).split('\n').some((line) => line.trim().endsWith(SYSTEMD_UNIT));
        if (inUnit) return 'systemd';
    }
    if (platform === 'darwin' && env.XPC_SERVICE_NAME === LAUNCHD_LABEL) return 'launchd';
    return null;
}

function writable(fsx, dir) {
    try {
        fsx.accessSync(dir, fs.constants.W_OK);
        return true;
    } catch (e) {
        return false;
    }
}

const underDir = (file, dir, ci) => {
    const a = ci ? file.toLowerCase() : file;
    const b = (ci ? dir.toLowerCase() : dir).replace(/[\\/]+$/, '');
    return a === b || a.startsWith(b + (ci ? '\\' : '/')) || (ci && a.startsWith(b + '/'));
};

function posixBinaryProblem({ execPath, uid, fsx }) {
    let st;
    let dir;
    try {
        st = fsx.lstatSync(execPath);
        dir = fsx.lstatSync(path.posix.dirname(execPath));
    } catch (e) {
        return 'unreadable';
    }
    if (st.isSymbolicLink() || dir.isSymbolicLink()) return 'symlink';
    if (!st.isFile() || !dir.isDirectory()) return 'unreadable';
    if (SYSTEM_DIRS.some((d) => underDir(execPath, d, false))) return 'system_path';
    if (uid === null || st.uid !== uid || dir.uid !== uid) return 'foreign_owner';
    if ((st.mode & 0o022) || (dir.mode & 0o022)) return 'shared_writable';
    if (!writable(fsx, path.posix.dirname(execPath))) return 'not_writable';
    return null;
}

function windowsBinaryProblem({ execPath, env, fsx, windowsAcl }) {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files'].filter(Boolean);
    if (roots.some((root) => underDir(execPath, root, true))) return 'system_path';
    try {
        if (fsx.lstatSync(execPath).isSymbolicLink() || fsx.lstatSync(path.win32.dirname(execPath)).isSymbolicLink()) return 'symlink';
    } catch (e) {
        return 'unreadable';
    }
    if (!writable(fsx, path.win32.dirname(execPath))) return 'not_writable';
    if (!windowsAcl) return 'acl_unavailable';
    try {
        const self = windowsAcl.currentSid();
        const allowed = [self, windowsAcl.SID.ADMINISTRATORS, windowsAcl.SID.SYSTEM];
        for (const target of [execPath, path.win32.dirname(execPath)]) {
            const security = windowsAcl.readWindowsSecurity(target);
            if (security.reparse) return 'symlink';
            if (!allowed.includes(security.owner)) return 'foreign_owner';
            if (windowsAcl.foreignAces(security, allowed, { write: true }).length) return 'shared_writable';
        }
    } catch (e) {
        return 'unreadable';
    }
    return null;
}

/** { mode, canInstall, reason, supervisor, codeDir, execPath, assetName, restart }; a Windows binary needs `windowsAcl` (scripts/server-bin/acl.js). */
function detectInstallMode(deps = {}) {
    const env = deps.env || process.env;
    const platform = deps.platform || process.platform;
    const arch = deps.arch || process.arch;
    const versions = deps.versions || process.versions;
    const fsx = deps.fs || fs;
    const execPath = deps.execPath || process.execPath;
    const codeDir = deps.codeDir || path.join(__dirname, '..', '..');
    const uid = deps.uid !== undefined ? deps.uid : (typeof process.getuid === 'function' ? process.getuid() : null);
    const isSea = deps.isSea !== undefined ? deps.isSea : seaCheck();
    const supervisor = detectSupervisor({ env, platform, fsx });
    const base = { supervisor, codeDir, execPath, assetName: null, restart: null };
    const no = (mode, reason, extra = {}) => ({ mode, canInstall: false, reason, ...base, ...extra });

    if (versions && versions.electron) return no('desktop', 'desktop');
    if (isSea) {
        const assetName = SEA_ASSETS[`${platform}-${arch}`] || null;
        const problem = platform === 'win32'
            ? windowsBinaryProblem({ execPath, env, fsx, windowsAcl: deps.windowsAcl })
            : posixBinaryProblem({ execPath, uid, fsx });
        if (problem) return no('sea-system', problem, { assetName });
        if (!assetName) return no('sea-user', 'no_asset');
        const restart = platform !== 'win32' && (supervisor === 'systemd' || supervisor === 'launchd') ? 'supervised' : 'manual';
        return { mode: 'sea-user', canInstall: true, reason: null, ...base, assetName, restart };
    }
    if (env.P_SERVER_UUID) {
        const tree = ['index.js', 'package.json'].every((f) => fsx.existsSync(path.join(codeDir, f)));
        if (!tree || !writable(fsx, codeDir)) return no('pterodactyl', 'code_not_writable', { assetName: ZIP_ASSET });
        return { mode: 'pterodactyl', canInstall: true, reason: null, ...base, assetName: ZIP_ASSET, restart: 'pterodactyl' };
    }
    if (fsx.existsSync('/.dockerenv') || (env.DATA_DIR === '/app/data' && !writable(fsx, '/app'))) return no('docker', 'docker');
    return no('source', 'source', { assetName: ZIP_ASSET });
}

module.exports = { detectInstallMode, detectSupervisor };
