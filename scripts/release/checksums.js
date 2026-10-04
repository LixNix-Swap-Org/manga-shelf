#!/usr/bin/env node
// node scripts/release/checksums.js <ordner> [--verify]
// Writes <ordner>/SHA256SUMS.txt for every file in the folder (format of sha256sum: "<hex>  <name>", sorted), or with
// --verify checks the folder against it (`sha256sum -c SHA256SUMS.txt` does the same).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUMS_FILE = 'SHA256SUMS.txt';

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    try {
        let n;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function checksumLines(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name !== SUMS_FILE && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort()
        .map(name => `${sha256File(path.join(dir, name))}  ${name}`);
}

function writeChecksums(dir) {
    const lines = checksumLines(dir);
    if (!lines.length) throw new Error(`Keine Dateien in ${dir}`);
    fs.writeFileSync(path.join(dir, SUMS_FILE), lines.join('\n') + '\n');
    return lines;
}

/** Names whose hash differs or that are missing; extra files in the folder are not an error. */
function verifyChecksums(dir) {
    const problems = [];
    for (const line of fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8').split('\n').filter(Boolean)) {
        const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
        if (!m) {
            problems.push(`unlesbare Zeile: ${line}`);
            continue;
        }
        const file = path.join(dir, m[2]);
        if (!fs.existsSync(file)) problems.push(`fehlt: ${m[2]}`);
        else if (sha256File(file) !== m[1]) problems.push(`Prüfsumme falsch: ${m[2]}`);
    }
    return problems;
}

if (require.main === module) {
    const [dir, flag] = process.argv.slice(2);
    if (!dir) {
        process.stderr.write('Aufruf: node scripts/release/checksums.js <ordner> [--verify]\n');
        process.exit(2);
    }
    try {
        if (flag === '--verify') {
            const problems = verifyChecksums(dir);
            if (problems.length) throw new Error(problems.join('\n'));
            process.stdout.write('Alle Prüfsummen stimmen.\n');
        } else {
            process.stdout.write(writeChecksums(dir).join('\n') + '\n');
        }
    } catch (e) {
        process.stderr.write(e.message + '\n');
        process.exitCode = 1;
    }
}

module.exports = { sha256File, checksumLines, writeChecksums, verifyChecksums, SUMS_FILE };
