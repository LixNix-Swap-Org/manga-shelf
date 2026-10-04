const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { resolveTargetVersion, getReleaseBlockers } = require('../release');

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

// End to end against a scratch repository with a bare origin; npm and gh are stubs on PATH.
describe('release.js in a scratch repository', { skip: process.platform === 'win32' || spawnSync('git', ['--version']).error }, () => {
  let tmp;
  let bin;

  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-release-'));
    bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    // npm stub: `version X` rewrites package(-lock).json in the cwd, `run package` writes the ZIP, the rest succeeds
    fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, 'npm ' + args.join(' ') + '\\n');
const fail = (process.env.STUB_NPM_FAIL || '').split(',').filter(Boolean);
if (fail.some(f => args.join(' ').startsWith(f))) process.exit(1);
if (args[0] === 'version') {
  for (const f of ['package.json', 'package-lock.json']) {
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.version = args[1];
    if (j.packages && j.packages['']) j.packages[''].version = args[1];
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\\n');
  }
}
if (args[0] === 'run' && args[1] === 'package') {
  if (process.env.STUB_PACKAGE_STRAY) fs.writeFileSync('stray.txt', 'x');
  fs.writeFileSync('pterodactyl-manga-shelf.zip', 'zip');
}
`);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, 'gh ' + args.join(' ') + '\\n');
if (args[0] === 'release' && args[1] === 'view') {
  if (args.includes('--json')) { console.log('https://example.invalid/release'); process.exit(0); }
  process.exit(process.env.STUB_GH_RELEASE_EXISTS ? 0 : 1);
}
if (args[0] === 'release' && args[1] === 'create') {
  if (!fs.existsSync('RELEASE_NOTES.tmp')) process.exit(3);
  process.exit(process.env.STUB_GH_CREATE_FAIL ? 1 : 0);
}
process.exit(0);
`);
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  let counter = 0;
  function setupRepo() {
    const dir = path.join(tmp, `case-${++counter}`);
    const origin = path.join(dir, 'origin.git');
    const work = path.join(dir, 'work');
    fs.mkdirSync(work, { recursive: true });
    git(dir, 'init', '-q', '--bare', origin);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.email', 'release-test@example.invalid');
    git(work, 'config', 'user.name', 'Release Test');
    git(work, 'config', 'commit.gpgsign', 'false');
    git(work, 'config', 'tag.gpgsign', 'false');
    fs.copyFileSync(path.join(__dirname, '..', 'release.js'), path.join(work, 'release.js'));
    for (const prefix of ['', 'frontend/']) {
      writeJson(path.join(work, `${prefix}package.json`), { name: `app${prefix ? '-frontend' : ''}`, version: '1.0.0' });
      writeJson(path.join(work, `${prefix}package-lock.json`), { name: 'app', version: '1.0.0', lockfileVersion: 3, packages: { '': { version: '1.0.0' } } });
    }
    fs.writeFileSync(path.join(work, '.gitignore'), '*.zip\nRELEASE_NOTES.tmp\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'init');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', '-u', 'origin', 'main');
    return { work, origin, log: path.join(dir, 'stub.log') };
  }

  function release(repo, args, env = {}) {
    fs.writeFileSync(repo.log, '');
    const res = spawnSync(process.execPath, ['release.js', ...args], {
      cwd: repo.work,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_LOG: repo.log, GIT_TERMINAL_PROMPT: '0', ...env }
    });
    return { ...res, calls: fs.readFileSync(repo.log, 'utf8') };
  }

  const version = (repo, rel = 'package.json') => JSON.parse(fs.readFileSync(path.join(repo.work, rel), 'utf8')).version;

  test('without an argument nothing happens', () => {
    const repo = setupRepo();
    const res = release(repo, []);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Keine Version/);
    assert.equal(version(repo), '1.0.0');
    assert.equal(res.calls, '');
  });

  test('a typo like "Patch" is rejected before anything is written', () => {
    const repo = setupRepo();
    const res = release(repo, ['Patch']);
    assert.notEqual(res.status, 0);
    assert.equal(version(repo), '1.0.0');
    assert.equal(git(repo.origin, 'tag', '-l'), '');
  });

  test('a branch other than main is refused', () => {
    const repo = setupRepo();
    git(repo.work, 'checkout', '-q', '-b', 'feature');
    const res = release(repo, ['patch']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /nur auf "main"/);
    assert.equal(version(repo), '1.0.0');
    assert.equal(git(repo.origin, 'tag', '-l'), '');
  });

  test('untracked files (e.g. a TLS key) stop the release instead of being committed', () => {
    const repo = setupRepo();
    fs.mkdirSync(path.join(repo.work, 'ssl'));
    fs.writeFileSync(path.join(repo.work, 'ssl', 'privkey.pem'), 'secret');
    const res = release(repo, ['patch']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /ssl\/privkey\.pem/);
    assert.equal(version(repo), '1.0.0');
    assert.equal(git(repo.origin, 'log', '--oneline', 'main').split('\n').length, 1);
  });

  test('an existing remote tag is never moved', () => {
    const repo = setupRepo();
    git(repo.work, 'tag', '-a', 'v1.0.1', '-m', 'old');
    git(repo.work, 'push', '-q', 'origin', 'v1.0.1');
    git(repo.work, 'tag', '-d', 'v1.0.1');
    const before = git(repo.origin, 'rev-parse', 'v1.0.1^{}');
    const res = release(repo, ['patch']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /existiert auf origin bereits/);
    assert.equal(git(repo.origin, 'rev-parse', 'v1.0.1^{}'), before);
    assert.equal(version(repo), '1.0.0');
  });

  test('an existing GitHub release stops the run before the bump', () => {
    const repo = setupRepo();
    const res = release(repo, ['patch'], { STUB_GH_RELEASE_EXISTS: '1' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /existiert bereits/);
    assert.equal(version(repo), '1.0.0');
  });

  test('failing tests stop the run before the bump', () => {
    const repo = setupRepo();
    const res = release(repo, ['patch'], { STUB_NPM_FAIL: 'test' });
    assert.notEqual(res.status, 0);
    assert.equal(version(repo), '1.0.0');
    assert.doesNotMatch(res.calls, /npm version/);
  });

  test('a failing build restores the version files and creates no tag', () => {
    const repo = setupRepo();
    const res = release(repo, ['patch'], { STUB_NPM_FAIL: 'run package' });
    assert.notEqual(res.status, 0);
    assert.equal(version(repo), '1.0.0');
    assert.equal(version(repo, 'frontend/package-lock.json'), '1.0.0');
    assert.equal(git(repo.work, 'status', '--porcelain'), '');
    assert.equal(git(repo.work, 'tag', '-l'), '');
  });

  test('a build that leaves other files behind is refused', () => {
    const repo = setupRepo();
    const res = release(repo, ['patch'], { STUB_PACKAGE_STRAY: '1' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /stray\.txt/);
    assert.equal(version(repo), '1.0.0');
    assert.equal(git(repo.origin, 'tag', '-l'), '');
  });

  test('a release commits only the version files and pushes commit and tag together', () => {
    const repo = setupRepo();
    const res = release(repo, ['patch']);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const files = git(repo.origin, 'show', '--name-only', '--format=', 'main').split('\n').sort();
    assert.deepEqual(files, ['frontend/package-lock.json', 'frontend/package.json', 'package-lock.json', 'package.json']);
    assert.equal(git(repo.origin, 'rev-parse', 'v1.0.1^{}'), git(repo.origin, 'rev-parse', 'main'));
    assert.equal(version(repo), '1.0.1');
    assert.equal(version(repo, 'frontend/package.json'), '1.0.1');
    assert.match(res.calls, /gh release create v1\.0\.1 /);
    assert.doesNotMatch(res.calls, /--clobber/);
    assert.ok(!fs.existsSync(path.join(repo.work, 'RELEASE_NOTES.tmp')));
  });

  test('a failing gh release create exits non-zero and removes the notes file', () => {
    const repo = setupRepo();
    const res = release(repo, ['minor'], { STUB_GH_CREATE_FAIL: '1' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /GitHub-Release konnte nicht erstellt werden/);
    assert.ok(!fs.existsSync(path.join(repo.work, 'RELEASE_NOTES.tmp')));
    assert.equal(git(repo.origin, 'rev-parse', 'v1.1.0^{}'), git(repo.origin, 'rev-parse', 'main'));
  });

  test('a local main behind origin is refused', () => {
    const repo = setupRepo();
    const other = path.join(path.dirname(repo.work), 'other');
    git(path.dirname(repo.work), 'clone', '-q', repo.origin, other);
    git(other, 'config', 'user.email', 'o@example.invalid');
    git(other, 'config', 'user.name', 'O');
    git(other, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(other, 'x.txt'), 'x');
    git(other, 'add', 'x.txt');
    git(other, 'commit', '-q', '-m', 'x');
    git(other, 'push', '-q', 'origin', 'main');
    const res = release(repo, ['patch']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /hinter origin\/main/);
    assert.equal(version(repo), '1.0.0');
  });
});
