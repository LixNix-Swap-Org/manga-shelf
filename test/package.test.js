const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const { buildPackage, PACKAGE_FILES, ZIP_NAME } = require('../package');
const { readManifest, shippedFiles, stageBackend } = require('../scripts/stage-backend');

const repoRoot = path.join(__dirname, '..');
const repoManifest = readManifest(repoRoot);

function write(root, rel, content = 'x') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writePackageJson(root, files) {
  write(root, 'package.json', JSON.stringify({ name: 'fixture', files }));
}

function fixture(root, files = ['index.js', 'db.js', 'mangaPassion.js', 'healthcheck.js', 'middleware/', 'routes/', 'scripts/admin.js', 'services/', 'utils/']) {
  writePackageJson(root, files);
  write(root, 'package-lock.json', '{}');
  write(root, '.env.example', 'PORT=3000');
  for (const entry of files) {
    if (entry.endsWith('/')) write(root, `${entry}a.js`, '// a');
    else write(root, entry, `// ${entry}`);
  }
}

describe('package.js', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-package-'));
    fixture(root);
    write(root, 'node_modules/express/index.js');
    write(root, 'data/manga.db');
    write(root, '.env', 'JWT_SECRET=secret');
    write(root, 'scripts/seed.js');
    write(root, 'test/a.test.js');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function build() {
    const cwd = process.cwd();
    process.chdir(os.tmpdir());
    try {
      await buildPackage({ root });
    } finally {
      process.chdir(cwd);
    }
    const zipPath = path.join(root, 'dist_pack', ZIP_NAME);
    return { zipPath, names: new AdmZip(zipPath).getEntries().map(e => e.entryName) };
  }

  test('without frontend/dist it fails and leaves the last good ZIP alone', async () => {
    write(root, `dist_pack/${ZIP_NAME}`, 'previous');
    await assert.rejects(buildPackage({ root }), /frontend\/dist\/index\.html/);
    assert.equal(fs.readFileSync(path.join(root, 'dist_pack', ZIP_NAME), 'utf8'), 'previous');
    assert.ok(!fs.existsSync(path.join(root, ZIP_NAME)));
    assert.deepEqual(fs.readdirSync(path.join(root, 'dist_pack')), [ZIP_NAME]);
  });

  test('a backend folder named in package.json "files" but missing fails before anything is written', async () => {
    fs.rmSync(path.join(root, 'services'), { recursive: true });
    write(root, 'frontend/dist/index.html', '<html></html>');
    await assert.rejects(buildPackage({ root }), /services\//);
    assert.ok(!fs.existsSync(path.join(root, 'dist_pack')));
  });

  test('ships lockfile, .env.example, scripts/admin.js and the built frontend, never node_modules, data, .env, other scripts or tests', async () => {
    write(root, 'frontend/dist/index.html', '<html></html>');
    write(root, 'frontend/dist/assets/app.js', 'console.log(1)');
    const { zipPath, names } = await build();
    for (const required of ['package.json', 'package-lock.json', '.env.example', 'index.js', 'healthcheck.js', 'routes/a.js', 'scripts/admin.js', 'frontend/dist/index.html', 'frontend/dist/assets/app.js']) {
      assert.ok(names.includes(required), `${required} missing in the ZIP`);
    }
    assert.ok(!names.some(n => (/^(node_modules|data|scripts|test)\//.test(n) && n !== 'scripts/admin.js') || n === '.env'), names.join(', '));
    assert.deepEqual(fs.readFileSync(path.join(root, ZIP_NAME)), fs.readFileSync(zipPath), 'root copy differs');
    assert.ok(!fs.existsSync(`${zipPath}.tmp`));
  });

  test('a new top-level file only has to be added to package.json "files"', async () => {
    fixture(root, ['index.js', 'config.js', 'routes/', 'shared/']);
    write(root, 'frontend/dist/index.html', '<html></html>');
    const { names } = await build();
    for (const rel of ['config.js', 'shared/a.js', 'routes/a.js']) assert.ok(names.includes(rel), `${rel} missing`);
    assert.ok(!names.includes('db.js'), 'files outside the manifest must not be shipped');
  });
});

describe('scripts/stage-backend.js', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-stage-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('copies exactly the manifest entries and skips OS junk files', () => {
    fixture(root, ['index.js', 'routes/']);
    write(root, 'routes/nested/b.js');
    write(root, 'routes/.DS_Store');
    write(root, 'db.js');
    const target = path.join(root, 'out');
    const files = stageBackend(root, target);
    assert.deepEqual(files, ['index.js', 'routes/a.js', 'routes/nested/b.js']);
    assert.equal(fs.readFileSync(path.join(target, 'routes/nested/b.js'), 'utf8'), 'x');
    assert.ok(!fs.existsSync(path.join(target, 'db.js')));
    assert.ok(!fs.existsSync(path.join(target, 'routes/.DS_Store')));
  });

  test('rejects a missing "files" array, globs and paths outside the app', () => {
    write(root, 'package.json', JSON.stringify({ name: 'x' }));
    assert.throws(() => readManifest(root), /"files"/);
    for (const bad of ['../secret.js', 'routes/*.js', '/etc/passwd', '!index.js']) {
      writePackageJson(root, [bad]);
      assert.throws(() => readManifest(root), /Ungültiger Eintrag/, bad);
    }
  });

  test('a manifest entry that does not exist is an error', () => {
    fixture(root, ['index.js']);
    writePackageJson(root, ['index.js', 'config.js']);
    assert.throws(() => shippedFiles(root), /config\.js/);
  });

  test('the CLI stages the repository backend', () => {
    const { spawnSync } = require('child_process');
    const target = path.join(root, 'backend');
    const res = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'stage-backend.js'), target], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    for (const rel of ['index.js', 'db.js', 'healthcheck.js', 'routes', 'utils']) assert.ok(fs.existsSync(path.join(target, rel)), rel);
    assert.ok(!fs.existsSync(path.join(target, 'package.js')));
    assert.ok(!fs.existsSync(path.join(target, 'test')));
  });
});

