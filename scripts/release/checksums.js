#!/usr/bin/env node
// node scripts/release/checksums.js <ordner> [--verify] [--complete]
// Writes <ordner>/SHA256SUMS.txt for every file in the folder (format of sha256sum: "<hex>  <name>", sorted), or with
// --verify checks the folder against it (`sha256sum -c SHA256SUMS.txt` does the same).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SUMS_NAME: SUMS_FILE, BUNDLE_NAME: BUNDLE_FILE } = require('../../services/update/constants');

const UNLISTED = new Set([SUMS_FILE, BUNDLE_FILE]);

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
        .filter(e => e.isFile() && !UNLISTED.has(e.name) && !e.name.startsWith('.'))
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

/** Names whose hash differs or that are missing; extra files in the folder are an error only with `complete`. */
function verifyChecksums(dir, { complete = false } = {}) {
    const problems = [];
    const listed = new Set();
    for (const line of fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8').split('\n').filter(Boolean)) {
        const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
        if (!m) {
            problems.push(`unlesbare Zeile: ${line}`);
            continue;
        }
        listed.add(m[2]);
        const file = path.join(dir, m[2]);
        if (!fs.existsSync(file)) problems.push(`fehlt: ${m[2]}`);
        else if (sha256File(file) !== m[1]) problems.push(`Prüfsumme falsch: ${m[2]}`);
    }
    if (complete) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isFile() && !e.name.startsWith('.') && !listed.has(e.name) && !UNLISTED.has(e.name)) problems.push(`nicht aufgeführt: ${e.name}`);
        }
    }
    return problems;
}

if (require.main === module) {
    const [dir, ...flags] = process.argv.slice(2);
    const verify = flags[0] === '--verify';
    const complete = verify && flags[1] === '--complete';
    if (!dir || dir.startsWith('-') || flags.length > Number(verify) + Number(complete)) {
        process.stderr.write('Aufruf: node scripts/release/checksums.js <ordner> [--verify [--complete]]\n');
        process.exit(2);
    }
    try {
        if (verify) {
            const problems = verifyChecksums(dir, { complete });
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

module.exports = { sha256File, checksumLines, writeChecksums, verifyChecksums, SUMS_FILE, BUNDLE_FILE };
