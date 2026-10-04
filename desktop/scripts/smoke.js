#!/usr/bin/env node
// CI smoke test of the unpacked app (after `npm run build:dir`): start it with --server-only on a free port and a
// temporary data folder, wait for /api/health and the portal page, then end it like a service manager (SIGTERM).
// Linux without a display runs it under xvfb-run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const OUT = path.resolve(__dirname, '..', 'dist', 'installers');

/** The executable inside electron-builder's unpacked output for `platform`, or null. */
function findUnpackedBinary(outDir, platform = process.platform) {
    let entries;
    try { entries = fs.readdirSync(outDir); } catch (_) { return null; }
    const candidates = [];
    for (const dir of entries) {
        if (platform === 'darwin' && /^mac/.test(dir)) candidates.push(path.join(outDir, dir, 'Manga Shelf.app', 'Contents', 'MacOS', 'Manga Shelf'));
        if (platform === 'win32' && /^win.*-unpacked$/.test(dir)) candidates.push(path.join(outDir, dir, 'Manga Shelf.exe'));
        if (platform === 'linux' && /^linux.*-unpacked$/.test(dir)) candidates.push(path.join(outDir, dir, 'manga-shelf'));
    }
    return candidates.find((file) => fs.existsSync(file)) || null;
}

/** Command and arguments for the smoke start (xvfb-run and --no-sandbox on Linux CI). */
function smokeCommand(binary, { port, dataDir, userDataDir, platform = process.platform, env = process.env }) {
    const args = ['--server-only', '--port', String(port), '--data-dir', dataDir, `--user-data-dir=${userDataDir}`];
    if (platform === 'linux') {
        args.push('--no-sandbox');
        if (!env.DISPLAY) return { command: 'xvfb-run', args: ['-a', binary, ...args] };
    }
    return { command: binary, args };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const binary = findUnpackedBinary(OUT);
    if (!binary) throw new Error(`Keine entpackte App in ${OUT} (erst "npm run build:dir")`);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-smoke-'));
    const port = 39000 + Math.floor(Math.random() * 1000);
    const { command, args } = smokeCommand(binary, { port, dataDir: path.join(temp, 'data'), userDataDir: path.join(temp, 'user') });
    console.log(`[smoke] ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { stdio: 'inherit' });
    let exit = null;
    child.on('exit', (code, signal) => { exit = { code, signal }; });
    const base = `http://127.0.0.1:${port}`;
    try {
        let health = null;
        for (let i = 0; i < 120 && !exit && !health; i++) {
            await sleep(500);
            try {
                const res = await fetch(`${base}/api/health`);
                if (res.ok) health = await res.json();
            } catch (_) { /* not up yet */ }
        }
        if (!health) throw new Error(exit ? `App beendet (${JSON.stringify(exit)})` : 'Keine Antwort von /api/health nach 60 s');
        if (health.name !== 'Manga Shelf') throw new Error(`Unerwartete Antwort: ${JSON.stringify(health)}`);
        const page = await fetch(`${base}/`);
        const html = await page.text();
        if (!page.ok || !html.includes('<div id="root">')) throw new Error(`GET / liefert kein Portal (${page.status})`);
        if (!fs.existsSync(path.join(temp, 'data', 'manga.db'))) throw new Error('manga.db fehlt im Datenordner');
        console.log(`[smoke] ok: ${health.name} ${health.version}, Portal ausgeliefert, Daten in ${path.join(temp, 'data')}`);
    } finally {
        if (!exit) child.kill('SIGTERM');
        for (let i = 0; i < 40 && !exit; i++) await sleep(250);
        if (!exit) child.kill('SIGKILL');
        try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* Windows may still hold a file */ }
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`[smoke] ${err.message}`);
        process.exit(1);
    });
}

module.exports = { findUnpackedBinary, smokeCommand };
