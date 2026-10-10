#!/usr/bin/env node
// Console commands without the interactive console, e.g. `docker exec -u node manga-shelf node scripts/admin.js passwort-reset Kim`.
const updatePrelude = (() => {
    try {
        return require('../services/update/prelude');
    } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
    for (const candidate of ['../.update/previous/services/update/prelude', '../.update/next/services/update/prelude']) {
        try {
            return require(candidate);
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') throw e;
        }
    }
    return null;
})();
const path = require('path');
const codeDir = path.join(__dirname, '..');
if (updatePrelude) updatePrelude.run({ dataDir: updatePrelude.resolveDataDir({ codeDir, cwd: codeDir }), codeDir, server: false });

if (process.env.MANGA_SHELF_NO_LISTEN !== '1') require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

/** Reads all of stdin (a key piped in by a script). */
function readStdin(input = process.stdin) {
    return new Promise((resolve, reject) => {
        let text = '';
        input.setEncoding('utf8');
        input.on('data', (chunk) => { text += chunk; });
        input.on('end', () => resolve(text));
        input.on('error', reject);
    });
}

/** Asks on the terminal; `hidden` mutes the echo (the typed key never appears and no history is kept). */
function ask(prompt, { hidden = false, input = process.stdin, output = process.stdout } = {}) {
    if (!input.isTTY) return hidden ? readStdin(input).then((text) => text.split(/\r?\n/)[0]) : Promise.resolve('');
    const readline = require('readline');
    const { Writable } = require('stream');
    let muted = false;
    const sink = new Writable({
        write(chunk, encoding, callback) {
            if (!muted) output.write(chunk);
            callback();
        }
    });
    const rl = readline.createInterface({ input, output: sink, terminal: true, historySize: 0 });
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            if (hidden) output.write('\n');
            resolve(answer);
        });
        muted = hidden;
    });
}

const OFFLINE_USAGE = {
    'db-check': 'Aufruf: node scripts/admin.js db-check <datei>',
    wiederherstellen: 'Aufruf: node scripts/admin.js wiederherstellen <backup.zip> [--allow-newer-schema] (nur bei gestopptem Server)'
};

/** db-check <file> and wiederherstellen <zip>: never through the console, the second one only while the server is stopped. */
function offlineCommand([command, ...rest], out = (text) => process.stdout.write(text + '\n')) {
    const allowNewerSchema = rest.includes('--allow-newer-schema');
    const files = rest.filter((arg) => arg !== '--allow-newer-schema');
    if (files.length !== 1 || (allowNewerSchema && command !== 'wiederherstellen')) {
        out(OFFLINE_USAGE[command]);
        return Promise.resolve(2);
    }
    const offline = require('../services/restoreOffline');
    return command === 'db-check' ? offline.dbCheck(files[0], { out }) : offline.restoreOffline(files[0], { allowNewerSchema, out });
}

async function main(argv) {
    if (Object.prototype.hasOwnProperty.call(OFFLINE_USAGE, argv[0])) return offlineCommand(argv);
    const { runCommand } = require('../services/console');
    const line = argv.join(' ').trim() || 'hilfe';
    const { ok } = await runCommand(line, (text) => process.stdout.write(text + '\n'), {
        readSecret: (prompt) => ask(prompt, { hidden: true }),
        readLine: (prompt) => ask(prompt)
    });
    return ok ? 0 : 1;
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    main(argv).then((code) => {
        if (argv[0] !== 'db-check') {
            try { require('../db').closeDb(); } catch (e) { /* not opened */ }
        }
        process.exitCode = code;
    }, (err) => {
        process.stderr.write(`Fehler: ${err.message}\n`);
        process.exitCode = err && err.code === 'SCHEMA_NEWER' ? err.exitCode : 1;
    });
}

module.exports = { ask, readStdin, main, offlineCommand };
