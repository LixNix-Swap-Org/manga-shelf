#!/usr/bin/env node
/**
 * node release.js <patch|minor|major|X.Y.Z|vX.Y.Z> [--dry-run]: sets the next version in every package.json,
 * lockfile and native mobile project of a clean tree, without commit, tag or push; --dry-run only shows changes.
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveTargetVersion, compareVersions, readVersion, versionFiles, writeVersion, syncMobileVersion, tagFor } = require('./scripts/release/version');

const ROOT = __dirname;
const ACTIONS_HINT = [
    'Veröffentlicht wird im Actions-Tab von GitHub: Actions → „Release“ → „Run workflow“,',
    'Branch wählen, action = release, bump = patch | minor | major (oder none, wenn die Version schon gesetzt ist).',
    'Der Workflow setzt die Version, legt Commit und Tag an, baut alles und veröffentlicht den Release.'
].join('\n');

/** Paths from `git status --porcelain` output that are not in `allowed`. */
function getReleaseBlockers(porcelain, allowed = []) {
    return String(porcelain || '')
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
            const p = line.slice(3);
            const arrow = p.indexOf(' -> ');
            return (arrow === -1 ? p : p.slice(arrow + 4)).replace(/^"|"$/g, '');
        })
        .filter(p => !allowed.includes(p));
}

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tagExists(tag) {
    try {
        git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
        return true;
    } catch (e) {
        return false;
    }
}

function main(argv, out = (text) => process.stdout.write(text + '\n')) {
    const dryRun = argv.includes('--dry-run');
    const args = argv.filter(a => a !== '--dry-run');
    const current = readVersion(ROOT);
    const version = resolveTargetVersion(args[0], current);
    const tag = tagFor(version);
    const files = versionFiles(ROOT);
    out(`Version ${current} → ${version} (${tag})`);
    if (dryRun) {
        out(`Probelauf, nichts geändert. Betroffene Dateien: ${files.join(', ')}`);
        out(ACTIONS_HINT);
        return 0;
    }
    const dirty = getReleaseBlockers(git(['status', '--porcelain', '--untracked-files=all']));
    if (dirty.length) throw new Error(`Arbeitsverzeichnis nicht sauber, bitte zuerst committen oder entfernen:\n  ${dirty.join('\n  ')}`);
    if (tagExists(tag)) throw new Error(`Tag ${tag} existiert bereits.`);
    const changed = writeVersion(ROOT, version);
    if (syncMobileVersion(ROOT)) changed.push('mobile/android/app/build.gradle', 'mobile/ios/App/App.xcodeproj/project.pbxproj');
    out(`Version gesetzt in: ${changed.join(', ')}`);
    out(`Weiter: git commit -am "${tag}" && git push`);
    out(ACTIONS_HINT.replace('bump = patch | minor | major (oder none, wenn die Version schon gesetzt ist)', 'bump = none'));
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(`\nAbgebrochen: ${err.message}\n\n${ACTIONS_HINT}\n`);
        process.exitCode = 1;
    }
}

module.exports = { main, resolveTargetVersion, getReleaseBlockers, compareVersions, ACTIONS_HINT, ROOT: path.resolve(ROOT) };
