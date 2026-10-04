// Release script: target version and blockers, against a scratch repository.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { resolveTargetVersion, getReleaseBlockers } = require('../release');
const version = require('../scripts/release/version');
const bump = require('../scripts/release/bump-version');
const { writeChecksums, verifyChecksums, SUMS_FILE } = require('../scripts/release/checksums');
const { detectSigning, notes } = require('../scripts/release/signing');
const { releaseNotes } = require('../scripts/release/notes');

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
      const sha = (text) => require('crypto').createHash('sha256').update(text).digest('hex');
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
    assert.match(notes(detectSigning({})), /Windows .*: unsigniert/);
    assert.match(notes(detectSigning({ WIN_CSC_LINK: 'x', WIN_CSC_KEY_PASSWORD: 'y' })), /Windows .*: signiert/);
    const text = releaseNotes('v2.20.0', {}, 'LixNix-Swap-Org/manga-shelf');
    assert.match(text, /pterodactyl-manga-shelf\.zip/);
    assert.match(text, /ghcr\.io\/lixnix-swap-org\/manga-shelf:2\.20\.0/);
    assert.match(text, /SHA256SUMS\.txt/);
    assert.match(text, /### Signierung/);
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
