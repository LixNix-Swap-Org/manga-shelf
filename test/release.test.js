// Release script: target version and blockers, against a scratch repository.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { resolveTargetVersion, getReleaseBlockers } = require('../release');
const version = require('../scripts/release/version');
const bump = require('../scripts/release/bump-version');
const { writeChecksums, verifyChecksums, SUMS_FILE, BUNDLE_FILE } = require('../scripts/release/checksums');
const { detectSigning, notes } = require('../scripts/release/signing');
const { releaseNotes, beforeUpdating, verifyCommand, PTERODACTYL_UPDATE, SYSTEM_PAGE_UPDATE } = require('../scripts/release/notes');
const { writeMarker, markerName, MARKER_PATTERN } = require('../scripts/release/marker');
const C = require('../services/update/constants');

const scriptsDir = path.join(__dirname, '..', 'scripts', 'release');
const sha = (text) => require('crypto').createHash('sha256').update(text).digest('hex');

describe('resolveTargetVersion', () => {
  test('bump keywords', () => {
    assert.equal(resolveTargetVersion('patch', '2.19.1'), '2.19.2');
    assert.equal(resolveTargetVersion('minor', '2.19.1'), '2.20.0');
    assert.equal(resolveTargetVersion('major', '2.19.1'), '3.0.0');
  });

  test('explicit versions, with or without v', () => {
    assert.equal(resolveTargetVersion('v2.20.0', '2.19.1'), '2.20.0');
    assert.equal(resolveTargetVersion('2.19.10', '2.19.9'), '2.19.10');
  });

  test('no argument is rejected instead of re-releasing the current version', () => {
    assert.throws(() => resolveTargetVersion(undefined, '2.19.1'), /Keine Version/);
    assert.throws(() => resolveTargetVersion('', '2.19.1'), /Keine Version/);
  });

  test('typos and non-semver strings are rejected', () => {
    for (const bad of ['Patch', '2.20', 'vfoo', 'v2.20.0-beta', '2.20.0; rm -rf /']) {
      assert.throws(() => resolveTargetVersion(bad, '2.19.1'), /Ungültige Version/, bad);
    }
  });

  test('the same or a lower version is rejected', () => {
    assert.throws(() => resolveTargetVersion('2.19.1', '2.19.1'), /nicht größer/);
    assert.throws(() => resolveTargetVersion('v2.9.9', '2.19.1'), /nicht größer/);
  });
});

describe('getReleaseBlockers', () => {
  test('anything but the allowed files blocks', () => {
    const porcelain = ['?? ssl/privkey.pem', '?? notes.txt', ' M index.js', ' M package.json', ' M frontend/package-lock.json'].join('\n');
    assert.deepEqual(getReleaseBlockers(porcelain), ['ssl/privkey.pem', 'notes.txt', 'index.js', 'package.json', 'frontend/package-lock.json']);
    assert.deepEqual(
      getReleaseBlockers(porcelain, ['package.json', 'package-lock.json', 'frontend/package.json', 'frontend/package-lock.json']),
      ['ssl/privkey.pem', 'notes.txt', 'index.js']
    );
  });

  test('a clean tree has no blockers; renames count by their new path', () => {
    assert.deepEqual(getReleaseBlockers(''), []);
    assert.deepEqual(getReleaseBlockers('R  old.js -> new.js'), ['new.js']);
  });

  test('the repository ignores TLS keys', (t) => {
    const root = path.join(__dirname, '..');
    // a source export (ZIP download, git archive, container without .git) has no work tree to ask
    const tree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
    if (tree.error || tree.status !== 0 || tree.stdout.trim() !== 'true') return t.skip('not a git work tree');
    for (const p of ['ssl/privkey.pem', 'ssl/fullchain.pem', 'server.key']) {
      const res = spawnSync('git', ['check-ignore', '-q', p], { cwd: root });
      assert.equal(res.status, 0, `${p} is not ignored by .gitignore`);
    }
  });
});

function writeJson(file, data, indent = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, indent) + '\n');
}

function packages(dir, v = '1.0.0', dirs = ['.', 'frontend', 'desktop', 'mobile']) {
  for (const d of dirs) {
    const prefix = d === '.' ? '' : `${d}/`;
    writeJson(path.join(dir, `${prefix}package.json`), { name: `app-${d}`, version: v, scripts: { x: 'y' } });
    writeJson(path.join(dir, `${prefix}package-lock.json`), { name: `app-${d}`, version: v, lockfileVersion: 3, packages: { '': { name: `app-${d}`, version: v }, 'node_modules/a': { version: '9.9.9' } } });
  }
}

