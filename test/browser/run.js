#!/usr/bin/env node
/**
 * Runs a browser test against an ISOLATED server: temporary data folder, free port, throw-away admin account.
 * The browser tests create, edit, delete and restore data, so they must never be pointed at a real instance.
 *
 *   node test/browser/run.js test/browser/e2e-suite.js
 *   node test/browser/run.js test/browser/performance-suite.js --db path/to/manga.db   # start from a COPY of a database
 *
 * Needs a built frontend (npm run build:frontend) and Chrome/Chromium/Edge (CHROME_BIN overrides the lookup).
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
    const args = { script: null, db: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--db') args.db = argv[++i];
        else if (!args.script) args.script = argv[i];
    }
    return args;
}

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

async function waitForHealth(base, server) {
    for (let i = 0; i < 60; i++) {
        if (server.exitCode !== null) throw new Error('The test server exited early (exit code ' + server.exitCode + ')');
        try {
            const res = await fetch(base + '/api/health');
            if (res.ok) return;
        } catch (e) { /* not up yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('The test server did not become healthy in time');
}

async function main() {
    const { script, db } = parseArgs(process.argv.slice(2));
    if (!script) {
        console.error('Usage: node test/browser/run.js <script.js> [--db <manga.db>]');
        process.exit(2);
    }
    if (!fs.existsSync(path.join(root, 'frontend', 'dist', 'index.html'))) {
        console.error('frontend/dist is missing. Run `npm run build:frontend` first.');
        process.exit(2);
    }

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-browser-'));
    const username = 'e2e-admin';
    const password = crypto.randomBytes(12).toString('hex');
    let server = null;
    let exitCode = 1;

    try {
        if (db) {
            // work on a copy: the original database is never opened by the test server
            fs.copyFileSync(path.resolve(db), path.join(dataDir, 'manga.db'));
            const { DatabaseSync } = require('node:sqlite');
            const bcrypt = require('bcryptjs');
            const copy = new DatabaseSync(path.join(dataDir, 'manga.db'));
            copy.prepare("INSERT OR REPLACE INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
                .run(username, bcrypt.hashSync(password, 10));
            copy.close();
        }

        const port = await freePort();
        const base = `http://127.0.0.1:${port}`;
        server = spawn(process.execPath, ['index.js'], {
            cwd: root,
            env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), LOG_LEVEL: 'warn' },
            stdio: ['ignore', 'ignore', 'inherit']
        });
        await waitForHealth(base, server);

        if (!db) {
            const res = await fetch(base + '/api/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            if (!res.ok) throw new Error('Creating the test admin failed: ' + res.status);
        }

        console.log(`[browser tests] isolated server on ${base}${db ? ' (copy of ' + path.basename(db) + ')' : ' (empty database)'}`);
        exitCode = await new Promise((resolve) => {
            const child = spawn(process.execPath, [path.resolve(script)], {
                cwd: root,
                env: { ...process.env, BASE_URL: base, E2E_USER: username, E2E_PASSWORD: password },
                stdio: 'inherit'
            });
            child.on('exit', code => resolve(code === null ? 1 : code));
        });
    } catch (err) {
        console.error('[browser tests] ' + err.message);
    } finally {
        if (server && server.exitCode === null) {
            server.kill();
            await new Promise(r => setTimeout(r, 300));
        }
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    process.exit(exitCode);
}

main();
