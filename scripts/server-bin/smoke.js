#!/usr/bin/env node
// Smoke test of a server binary (or of the plain bundle server.cjs): --version, the status command, then a start
// with a temporary data folder: /api/health, the portal at / and an API route must answer.
//   node scripts/server-bin/smoke.js <binary|server.cjs> [--port 0]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const log = (text) => process.stdout.write(text + '\n');

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function command(target) {
    const abs = path.resolve(target);
    return /\.c?js$/.test(abs) ? { cmd: process.execPath, pre: [abs] } : { cmd: abs, pre: [] };
}

async function get(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, text: await res.text() };
}

async function smoke(target, { port } = {}) {
    const { cmd, pre } = command(target);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-smoke-'));
    const env = { ...process.env, MANGA_SHELF_CACHE_DIR: path.join(tmp, 'cache'), LOG_LEVEL: 'warn' };
    for (const name of ['DATA_DIR', 'PORT', 'SERVER_PORT', 'MANGA_SHELF_NO_LISTEN', 'FRONTEND_DIR']) delete env[name];
    const dataDir = path.join(tmp, 'data');
    const run = (args) => spawnSync(cmd, [...pre, ...args], { env, encoding: 'utf8', timeout: 180000 });
    let child = null;
    try {
        const version = run(['--version']);
        if (version.status !== 0 || !/^manga-shelf-server v\d+\.\d+\.\d+/.test(version.stdout)) throw new Error(`--version: ${version.stdout}${version.stderr}`);
        log(version.stdout.trim());

        const status = run(['status', '--data-dir', dataDir]);
        if (status.status !== 0 || !/Manga Shelf v\d/.test(status.stdout)) throw new Error(`status: ${status.stdout}${status.stderr}`);
        log('status: ok');

        const p = port || await freePort();
        let output = '';
        child = spawn(cmd, [...pre, '--port', String(p), '--host', '127.0.0.1', '--data-dir', dataDir, '--no-console', '--log-file'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        const base = `http://127.0.0.1:${p}`;
        let healthy = false;
        const attempts = Math.max(1, Number(process.env.SMOKE_TIMEOUT_S) || 60) * 2;
        for (let i = 0; i < attempts && !healthy; i++) {
            if (child.exitCode !== null) throw new Error(`Server beendet (${child.exitCode}): ${output}`);
            try { healthy = (await get(`${base}/api/health`)).status === 200; } catch (e) { /* not yet */ }
            if (!healthy) await new Promise(r => setTimeout(r, 500));
        }
        if (!healthy) throw new Error(`/api/health antwortet nicht: ${output}`);
        log('/api/health: 200');
        const page = await get(`${base}/`);
        if (page.status !== 200 || !/<div id="root"/.test(page.text)) throw new Error(`GET / lieferte ${page.status} ohne Portal`);
        log('/: Portal');
        const asset = /\/assets\/[^"']+\.js/.exec(page.text);
        if (!asset || (await get(base + asset[0])).status !== 200) throw new Error(`Skript des Portals nicht abrufbar (${asset && asset[0]})`);
        log(`${asset[0]}: 200`);
        const setup = await get(`${base}/api/setup/status`);
        if (setup.status !== 200) throw new Error(`/api/setup/status: ${setup.status}`);
        log('/api/setup/status: 200');
        if (!fs.existsSync(path.join(dataDir, 'logs', 'manga-shelf.log'))) throw new Error('--log-file schrieb keine Logdatei');
        log('Logdatei: ok');
        return true;
    } finally {
        if (child && child.exitCode === null) {
            child.kill('SIGTERM');
            await new Promise((resolve) => {
                const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 15000);
                child.on('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
}

if (require.main === module) {
    const [target, ...rest] = process.argv.slice(2);
    if (!target) {
        process.stderr.write('Aufruf: node scripts/server-bin/smoke.js <binary|server.cjs> [--port N]\n');
        process.exit(2);
    }
    const portIndex = rest.indexOf('--port');
    smoke(target, { port: portIndex === -1 ? 0 : Number(rest[portIndex + 1]) }).then(() => log('Smoke-Test bestanden'), (e) => {
        process.stderr.write(`Smoke-Test fehlgeschlagen: ${e.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { smoke };