describe('ZIP and Docker image ship the same backend', () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.indexOf('AS runner'));

  test('the image takes its backend files from scripts/stage-backend.js, not from a hand-written list', () => {
    assert.match(dockerfile, /RUN node scripts\/stage-backend\.js \/backend/);
    assert.match(runtime, /^COPY --from=backend-files \/backend\/ \.\/$/m);
    const handCopied = [...runtime.matchAll(/^COPY (?!--from)(.+)$/gm)].map(m => m[1].trim().split(/\s+/).slice(0, -1)).flat();
    assert.deepEqual(handCopied.filter(p => !['package*.json', 'docker-entrypoint.sh'].includes(p)), []);
  });

  test('every local module a shipped file requires is shipped too', () => {
    const shipped = new Set(shippedFiles(repoRoot));
    const resolveLocal = (from, spec) => {
      const base = path.join(path.dirname(path.join(repoRoot, from)), spec);
      for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.relative(repoRoot, candidate).split(path.sep).join('/');
      }
      return null;
    };
    for (const file of shipped) {
      if (!file.endsWith('.js')) continue;
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      for (const m of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const target = resolveLocal(file, m[1]);
        if (target === null) continue;
        assert.ok(shipped.has(target) || PACKAGE_FILES.includes(target), `${file} requires ${m[1]} (${target}), which package.json "files" does not ship`);
      }
    }
  });

  test('neither target carries the packager or the dev scripts; the admin console script ships', () => {
    assert.ok(repoManifest.includes('scripts/admin.js'), 'docker exec / ZIP need scripts/admin.js');
    for (const rel of repoManifest) {
      if (rel === 'scripts/admin.js') continue;
      assert.ok(!/^(package\.js|scripts|test|frontend)(\/|$)/.test(rel), rel);
    }
    assert.deepEqual(shippedFiles(repoRoot).filter(f => f.startsWith('scripts/')), ['scripts/admin.js']);
  });
});
