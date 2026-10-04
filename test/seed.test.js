const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const { seriesSizes, mulberry32, parseArgs, USERS_FILE } = require('../scripts/seed');
const bench = require('../scripts/bench/run');

const root = path.join(__dirname, '..');
const SEED_SCRIPT = path.join(root, 'scripts', 'seed.js');
const STATUSES = ['Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt'];

function runSeed(dataDir, ...args) {
  const env = { ...process.env, LOG_LEVEL: 'silent' };
  delete env.DATA_DIR;
  return spawnSync(process.execPath, [SEED_SCRIPT, '--data-dir', dataDir, ...args], { encoding: 'utf8', env });
}

function dump(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'manga.db'), { readOnly: true });
  try {
    return {
      users: db.prepare('SELECT id, username, role FROM users ORDER BY id').all(),
      mangas: db.prepare('SELECT * FROM mangas ORDER BY id').all().map(({ created_at, updated_at, ...m }) => m),
      volumes: db.prepare('SELECT * FROM volumes ORDER BY id').all().map(({ created_at, ...v }) => v),
      owners: db.prepare('SELECT volume_id, user_id, price, purchase_date, condition FROM volume_owners ORDER BY volume_id, user_id').all(),
      reads: db.prepare('SELECT volume_id, user_id FROM volume_reads ORDER BY volume_id, user_id').all()
    };
  } finally {
    db.close();
  }
}

describe('scripts/seed.js', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-seed-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('series sizes add up exactly and every series has an entry', () => {
    for (const [series, volumes] of [[1, 1], [7, 7], [12, 200], [400, 9000], [1500, 45000]]) {
      const sizes = seriesSizes(mulberry32(3), series, volumes);
      assert.equal(sizes.length, series);
      assert.equal(sizes.reduce((a, b) => a + b, 0), volumes);
      assert.ok(sizes.every(n => n >= 1));
    }
    assert.throws(() => seriesSizes(mulberry32(1), 10, 5), /mindestens/);
  });

  test('argument parsing rejects unknown flags and non-numbers', () => {
    assert.deepEqual(parseArgs(['--series', '3', '--volumes', '9', '--seed', '5', '--data-dir', 'x']), { series: 3, volumes: 9, seed: 5, dataDir: 'x' });
    assert.throws(() => parseArgs(['--series', 'abc']), /ganze Zahl/);
    assert.throws(() => parseArgs(['--wipe']), /Unbekanntes Argument/);
  });

  test('the same seed gives the same collection, another seed a different one', () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    const c = path.join(dir, 'c');
    for (const [target, seed] of [[a, '7'], [b, '7'], [c, '8']]) {
      const res = runSeed(target, '--series', '12', '--volumes', '200', '--seed', seed);
      assert.equal(res.status, 0, res.stderr);
    }
    const first = dump(a);
    assert.deepEqual(dump(b), first);
    assert.notDeepEqual(dump(c).volumes, first.volumes);
    assert.equal(first.mangas.length, 12);
    assert.equal(first.volumes.length, 200);
    assert.deepEqual(first.users.map(u => [u.username, u.role]), [['admin', 'admin'], ['anna', 'editor'], ['ben', 'editor']]);
  });

  test('the data follows the app rules: owners match the status, counts and keys are consistent', () => {
    const { mangas, volumes, owners } = dump(path.join(dir, 'a'));
    const ownersByVolume = new Map();
    for (const o of owners) ownersByVolume.set(o.volume_id, (ownersByVolume.get(o.volume_id) || 0) + 1);
    const keys = new Set();
    for (const v of volumes) {
      assert.ok(STATUSES.includes(v.status), v.status);
      assert.ok(['volume', 'special_edition', 'schuber', 'special'].includes(v.type), v.type);
      assert.equal(ownersByVolume.has(v.id), v.status === 'Vorhanden', `volume ${v.id}: status ${v.status} vs owners`);
      const key = `${v.manga_id}|${v.type}|${v.volume_number}`;
      assert.ok(!keys.has(key), `duplicate ${key}`);
      keys.add(key);
    }
    for (const m of mangas) {
      const owned = volumes.filter(v => v.manga_id === m.id && v.status === 'Vorhanden').length;
      assert.equal(m.owned_volumes, owned, `owned_volumes of ${m.title}`);
    }
  });

  test('demo logins are random, stored only as bcrypt hashes and written to a private file', () => {
    const dataDir = path.join(dir, 'a');
    const file = path.join(dataDir, USERS_FILE);
    const { users } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const other = JSON.parse(fs.readFileSync(path.join(dir, 'b', USERS_FILE), 'utf8')).users;
    assert.equal(users.length, 3);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const db = new DatabaseSync(path.join(dataDir, 'manga.db'), { readOnly: true });
    try {
      for (const [i, user] of users.entries()) {
        assert.ok(user.password.length >= 16);
        assert.notEqual(user.password, other[i].password);
        const { password_hash: hash } = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(user.username);
        assert.notEqual(hash, user.password);
        assert.ok(bcrypt.compareSync(user.password, hash));
      }
    } finally {
      db.close();
    }
  });

  test('refuses to touch a database that already has data', () => {
    const target = path.join(dir, 'a');
    const before = fs.readFileSync(path.join(target, USERS_FILE), 'utf8');
    const res = runSeed(target, '--series', '2', '--volumes', '4');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /nicht leer/);
    assert.equal(fs.readFileSync(path.join(target, USERS_FILE), 'utf8'), before);
    assert.equal(dump(target).mangas.length, 12);
  });
});

describe('scripts/bench/run.js', () => {
  test('benchmarks every endpoint against a small seeded database and reports the server memory peak', { timeout: 60000 }, () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-bench-')), 'bench.json');
    try {
      const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'bench', 'run.js'), '--series', '4', '--volumes', '60', '--runs', '1', '--out', out],
        { encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent' } });
      assert.equal(res.status, 0, res.stderr);
      const result = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.deepEqual(Object.keys(result.endpoints), ['GET /api/mangas', 'GET /api/mangas/:id', 'GET /api/offline-snapshot', 'GET /api/stats',
        'GET /api/shopping-list', 'GET /api/export/csv', 'GET /api/release-radar']);
      for (const s of Object.values(result.endpoints)) assert.ok(s.median > 0 && s.min <= s.median && s.median <= s.max && s.wireBytes > 0);
      assert.ok(result.healthDuringSnapshot.median > 0);
      assert.ok(result.server.maxRssMb > 0);
      assert.equal(result.dataset.volumes, 60);
    } finally {
      fs.rmSync(path.dirname(out), { recursive: true, force: true });
    }
  });

  test('a budget fails only above the tolerance', () => {
    const result = {
      dataset: { series: 1, volumes: 1, seed: 1 },
      endpoints: { 'GET /api/mangas': { median: 125 }, 'GET /api/stats': { median: 140 } },
      healthDuringSnapshot: { median: 20 },
      server: { maxRssMb: 500 }
    };
    const budget = bench.budgetFrom({ ...result, endpoints: { 'GET /api/mangas': { median: 100 }, 'GET /api/stats': { median: 100 } }, server: { maxRssMb: 300 } });
    assert.equal(budget.tolerance, 0.3);
    const regressions = bench.compareToBudget(result, budget);
    assert.equal(regressions.length, 2);
    assert.match(regressions[0], /GET \/api\/stats/);
    assert.match(regressions[1], /RSS/);
    assert.deepEqual(bench.compareToBudget(result, { ...budget, tolerance: 0.7 }), []);
  });
});