const read = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

describe('scripts/release/version.js', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-version-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('"none" keeps the version only where it is allowed (the workflow)', () => {
    assert.equal(version.resolveTargetVersion('none', '2.19.1', { allowNone: true }), '2.19.1');
    assert.throws(() => version.resolveTargetVersion('none', '2.19.1'), /nur im Release-Workflow/);
  });

  test('sets one version in server, frontend, desktop and mobile, lockfile root entries included', () => {
    packages(dir);
    const changed = version.writeVersion(dir, '1.2.0');
    assert.deepEqual(changed, ['package.json', 'package-lock.json', 'frontend/package.json', 'frontend/package-lock.json',
      'desktop/package.json', 'desktop/package-lock.json', 'mobile/package.json', 'mobile/package-lock.json']);
    for (const rel of changed) assert.equal(read(dir, rel).version, '1.2.0', rel);
    assert.equal(read(dir, 'desktop/package-lock.json').packages[''].version, '1.2.0');
    assert.equal(read(dir, 'desktop/package-lock.json').packages['node_modules/a'].version, '9.9.9', 'dependency versions stay');
    assert.deepEqual(version.writeVersion(dir, '1.2.0'), [], 'nothing to change the second time');
  });

  test('missing packages are skipped, indentation and the final newline are kept', () => {
    const only = fs.mkdtempSync(path.join(dir, 'only-'));
    writeJson(path.join(only, 'package.json'), { name: 'x', version: '0.1.0' }, 4);
    assert.deepEqual(version.versionFiles(only), ['package.json']);
    version.writeVersion(only, '0.2.0');
    assert.equal(fs.readFileSync(path.join(only, 'package.json'), 'utf8'), '{\n    "name": "x",\n    "version": "0.2.0"\n}\n');
    assert.throws(() => version.writeVersion(only, '0.3'), /Ungültige Version/);
  });

  test('bump-version.js prints the target, writes on --write and reports to $GITHUB_OUTPUT', () => {
    const repo = fs.mkdtempSync(path.join(dir, 'bump-'));
    packages(repo, '2.19.1', ['.', 'frontend']);
    const output = path.join(repo, 'gh-output');
    fs.writeFileSync(output, '');
    assert.deepEqual(bump.main(['minor', '--root', repo], { GITHUB_OUTPUT: output }), { version: '2.20.0', current: '2.19.1', changed: [] });
    assert.equal(read(repo, 'package.json').version, '2.19.1');
    assert.equal(fs.readFileSync(output, 'utf8'), 'version=2.20.0\ntag=v2.20.0\nprevious=2.19.1\n');
    const res = bump.main(['patch', '--root', repo, '--write'], {});
    assert.equal(res.version, '2.19.2');
    assert.equal(read(repo, 'frontend/package-lock.json').version, '2.19.2');
    assert.equal(bump.main(['none', '--root', repo], {}).version, '2.19.2');
    assert.throws(() => bump.main(['Patch', '--root', repo], {}), /Ungültige Version/);
  });
});

