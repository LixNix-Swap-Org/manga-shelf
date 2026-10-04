#!/usr/bin/env node
// Console commands without the interactive console, e.g. `docker exec manga-shelf node scripts/admin.js passwort-reset Kim`.
const path = require('path');

if (process.env.MANGA_SHELF_NO_LISTEN !== '1') require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

async function main(argv) {
    const { runCommand } = require('../services/console');
    const line = argv.join(' ').trim() || 'hilfe';
    const { ok } = await runCommand(line, (text) => process.stdout.write(text + '\n'));
    return ok ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => {
    try { require('../db').closeDb(); } catch (e) { /* not opened */ }
    process.exitCode = code;
}, (err) => {
    process.stderr.write(`Fehler: ${err.message}\n`);
    process.exitCode = 1;
});
