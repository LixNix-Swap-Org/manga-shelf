/* global VERSION, DB_CHECK_EXIT, VERSION_EXIT, DELAY_MS */
const fs = require('fs');

if (DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DELAY_MS);
const [command, file] = process.argv.slice(2);
if (command === 'version') {
    process.stdout.write(`manga-shelf-server v${VERSION} (Node ${process.version}, ${process.platform}-${process.arch})\n`);
    process.exit(VERSION_EXIT);
} else if (command === 'db-check') {
    let ok;
    try {
        ok = fs.readFileSync(file).subarray(0, 15).toString('latin1') === 'SQLite format 3';
    } catch (e) {
        ok = false;
    }
    process.exit(ok ? DB_CHECK_EXIT : 1);
} else {
    process.exit(2);
}
