#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const verify = require('../../services/update/verify');
const { SUMS_NAME, BUNDLE_NAME, MARKER_PATTERN } = require('../../services/update/constants');
const { sha256File } = require('./checksums');

/** Resolves { version, identity, log_index, files } or throws with every problem found. */
async function verifyReleaseDir(dir, { verifier = verify.createVerifier(), tufCachePath } = {}) {
    const sumsBytes = fs.readFileSync(path.join(dir, SUMS_NAME));
    const bundleJson = fs.readFileSync(path.join(dir, BUNDLE_NAME));
    const markers = fs.readdirSync(dir).filter((name) => MARKER_PATTERN.test(name));
    if (markers.length !== 1) throw new Error(`Genau eine Versionsmarke erwartet, gefunden: ${markers.length}`);
    const markerBytes = fs.readFileSync(path.join(dir, markers[0]));
    let version;
    try {
        version = JSON.parse(markerBytes.toString('utf8')).version;
    } catch (e) {
        throw new Error(`${markers[0]} ist kein JSON`, { cause: e });
    }
    const result = await verifier.verifySums({ sumsBytes, bundleJson, version, markerBytes, tufCachePath });
    const problems = [];
    for (const [name, hex] of result.sums) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) problems.push(`fehlt: ${name}`);
        else if (sha256File(file) !== hex) problems.push(`Prüfsumme falsch: ${name}`);
    }
    if (problems.length) throw new Error(problems.join('\n'));
    return { version, identity: result.identity, log_index: result.log_index, files: result.sums.size };
}

if (require.main === module) {
    const [dir, ...rest] = process.argv.slice(2);
    if (!dir || dir.startsWith('-') || rest.length) {
        process.stderr.write('Aufruf: node scripts/release/verify-bundle.js <ordner>\n');
        process.exit(2);
    }
    const tufCachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-tuf-'));
    verifyReleaseDir(dir, { tufCachePath })
        .then((r) => {
            process.stdout.write(`Signatur geprüft: v${r.version}, ${r.files} Dateien, ${r.identity}, Log-Index ${r.log_index}\n`);
        })
        .catch((e) => {
            process.stderr.write(`${e.code ? `${e.code}: ` : ''}${e.message}\n`);
            process.exitCode = 1;
        })
        .finally(() => fs.rmSync(tufCachePath, { recursive: true, force: true }));
}

module.exports = { verifyReleaseDir };
