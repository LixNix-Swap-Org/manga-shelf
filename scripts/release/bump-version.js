#!/usr/bin/env node
// node scripts/release/bump-version.js <patch|minor|major|none|X.Y.Z> [--write] [--root <dir>]
// Prints the target version; --write sets it in package.json/package-lock.json of the server, frontend/, desktop/ and
// mobile/ (plus the native mobile projects via mobile/scripts/sync-version.js). In GitHub Actions the result also goes to $GITHUB_OUTPUT (version, tag).
const fs = require('fs');
const path = require('path');
const { resolveTargetVersion, readVersion, writeVersion, syncMobileVersion, tagFor } = require('./version');

function main(argv, env = process.env) {
    let root = path.join(__dirname, '..', '..');
    let write = false;
    let bump = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--write') write = true;
        else if (argv[i] === '--root') root = path.resolve(argv[++i] || '.');
        else if (!bump) bump = argv[i];
        else throw new Error(`Unerwartetes Argument "${argv[i]}"`);
    }
    const current = readVersion(root);
    const version = resolveTargetVersion(bump, current, { allowNone: true });
    const changed = write ? writeVersion(root, version) : [];
    if (write && syncMobileVersion(root)) changed.push('mobile (native Projekte)');
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `version=${version}\ntag=${tagFor(version)}\nprevious=${current}\n`);
    return { version, current, changed };
}

if (require.main === module) {
    try {
        const { version, changed } = main(process.argv.slice(2));
        process.stdout.write(version + '\n');
        if (changed.length) process.stderr.write(`Version gesetzt in: ${changed.join(', ')}\n`);
    } catch (e) {
        process.stderr.write(e.message + '\n');
        process.exitCode = 1;
    }
}

module.exports = { main };