describe('SHA256SUMS.txt', () => {
  test('lists every file in sha256sum format and detects a changed or missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sums-'));
    try {
      fs.writeFileSync(path.join(dir, 'b.zip'), 'zip');
      fs.writeFileSync(path.join(dir, 'a.exe'), 'exe');
      fs.writeFileSync(path.join(dir, '.hidden'), 'x');
      const lines = writeChecksums(dir);
      assert.deepEqual(lines, [`${sha('exe')}  a.exe`, `${sha('zip')}  b.zip`]);
      assert.equal(fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8'), lines.join('\n') + '\n');
      assert.deepEqual(writeChecksums(dir), lines, 'the sums file never lists itself');
      assert.deepEqual(verifyChecksums(dir), []);
      fs.writeFileSync(path.join(dir, 'a.exe'), 'tampered');
      fs.rmSync(path.join(dir, 'b.zip'));
      assert.deepEqual(verifyChecksums(dir), ['Prüfsumme falsch: a.exe', 'fehlt: b.zip']);
      const sha256sum = spawnSync('sha256sum', ['--version']);
      if (!sha256sum.error) {
        fs.writeFileSync(path.join(dir, 'a.exe'), 'exe');
        fs.writeFileSync(path.join(dir, 'b.zip'), 'zip');
        assert.equal(spawnSync('sha256sum', ['-c', SUMS_FILE], { cwd: dir }).status, 0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never lists its own Sigstore bundle; --complete refuses files the signed sums do not name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sums-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.zip'), 'zip');
      fs.writeFileSync(path.join(dir, BUNDLE_FILE), '{}');
      assert.deepEqual(writeChecksums(dir), [`${sha('zip')}  a.zip`]);
      assert.equal(BUNDLE_FILE, 'SHA256SUMS.txt.sigstore.json');
      assert.deepEqual(verifyChecksums(dir, { complete: true }), []);
      fs.writeFileSync(path.join(dir, 'late.exe'), 'unsigned');
      fs.writeFileSync(path.join(dir, '.hidden'), 'x');
      assert.deepEqual(verifyChecksums(dir), [], 'without --complete extra files are fine');
      assert.deepEqual(verifyChecksums(dir, { complete: true }), ['nicht aufgeführt: late.exe']);
      const cli = (...args) => spawnSync(process.execPath, [path.join(scriptsDir, 'checksums.js'), ...args], { encoding: 'utf8' });
      const strict = cli(dir, '--verify', '--complete');
      assert.equal(strict.status, 1);
      assert.match(strict.stderr, /nicht aufgeführt: late\.exe/);
      assert.equal(cli(dir, '--verify').status, 0);
      const before = fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8');
      for (const bad of [[dir, '--verfy'], [dir, '--complete'], [dir, '--verify', '--all'], ['--verify', dir]]) {
        assert.equal(cli(...bad).status, 2, bad.join(' '));
      }
      assert.equal(fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8'), before, 'a mistyped flag never rewrites the sums');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('version marker (scripts/release/marker.js)', () => {
  const commit = 'a'.repeat(40);
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-marker-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('writes manga-shelf-release-vX.Y.Z.json with version, tag, commit and build time; SHA256SUMS.txt then names it', () => {
    fs.writeFileSync(path.join(dir, 'pterodactyl-manga-shelf.zip'), 'zip');
    const { name, data } = writeMarker(dir, { version: '3.1.0', commit, builtAt: new Date('2026-10-10T12:00:00.123Z') });
    assert.equal(name, 'manga-shelf-release-v3.1.0.json');
    assert.equal(markerName('3.1.0'), name);
    assert.deepEqual(data, { version: '3.1.0', tag: 'v3.1.0', commit, built_at: '2026-10-10T12:00:00Z' });
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.deepEqual(JSON.parse(text), data);
    const lines = writeChecksums(dir);
    assert.deepEqual(lines.filter(line => / {2}manga-shelf-release-v/.test(line)), [`${sha(text)}  ${name}`]);
  });

  test('refuses versions and commits the updater would not accept', () => {
    for (const version of ['3.1', 'v3.1.0', '03.1.0', '3.1.0-beta', '3.1.0\n', '', undefined]) {
      assert.throws(() => writeMarker(dir, { version, commit }), /Ungültige Version/, String(version));
    }
    for (const bad of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'HEAD', '']) {
      assert.throws(() => writeMarker(dir, { version: '3.1.0', commit: bad }), /Ungültiger Commit/, bad);
    }
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('refuses a second marker, a marker after the sums and a missing folder', () => {
    writeMarker(dir, { version: '3.1.0', commit });
    assert.throws(() => writeMarker(dir, { version: '3.1.0', commit }), /schon eine Versionsmarke/);
    assert.throws(() => writeMarker(dir, { version: '3.1.1', commit }), /manga-shelf-release-v3\.1\.0\.json/);
    const other = fs.mkdtempSync(path.join(dir, 'sums-'));
    fs.writeFileSync(path.join(other, SUMS_FILE), '');
    assert.throws(() => writeMarker(other, { version: '3.1.0', commit }), /vor checksums\.js/);
    assert.throws(() => writeMarker(path.join(dir, 'missing'), { version: '3.1.0', commit }), /Ordner fehlt/);
  });

  test('the CLI prints the file name, exits 1 on a refusal and 2 without arguments', () => {
    const cli = (...args) => spawnSync(process.execPath, [path.join(scriptsDir, 'marker.js'), ...args], { encoding: 'utf8' });
    const ok = cli(dir, '3.1.0', commit);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'manga-shelf-release-v3.1.0.json\n');
    assert.equal(cli(dir, '3.1.0', commit).status, 1);
    assert.equal(cli(dir, '3.1.0').status, 2);
  });
});

describe('the release side uses the frozen names of services/update/constants.js', () => {
  test('sums, bundle, marker, signer identity and state file are the constants', () => {
    assert.equal(SUMS_FILE, C.SUMS_NAME);
    assert.equal(BUNDLE_FILE, C.BUNDLE_NAME);
    assert.equal(markerName, C.markerName);
    assert.equal(MARKER_PATTERN, C.MARKER_PATTERN);
    for (const v of ['0.0.0', '3.1.0', '10.20.30']) assert.match(C.markerName(v), MARKER_PATTERN);
    for (const name of [C.SUMS_NAME, C.BUNDLE_NAME, C.ZIP_ASSET, `x${C.markerName('3.1.0')}`, `${C.markerName('3.1.0')}.bak`]) assert.doesNotMatch(name, MARKER_PATTERN);
    assert.match(C.markerName(''), MARKER_PATTERN, 'a marker without a version still counts as a marker');
    assert.equal(verifyCommand(), `cosign verify-blob ${C.SUMS_NAME} --bundle ${C.BUNDLE_NAME} --certificate-identity ${C.SIGNER_IDENTITY} --certificate-oidc-issuer ${C.OIDC_ISSUER}`);
    assert.ok(releaseNotes('v3.1.0', {}, 'someone/fork', '').includes(`\n${verifyCommand()}\n`), 'a run in a fork still names the identity servers pin');
    const state = require('../services/update/state');
    assert.equal(state.STATE_FORMAT, C.STATE_FORMAT);
    assert.equal(state.STATE_FILE, C.STATE_FILE);
  });

  test('verify-bundle.js and the updater accept exactly what marker.js and checksums.js write', async () => {
    const verify = require('../services/update/verify');
    const { verifyReleaseDir } = require('../scripts/release/verify-bundle');
    const h = require('./fixtures/update/helpers');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-contract-'));
    try {
      fs.writeFileSync(path.join(dir, C.ZIP_ASSET), 'zip');
      const { name } = writeMarker(dir, { version: '3.1.0', commit: 'b'.repeat(40) });
      writeChecksums(dir);
      const sumsBytes = fs.readFileSync(path.join(dir, C.SUMS_NAME));
      fs.writeFileSync(path.join(dir, C.BUNDLE_NAME), JSON.stringify(h.makeBundle(sumsBytes)));
      const verifier = verify.createVerifier({ verifyBundle: async () => h.goodSigner() });
      const r = await verifyReleaseDir(dir, { verifier });
      assert.deepEqual({ version: r.version, identity: r.identity, files: r.files }, { version: '3.1.0', identity: C.SIGNER_IDENTITY, files: 2 });
      const ok = await verifier.verifyRelease({
        sumsBytes, bundleJson: fs.readFileSync(path.join(dir, C.BUNDLE_NAME)), markerName: name, markerBytes: fs.readFileSync(path.join(dir, name)),
        version: '3.1.0', assetName: C.ZIP_ASSET, assetSha256: sha('zip'), policy: verify.PRODUCTION_POLICY
      });
      assert.equal(ok.identity, C.SIGNER_IDENTITY);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('signing detection and release text', () => {
  test('a group counts only with all of its secrets; notarizing needs the certificate', () => {
    assert.deepEqual(detectSigning({}), { windows: false, macos: false, notarize: false, android: false, ios: false });
    assert.equal(detectSigning({ WIN_CSC_LINK: 'x', WIN_CSC_KEY_PASSWORD: '' }).windows, false, 'empty secret = missing');
    assert.equal(detectSigning({ WIN_CSC_LINK: 'x', WIN_CSC_KEY_PASSWORD: 'y' }).windows, true);
    const apple = { APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' };
    assert.equal(detectSigning(apple).notarize, false);
    assert.deepEqual(detectSigning({ ...apple, MAC_CSC_LINK: 'm', MAC_CSC_KEY_PASSWORD: 'p' }), { windows: false, macos: true, notarize: true, android: false, ios: false });
  });

  test('the release text names the signing state and the downloads', () => {
    assert.match(notes(detectSigning({})), /Windows .*: unsigned/);
    assert.match(notes(detectSigning({ WIN_CSC_LINK: 'x', WIN_CSC_KEY_PASSWORD: 'y' })), /Windows .*: signed/);
    // AGENTS.md §7 and CHANGELOG.md quote these iPhone lines
    const ios = { IOS_CERT_P12_BASE64: 'a', IOS_CERT_PASSWORD: 'b', IOS_PROVISIONING_PROFILE_BASE64: 'c', APPLE_TEAM_ID: 'd' };
    const withShare = { ...ios, IOS_SHARE_PROVISIONING_PROFILE_BASE64: 'p' };
    assert.match(notes(detectSigning(withShare), withShare), /iPhone \(IPA\): signed, with share extension \(iOS\)$/m);
    const withoutShare = { ...ios, IOS_SHARE_PROVISIONING_PROFILE_BASE64: '' };
    assert.match(notes(detectSigning(withoutShare), withoutShare), /iPhone \(IPA\): signed, without share extension \(iOS\)$/m);
    const text = releaseNotes('v2.20.0', {}, 'LixNix-Swap-Org/manga-shelf');
    assert.match(text, /pterodactyl-manga-shelf\.zip/);
    assert.ok(text.includes('ghcr.io/lixnix-swap-org/manga-shelf:2.20.0'), text);
    assert.match(text, /SHA256SUMS\.txt/);
    assert.match(text, /### Signing/);
    assert.match(text, /^Checksums: `SHA256SUMS\.txt`/m);
  });

  test('the release text points at the in-app update and the Sigstore check of SHA256SUMS.txt', () => {
    const text = releaseNotes('v3.1.0', {}, 'LixNix-Swap-Org/manga-shelf', '');
    assert.ok(text.includes(`### Downloads\n- ${SYSTEM_PAGE_UPDATE}\n- **Pterodactyl:** ${PTERODACTYL_UPDATE}\n`), text);
    assert.equal(SYSTEM_PAGE_UPDATE, '**Update from the system page:** servers from v3.1.0 on install this release under System → Updates (Pterodactyl and self-installed headless binaries; signature checked). Docker, packages, the desktop app and older servers update as below.');
    assert.ok(text.includes('cosign verify-blob SHA256SUMS.txt --bundle SHA256SUMS.txt.sigstore.json --certificate-identity https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com\n'), text);
    assert.match(text, /bundle `SHA256SUMS\.txt\.sigstore\.json`, version marker `manga-shelf-release-v3\.1\.0\.json`/);
    assert.ok(text.indexOf('cosign verify-blob') > text.indexOf('Checksums:') && text.indexOf('cosign verify-blob') < text.indexOf('### Signing'));
    assert.doesNotMatch(text, /### Before updating/, 'no block without a CHANGELOG section');
  });

  test('a "### Before updating" block of the version in CHANGELOG opens the release text', () => {
    const changelog = [
      '# Changelog', '',
      '## 3.1.10 – 2026-12-01', '### Before updating', '- not this one', '',
      '## 3.1.0-beta', '### Before updating', '- nor this one', '',
      '## 3.1.0 – 2026-10-12', 'Intro.', '', '### Before updating', '- **Last manual update.** Read this.', '- Second line.', '',
      '### New features', '- x', '',
      '## 3.0.0 – 2026-10-10', '### Before updating', '- old', ''
    ].join('\n');
    assert.equal(beforeUpdating(changelog, '3.1.0'), '- **Last manual update.** Read this.\n- Second line.');
    assert.equal(beforeUpdating(changelog, '3.0.0'), '- old');
    assert.equal(beforeUpdating(changelog, '3.0.1'), '');
    assert.equal(beforeUpdating('## 3x1x0\n### Before updating\n- a\n', '3.1.0'), '', 'the dots are literal');
    assert.equal(beforeUpdating('## 3.2.0\n### Before updating\n\n## 3.1.0\n', '3.2.0'), '');
    assert.equal(beforeUpdating('## 3.2.0\n### New features\n- x\n## 3.1.0\n### Before updating\n- y\n', '3.2.0'), '', 'never borrows the block of another version');
    assert.equal(beforeUpdating(changelog.replace(/\n/g, '\r\n'), '3.0.0'), '- old');
    const text = releaseNotes('v3.1.0', {}, 'LixNix-Swap-Org/manga-shelf', changelog);
    assert.ok(text.startsWith('### Before updating\n- **Last manual update.** Read this.\n- Second line.\n\n### Downloads\n'), text);
  });

  test('the release text reads the repository CHANGELOG.md by default', () => {
    const real = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
    assert.equal(releaseNotes('v9.9.9', {}), releaseNotes('v9.9.9', {}, 'LixNix-Swap-Org/manga-shelf', real));
  });

  test('tags have the vX.Y.Z form the update check reads (routes/system.js)', () => {
    assert.equal(version.tagFor('2.20.0'), 'v2.20.0');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'routes', 'system.js'), 'utf8'), /tag_name \|\| ''\)\.replace\(\/\^v\/, ''\)/);
  });
});

// The local helper against a scratch repository: it only sets the version, never commits, tags or pushes.
describe('release.js (local helper)', { skip: spawnSync('git', ['--version']).error }, () => {
  let tmp;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-release-')); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  let counter = 0;
  function setupRepo() {
    const work = path.join(tmp, `case-${++counter}`);
    fs.mkdirSync(path.join(work, 'scripts', 'release'), { recursive: true });
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.email', 'release-test@example.invalid');
    git(work, 'config', 'user.name', 'Release Test');
    git(work, 'config', 'commit.gpgsign', 'false');
    git(work, 'config', 'tag.gpgsign', 'false');
    fs.copyFileSync(path.join(__dirname, '..', 'release.js'), path.join(work, 'release.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'release', 'version.js'), path.join(work, 'scripts', 'release', 'version.js'));
    packages(work, '1.0.0', ['.', 'frontend', 'desktop']);
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'init');
    return work;
  }

  const release = (work, args) => spawnSync(process.execPath, ['release.js', ...args], { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

  test('without an argument nothing happens and the Actions tab is named', () => {
    const work = setupRepo();
    const res = release(work, []);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Keine Version/);
    assert.match(res.stderr, /Actions-Tab/);
    assert.equal(git(work, 'status', '--porcelain'), '');
  });

  test('--dry-run shows the target and the files, changes nothing', () => {
    const work = setupRepo();
    const res = release(work, ['minor', '--dry-run']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /1\.0\.0 → 1\.1\.0/);
    assert.match(res.stdout, /desktop\/package-lock\.json/);
    assert.equal(git(work, 'status', '--porcelain'), '');
  });

  test('a bump sets every version file and neither commits, tags nor pushes', () => {
    const work = setupRepo();
    const res = release(work, ['patch']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(read(work, 'desktop/package.json').version, '1.0.1');
    assert.equal(read(work, 'frontend/package-lock.json').packages[''].version, '1.0.1');
    assert.equal(git(work, 'log', '--oneline').split('\n').length, 1);
    assert.equal(git(work, 'tag', '-l'), '');
    assert.equal(git(work, 'status', '--porcelain').split('\n').length, 6);
    assert.match(res.stdout, /bump = none/);
  });

  test('a dirty tree (e.g. a TLS key) or an existing tag stops it before anything is written', () => {
    const work = setupRepo();
    fs.mkdirSync(path.join(work, 'ssl'));
    fs.writeFileSync(path.join(work, 'ssl', 'privkey.pem'), 'secret');
    const dirty = release(work, ['patch']);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /ssl\/privkey\.pem/);
    fs.rmSync(path.join(work, 'ssl'), { recursive: true });
    git(work, 'tag', 'v1.0.1');
    const tagged = release(work, ['patch']);
    assert.equal(tagged.status, 1);
    assert.match(tagged.stderr, /Tag v1\.0\.1 existiert bereits/);
    assert.equal(read(work, 'package.json').version, '1.0.0');
  });

  test('the native mobile projects follow through mobile/scripts/sync-version.js', () => {
    const work = setupRepo();
    fs.mkdirSync(path.join(work, 'mobile', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(work, 'mobile', 'scripts', 'sync-version.js'),
      "const fs = require('fs'); fs.writeFileSync(require('path').join(__dirname, '..', 'native.txt'), require('../../package.json').version);");
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'mobile');
    const res = release(work, ['major']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(path.join(work, 'mobile', 'native.txt'), 'utf8'), '2.0.0');
    assert.match(res.stdout, /build\.gradle/);
  });

  test('typos and steps down are refused', () => {
    const work = setupRepo();
    assert.match(release(work, ['Patch']).stderr, /Ungültige Version/);
    assert.match(release(work, ['0.9.0']).stderr, /nicht größer/);
    assert.match(release(work, ['none']).stderr, /nur im Release-Workflow/);
  });
});
