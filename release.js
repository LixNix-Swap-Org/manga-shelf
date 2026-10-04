#!/usr/bin/env node
/**
 * Release: node release.js <patch|minor|major|X.Y.Z|vX.Y.Z>
 * Every check runs before anything is written: version, branch main in sync with origin, clean tree, tag and
 * GitHub release not existing yet, gh signed in, lint and tests. Then the version is bumped (package.json and
 * package-lock.json in root and frontend/), the ZIP is built, exactly those four files are committed, commit and
 * tag are pushed atomically and the GitHub release is created with the ZIP.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const RELEASE_BRANCH = 'main';
const VERSION_FILES = ['package.json', 'package-lock.json', 'frontend/package.json', 'frontend/package-lock.json'];
const ZIP_NAME = 'pterodactyl-manga-shelf.zip';
const USAGE = 'Aufruf: node release.js <patch|minor|major|X.Y.Z|vX.Y.Z>';

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

/** Target version for a release argument; throws with a German message for anything that is not a real step up. */
function resolveTargetVersion(arg, current) {
  if (!arg || !String(arg).trim()) throw new Error(`Keine Version angegeben. ${USAGE}`);
  const cur = parseVersion(current);
  if (!cur) throw new Error(`Aktuelle Version in package.json ist ungültig: "${current}"`);
  const raw = String(arg).trim();
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

function run(cmd, args, options = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: cmd === 'npm' && process.platform === 'win32',
    ...options
  });
}

function output(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// untrimmed: the first porcelain line starts with a status column that may be a space
function gitStatus() {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' });
}

function succeeds(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function preflight(tag) {
  const branch = output('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== RELEASE_BRANCH) {
    throw new Error(`Releases nur auf "${RELEASE_BRANCH}" (aktueller Branch: "${branch}").`);
  }
  const dirty = getReleaseBlockers(gitStatus());
  if (dirty.length) {
    throw new Error(`Arbeitsverzeichnis nicht sauber, bitte zuerst committen oder entfernen:\n  ${dirty.join('\n  ')}`);
  }
  run('git', ['fetch', 'origin', RELEASE_BRANCH]);
  if (!succeeds('git', ['merge-base', '--is-ancestor', `origin/${RELEASE_BRANCH}`, 'HEAD'])) {
    throw new Error(`Lokaler ${RELEASE_BRANCH} ist hinter origin/${RELEASE_BRANCH} oder weicht ab. Bitte zuerst pullen.`);
  }
  if (succeeds('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])) {
    throw new Error(`Tag ${tag} existiert lokal bereits.`);
  }
  if (output('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) {
    throw new Error(`Tag ${tag} existiert auf origin bereits. Veröffentlichte Tags werden nie verschoben.`);
  }
  if (!succeeds('gh', ['auth', 'status'])) {
    throw new Error('GitHub CLI nicht angemeldet oder nicht installiert (`gh auth login`).');
  }
  if (succeeds('gh', ['release', 'view', tag])) {
    throw new Error(`GitHub-Release ${tag} existiert bereits.`);
  }
}

function snapshotFiles() {
  const saved = new Map();
  for (const rel of VERSION_FILES) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) saved.set(rel, fs.readFileSync(abs));
  }
  return saved;
}

function restoreFiles(saved) {
  for (const [rel, content] of saved) fs.writeFileSync(path.join(ROOT, rel), content);
}

function bumpAndBuild(version, saved) {
  try {
    run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
    run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: path.join(ROOT, 'frontend') });
    console.log('📦 Baue Frontend und erzeuge die ZIP...');
    run('npm', ['run', 'package']);
    const zipPath = path.join(ROOT, ZIP_NAME);
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) throw new Error(`ZIP-Datei fehlt oder ist leer: ${zipPath}`);
    const extra = getReleaseBlockers(gitStatus(), VERSION_FILES);
    if (extra.length) throw new Error(`Der Build hat unerwartete Dateien verändert:\n  ${extra.join('\n  ')}`);
    return zipPath;
  } catch (err) {
    restoreFiles(saved);
    console.error('Versionsdateien wurden zurückgesetzt.');
    throw err;
  }
}

function commitAndTag(tag, saved) {
  const files = VERSION_FILES.filter(rel => fs.existsSync(path.join(ROOT, rel)));
  try {
    run('git', ['add', '--', ...files]);
    run('git', ['commit', '-m', `chore(release): ${tag}`, '--', ...files]);
  } catch (err) {
    restoreFiles(saved);
    succeeds('git', ['reset', '-q', '--', ...files]);
    throw new Error(`Commit fehlgeschlagen (Versionsdateien zurückgesetzt): ${err.message}`);
  }
  run('git', ['tag', '-a', tag, '-m', `Release ${tag}`]);
  try {
    run('git', ['push', '--atomic', 'origin', `HEAD:refs/heads/${RELEASE_BRANCH}`, `refs/tags/${tag}`]);
  } catch (err) {
    throw new Error(`Push fehlgeschlagen. Commit und Tag ${tag} liegen nur lokal; erneut mit: git push --atomic origin HEAD:${RELEASE_BRANCH} ${tag}`);
  }
}

function createGithubRelease(tag, zipPath) {
  const notesFile = path.join(ROOT, 'RELEASE_NOTES.tmp');
  const deployHint = `Laden Sie einfach die beigefügte \`${ZIP_NAME}\` auf Ihren Server bzw. Ihr Pterodactyl-Panel hoch und starten Sie den Server neu.`;
  fs.writeFileSync(notesFile, `### Deployment-Hinweis\n${deployHint}\n`, 'utf8');
  try {
    run('gh', ['release', 'create', tag, zipPath, '--title', `Manga Shelf ${tag}`, '--notes-file', notesFile, '--generate-notes']);
  } catch (err) {
    throw new Error(`GitHub-Release konnte nicht erstellt werden (Tag ${tag} ist bereits gepusht). Manuell: gh release create ${tag} ${ZIP_NAME} --generate-notes`);
  } finally {
    fs.rmSync(notesFile, { force: true });
  }
  const url = output('gh', ['release', 'view', tag, '--json', 'url', '-q', '.url']);
  console.log(`🔗 Release URL: ${url}`);
}

function main(argv) {
  console.log('🚀 Starte Release-Prozess für Manga Shelf...');
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = resolveTargetVersion(argv[0], rootPkg.version);
  const tag = `v${version}`;
  console.log(`📌 Ziel-Version: ${tag} (bisher ${rootPkg.version})`);

  preflight(tag);
  console.log('🔍 Lint und Tests...');
  run('npm', ['run', 'lint']);
  run('npm', ['test']);

  const saved = snapshotFiles();
  const zipPath = bumpAndBuild(version, saved);
  commitAndTag(tag, saved);
  createGithubRelease(tag, zipPath);
  console.log(`\n🎉 Release ${tag} erfolgreich auf GitHub veröffentlicht!`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`\n❌ Release abgebrochen: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { resolveTargetVersion, getReleaseBlockers, compareVersions, VERSION_FILES };
