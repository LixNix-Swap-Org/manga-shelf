#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { tagFor } = require('./version');
const { SUMS_NAME: SUMS_FILE, markerName, MARKER_PATTERN } = require('../../services/update/constants');

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** Writes the version marker into `dir` and returns { name, file, data }; refuses anything that would leave two markers or an unsigned one. */
function writeMarker(dir, { version, commit, builtAt = new Date() }) {
    if (!VERSION_RE.test(String(version))) throw new Error(`Ungültige Version "${version}" (erwartet X.Y.Z)`);
    if (!COMMIT_RE.test(String(commit))) throw new Error(`Ungültiger Commit "${commit}" (erwartet 40 Hex-Zeichen)`);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Ordner fehlt: ${dir}`);
    if (fs.existsSync(path.join(dir, SUMS_FILE))) throw new Error(`${SUMS_FILE} existiert schon; die Marke muss vor checksums.js entstehen`);
    const existing = fs.readdirSync(dir).filter(name => MARKER_PATTERN.test(name));
    if (existing.length) throw new Error(`Es gibt schon eine Versionsmarke: ${existing.join(', ')}`);
    const data = { version, tag: tagFor(version), commit, built_at: builtAt.toISOString().replace(/\.\d{3}Z$/, 'Z') };
    const name = markerName(version);
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
    return { name, file, data };
}

if (require.main === module) {
    const [dir, version, commit] = process.argv.slice(2);
    if (!dir || !version || !commit) {
        process.stderr.write('Aufruf: node scripts/release/marker.js <ordner> <X.Y.Z> <commit>\n');
        process.exit(2);
    }
    try {
        process.stdout.write(writeMarker(dir, { version, commit }).name + '\n');
    } catch (e) {
        process.stderr.write(e.message + '\n');
        process.exitCode = 1;
    }
}

module.exports = { writeMarker, markerName, MARKER_PATTERN };
