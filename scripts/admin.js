#!/usr/bin/env node
// Console commands without the interactive console, e.g. `docker exec -u node manga-shelf node scripts/admin.js passwort-reset Kim`.
const path = require('path');

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

async function main(argv) {
    const { runCommand } = require('../services/console');
    const line = argv.join(' ').trim() || 'hilfe';
    const { ok } = await runCommand(line, (text) => process.stdout.write(text + '\n'), {
        readSecret: (prompt) => ask(prompt, { hidden: true }),
        readLine: (prompt) => ask(prompt)
    });
    return ok ? 0 : 1;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => {
        try { require('../db').closeDb(); } catch (e) { /* not opened */ }
        process.exitCode = code;
    }, (err) => {
        process.stderr.write(`Fehler: ${err.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { ask, readStdin, main };
