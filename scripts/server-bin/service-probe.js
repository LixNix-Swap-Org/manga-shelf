#!/usr/bin/env node
// CI probe of install-service on a throwaway runner (needs root / an elevated prompt): installs the service, waits for
// /api/health, checks account and permissions, removes the service again. The data folder stays (like for users).
//   node scripts/server-bin/service-probe.js <binary> [--port 3123]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acl = require('./acl');
const services = require('./services');

const log = (text) => process.stdout.write(text + '\n');
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

async function waitForHealth(port, seconds = 90) {
    for (let i = 0; i < seconds; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) return;
        } catch (e) { /* not up yet */ }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`/api/health auf Port ${port} antwortet nicht`);
}

function checkWindows(dataDir) {
    const task = sh(acl.systemTool('schtasks.exe'), ['/Query', '/TN', services.WINDOWS_TASK, '/XML']);
    if (!/<UserId>S-1-5-19<\/UserId>/.test(task)) throw new Error('Die Aufgabe läuft nicht als LOCAL SERVICE');
    for (const target of [dataDir, path.join(dataDir, 'secret.key'), path.join(dataDir, 'logs', 'manga-shelf.log')]) {
        if (!fs.existsSync(target)) throw new Error(`${target} fehlt`);
        const problem = acl.serviceAclProblem(acl.readWindowsSecurity(target), acl.SID.LOCAL_SERVICE);
        if (problem) throw new Error(`${target}: ${problem}`);
        log(`ACL ok: ${target}`);
    }
}

function checkLinux(dataDir) {
    const mode = (file) => fs.statSync(file).mode & 0o777;
    if (mode(dataDir) !== 0o750) throw new Error(`${dataDir} hat ${mode(dataDir).toString(8)} statt 750`);
    const db = path.join(dataDir, 'manga.db');
    if (mode(db) & 0o007) throw new Error(`manga.db ist für alle lesbar (${mode(db).toString(8)})`);
    if (!/^UMask=0027$/m.test(fs.readFileSync('/etc/systemd/system/manga-shelf.service', 'utf8'))) throw new Error('UMask fehlt in der Unit');
    log(`Rechte ok: ${dataDir} 750, manga.db ${mode(db).toString(8)}`);
}

async function probe(binary, { port = 3123 } = {}) {
    const exe = path.resolve(binary);
    const win = process.platform === 'win32';
    sh(exe, ['install-service', '--port', String(port)]);
    try {
        await waitForHealth(port);
        log(`/api/health: 200 (Port ${port})`);
        if (win) checkWindows(path.join(process.env.ProgramData || 'C:\\ProgramData', 'manga-shelf', 'data'));
        else checkLinux(services.SYSTEM_DATA_DIR);
    } finally {
        const installed = win ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Manga Shelf Server', 'manga-shelf-server.exe') : exe;
        sh(installed, ['uninstall-service']);
    }
    return true;
}

module.exports = { probe };

if (require.main === module) {
    const args = process.argv.slice(2);
    const portAt = args.indexOf('--port');
    probe(args[0], { port: portAt === -1 ? 3123 : Number(args[portAt + 1]) }).then(() => log('Dienst-Probe ok'), (err) => {
        process.stderr.write(`Dienst-Probe fehlgeschlagen: ${err.message}\n`);
        process.exit(1);
    });
}
