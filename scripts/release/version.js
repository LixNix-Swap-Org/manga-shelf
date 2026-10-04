// Version numbers of a release: one version for the server, the frontend, the desktop app and the mobile apps.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PACKAGE_DIRS = ['.', 'frontend', 'desktop', 'mobile'];
const USAGE = 'Aufruf: <patch|minor|major|none|X.Y.Z|vX.Y.Z>';

function parseVersion(value) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
    return m ? m.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
}

/** Target version for a bump argument; `none` (only with allowNone) keeps the current one. German errors. */
function resolveTargetVersion(arg, current, { allowNone = false } = {}) {
    if (!arg || !String(arg).trim()) throw new Error(`Keine Version angegeben. ${USAGE}`);
    const cur = parseVersion(current);
    if (!cur) throw new Error(`Aktuelle Version in package.json ist ungültig: "${current}"`);
    const raw = String(arg).trim();
    if (raw === 'none') {
        if (!allowNone) throw new Error(`"none" gibt es nur im Release-Workflow. ${USAGE}`);
        return current;
    }
    let target;
    if (raw === 'patch') target = `${cur[0]}.${cur[1]}.${cur[2] + 1}`;
    else if (raw === 'minor') target = `${cur[0]}.${cur[1] + 1}.0`;
    else if (raw === 'major') target = `${cur[0] + 1}.0.0`;
    else {
        target = raw.replace(/^v/, '');
        if (!parseVersion(target)) throw new Error(`Ungültige Version "${raw}". ${USAGE}`);
    }
    if (compareVersions(target, current) <= 0) {
        throw new Error(`Version ${target} ist nicht größer als die aktuelle Version ${current}.`);
    }
    return target;
}

function readVersion(root) {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

/** package.json and package-lock.json of every package that exists (relative, forward slashes). */
function versionFiles(root) {
    const files = [];
    for (const dir of PACKAGE_DIRS) {
        for (const name of ['package.json', 'package-lock.json']) {
            const rel = dir === '.' ? name : `${dir}/${name}`;
            if (fs.existsSync(path.join(root, rel))) files.push(rel);
        }
    }
    return files;
}

function setVersionInJson(text, version) {
    const data = JSON.parse(text);
    const indent = (/^[ \t]+(?=")/m.exec(text) || ['  '])[0];
    data.version = version;
    if (data.packages && data.packages['']) data.packages[''].version = version;
    return JSON.stringify(data, null, indent) + (text.endsWith('\n') ? '\n' : '');
}

/** Writes `version` into every version file; returns the files that changed. */
function writeVersion(root, version) {
    if (!parseVersion(version)) throw new Error(`Ungültige Version "${version}"`);
    const changed = [];
    for (const rel of versionFiles(root)) {
        const file = path.join(root, rel);
        const before = fs.readFileSync(file, 'utf8');
        const after = setVersionInJson(before, version);
        if (after !== before) {
            fs.writeFileSync(file, after);
            changed.push(rel);
        }
    }
    return changed;
}

const tagFor = (version) => `v${version}`;

const MOBILE_SYNC = 'mobile/scripts/sync-version.js';

/** The native projects (build.gradle, project.pbxproj) carry the version too; mobile/ has the script that sets it. */
function syncMobileVersion(root) {
    const script = path.join(root, ...MOBILE_SYNC.split('/'));
    if (!fs.existsSync(script)) return false;
    execFileSync(process.execPath, [script], { cwd: path.dirname(script), stdio: ['ignore', 'ignore', 'inherit'] });
    return true;
}

module.exports = { parseVersion, compareVersions, resolveTargetVersion, readVersion, versionFiles, writeVersion, setVersionInJson, syncMobileVersion, tagFor, PACKAGE_DIRS, USAGE, MOBILE_SYNC };
