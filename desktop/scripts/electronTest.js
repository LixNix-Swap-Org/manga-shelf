#!/usr/bin/env node
// Runs test/electron/run.js inside Electron (net.request and sessions need the real runtime); Linux CI under xvfb-run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { electronCommand } = require('./smoke');

const DESKTOP = path.resolve(__dirname, '..');
const LIMIT_MS = 120000;

/** Exit code of the launcher: 0 only for a child that ended by itself with code 0. */
const exitCodeOf = ({ code, signal, killed }) => (killed || signal || code !== 0 ? 1 : 0);

function main() {
    const binary = require('electron');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-electron-test-'));
    const { command, args } = electronCommand(binary, [path.join(DESKTOP, 'test', 'electron', 'run.js'), `--user-data-dir=${userData}`]);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, args, { stdio: 'inherit', env, cwd: DESKTOP });
    let killed = false;
    const timer = setTimeout(() => {
        killed = true;
        console.error(`[electron-test] nach ${LIMIT_MS / 1000} s abgebrochen`);
        child.kill('SIGKILL');
    }, LIMIT_MS);
    const finish = (code, signal) => {
        clearTimeout(timer);
        try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* still in use */ }
        process.exit(exitCodeOf({ code, signal, killed }));
    };
    child.on('exit', finish);
    child.on('error', (err) => {
        console.error(`[electron-test] ${err.message}`);
        finish(null, null);
    });
}

if (require.main === module) main();

module.exports = { exitCodeOf, LIMIT_MS };
