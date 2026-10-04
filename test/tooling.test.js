const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const bundle = require('../scripts/check-bundle-size');
const { devConfig, linePrefixer } = require('../scripts/dev');

const root = path.join(__dirname, '..');
const CHECK_SCRIPT = path.join(root, 'scripts', 'check-bundle-size.js');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// incompressible content of a given length, so the gzip size grows with it
function noise(bytes, seed = 1) {
  let x = seed;
  return Buffer.from(Array.from({ length: bytes }, () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return 33 + (x % 90); }));
}

function fakeDist(dir, { entryBytes = 4000, dashboardBytes = 3000, extra = null } = {}) {
  const manifest = {
    'index.html': { file: 'assets/index-AAAAAAAA.js', isEntry: true, imports: ['_vendor-BBBBBBBB.js'], css: ['assets/index-CCCCCCCC.css'], dynamicImports: ['src/Dashboard.jsx'] },
    '_vendor-BBBBBBBB.js': { file: 'assets/vendor-BBBBBBBB.js' },
    'src/Dashboard.jsx': { file: 'assets/Dashboard-DDDDDDDD.js', isDynamicEntry: true, imports: ['_vendor-BBBBBBBB.js'] },
    'src/font.woff2': { file: 'assets/font-EEEEEEEE.woff2' }
  };
  write(path.join(dir, 'assets/index-AAAAAAAA.js'), noise(entryBytes, 1));
  write(path.join(dir, 'assets/vendor-BBBBBBBB.js'), noise(2000, 2));
  write(path.join(dir, 'assets/index-CCCCCCCC.css'), noise(1500, 3));
  write(path.join(dir, 'assets/Dashboard-DDDDDDDD.js'), noise(dashboardBytes, 4));
  write(path.join(dir, 'assets/font-EEEEEEEE.woff2'), noise(500, 5));
  if (extra) {
    manifest['src/Heavy.jsx'] = { file: 'assets/Heavy-FFFFFFFF.js', isDynamicEntry: true };
    write(path.join(dir, 'assets/Heavy-FFFFFFFF.js'), noise(extra, 6));
  }
  write(path.join(dir, '.vite/manifest.json'), JSON.stringify(manifest));
}

describe('bundle size budget (scripts/check-bundle-size.js)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-bundle-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('chunk keys survive a rebuild: hashes and absolute node_modules paths are dropped', () => {
    assert.equal(bundle.normalizeKey('_arrow-right-B7tmY-r9.js'), '_arrow-right.js');
    assert.equal(bundle.normalizeKey('_useMangaData-DF9DLfej.js'), '_useMangaData.js');
    assert.equal(bundle.normalizeKey('src/Dashboard.jsx'), 'src/Dashboard.jsx');
    assert.equal(bundle.normalizeKey('../../x/frontend/node_modules/@zxing/library/esm/index.js'), 'node_modules/@zxing/library/esm/index.js');
  });

  test('measures every JS/CSS chunk and the initial load (entry, static imports and CSS) with gzip', () => {
    const dist = path.join(dir, 'dist');
    fakeDist(dist);
    const sizes = bundle.collectSizes(dist);
    const gz = rel => zlib.gzipSync(fs.readFileSync(path.join(dist, rel)), { level: 9 }).length;
    assert.equal(sizes['index.html'], gz('assets/index-AAAAAAAA.js'));
    assert.equal(sizes['index.html (css)'], gz('assets/index-CCCCCCCC.css'));
    assert.equal(sizes['_vendor.js'], gz('assets/vendor-BBBBBBBB.js'));
    assert.equal(sizes['src/Dashboard.jsx'], gz('assets/Dashboard-DDDDDDDD.js'));
    assert.equal(sizes[bundle.INITIAL_KEY], gz('assets/index-AAAAAAAA.js') + gz('assets/vendor-BBBBBBBB.js') + gz('assets/index-CCCCCCCC.css'));
    assert.ok(!Object.keys(sizes).some(k => k.includes('font')));
  });

  test('route chunks keep their source path whether Rollup emits a dynamic entry or a shared chunk', () => {
    assert.equal(bundle.chunkKey('_Dashboard-KnfWCbVY.js'), 'src/Dashboard.jsx');
    assert.equal(bundle.chunkKey('_MangaDetail-GSo_oPKm.js'), 'src/MangaDetail.jsx');
    assert.equal(bundle.chunkKey('src/Dashboard.jsx'), 'src/Dashboard.jsx');
    assert.equal(bundle.chunkKey('_useMangaData-DF9DLfej.js'), '_useMangaData.js');
    assert.equal(bundle.chunkKey('_DashboardHeader-AbCdEfGh.js'), '_DashboardHeader.js');

    const dist = path.join(dir, 'dist');
    const budgetFile = path.join(dir, 'budget.json');
    fakeDist(dist);
    const run = (...args) => spawnSync(process.execPath, [CHECK_SCRIPT, '--dist', dist, '--budget', budgetFile, ...args], { encoding: 'utf8' });
    assert.equal(run('--update').status, 0);

    const manifestPath = path.join(dist, '.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_Dashboard-DDDDDDDD.js'] = { ...manifest['src/Dashboard.jsx'], css: ['assets/Dashboard-GGGGGGGG.css'] };
    delete manifest['src/Dashboard.jsx'];
    manifest['index.html'].dynamicImports = ['_Dashboard-DDDDDDDD.js'];
    manifest['src/components/modals/StatsModal.jsx'] = { file: 'assets/StatsModal-HHHHHHHH.js', isDynamicEntry: true, imports: ['_Dashboard-DDDDDDDD.js'] };
    write(path.join(dist, 'assets/Dashboard-GGGGGGGG.css'), noise(300, 7));
    write(path.join(dist, 'assets/StatsModal-HHHHHHHH.js'), noise(400, 8));
    write(manifestPath, JSON.stringify(manifest));
    const gz = rel => zlib.gzipSync(fs.readFileSync(path.join(dist, rel)), { level: 9 }).length;
    const sizes = bundle.collectSizes(dist);
    assert.equal(sizes['src/Dashboard.jsx'], gz('assets/Dashboard-DDDDDDDD.js'));
    assert.equal(sizes['src/Dashboard.jsx (css)'], gz('assets/Dashboard-GGGGGGGG.css'));
    assert.ok(!('_Dashboard.js' in sizes));
    const res = run();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /src\/Dashboard\.jsx\s.*ok/);

    manifest['src/Dashboard.jsx'] = { file: 'assets/Dashboard-IIIIIIII.js', isDynamicEntry: true, imports: ['_Dashboard-DDDDDDDD.js'] };
    write(path.join(dist, 'assets/Dashboard-IIIIIIII.js'), 'export { D as default } from "./Dashboard-DDDDDDDD.js";');
    write(manifestPath, JSON.stringify(manifest));
    assert.equal(bundle.collectSizes(dist)['src/Dashboard.jsx'], gz('assets/Dashboard-DDDDDDDD.js') + gz('assets/Dashboard-IIIIIIII.js'),
      'a facade entry and its shared chunk count as one route chunk');
  });

  test('fails above +15 %, tolerates small absolute growth of tiny chunks and caps chunks without a budget', () => {
    const budget = { tolerance: 0.15, minSlack: 512, newChunkLimit: 20000, chunks: { big: 10000, tiny: 200, gone: 50 } };
    assert.deepEqual(bundle.compareToBudget({ big: 11500, tiny: 700 }, budget).failed, []);
    const { rows, failed } = bundle.compareToBudget({ big: 11501, tiny: 713, fresh: 25000, small: 100 }, budget);
    assert.deepEqual(failed.map(r => r.key).sort(), ['big', 'fresh', 'tiny']);
    assert.equal(rows.find(r => r.key === 'gone').status, 'entfallen');
    assert.equal(rows.find(r => r.key === 'small').status, 'neu');
  });

  test('the CLI passes against its own --update and fails once the entry grows by more than 15 %', () => {
    const dist = path.join(dir, 'dist');
    const budgetFile = path.join(dir, 'budget.json');
    fakeDist(dist);
    const run = (...args) => spawnSync(process.execPath, [CHECK_SCRIPT, '--dist', dist, '--budget', budgetFile, ...args], { encoding: 'utf8' });
    assert.equal(run().status, 1, 'no budget file yet');
    assert.equal(run('--update').status, 0);
    const written = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    assert.equal(written.tolerance, 0.15);
    assert.ok(written.chunks['index.html'] > 0);
    assert.equal(run().status, 0);
    fakeDist(dist, { entryBytes: 4000 * 1.4 });
    const res = run();
    assert.equal(res.status, 1);
    assert.match(res.stdout, /index\.html\s.*zu groß/);
    assert.match(res.stderr, /Bundle-Budget überschritten/);
  });

  test('the committed budget covers the entry, its CSS, the route chunks and the initial load', () => {
    const budget = JSON.parse(fs.readFileSync(path.join(root, 'frontend', 'bundle-budget.json'), 'utf8'));
    assert.equal(budget.tolerance, 0.15);
    for (const key of ['index.html', 'index.html (css)', 'src/Dashboard.jsx', 'src/MangaDetail.jsx', bundle.INITIAL_KEY]) {
      assert.ok(Number.isInteger(budget.chunks[key]) && budget.chunks[key] > 0, key);
    }
    assert.ok(!('_Dashboard.js' in budget.chunks) && !('_MangaDetail.js' in budget.chunks), 'route chunks are keyed by source path');
  });
});

describe('build-time precompression (frontend/precompress.js)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-precompress-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('writes .br and .gz next to compressible assets over 1 KB that decode to the original', async () => {
    const { precompressDir } = await import(pathToFileURL(path.join(root, 'frontend', 'precompress.js')).href);
    const big = Buffer.from('const value = "manga shelf";\n'.repeat(200));
    write(path.join(dir, 'app.js'), big);
    write(path.join(dir, 'nested/style.css'), big);
    write(path.join(dir, 'small.js'), 'x');
    write(path.join(dir, 'font.woff2'), big);
    write(path.join(dir, 'random.js'), noise(4000));
    const written = precompressDir(dir).map(f => path.relative(dir, f)).sort();
    assert.deepEqual(written, ['app.js.br', 'app.js.gz', 'nested/style.css.br', 'nested/style.css.gz', 'random.js.br', 'random.js.gz'].map(p => p.split('/').join(path.sep)));
    assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, 'app.js.br'))), big);
    assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'app.js.gz'))), big);
    assert.ok(fs.statSync(path.join(dir, 'app.js.br')).size < big.length);
  });

  test('vite.config.js runs it on the assets folder and writes the manifest the budget reads', () => {
    const config = fs.readFileSync(path.join(root, 'frontend', 'vite.config.js'), 'utf8');
    assert.match(config, /precompressDir\(path\.join\(outDir, 'assets'\)\)/);
    assert.match(config, /manifest: true/);
  });
});

describe('scripts/dev.js', () => {
  test('backend under node --watch with data-dev and debug logs, Vite through node', () => {
    const env = { PATH: process.env.PATH };
    const config = devConfig(env, root);
    assert.equal(config.dataDir, path.join(root, 'data-dev'));
    const [api, web] = config.processes;
    assert.equal(api.command, process.execPath);
    assert.deepEqual(api.args, ['--watch', path.join(root, 'index.js')]);
    assert.equal(api.env.DATA_DIR, path.join(root, 'data-dev'));
    assert.equal(api.env.LOG_LEVEL, 'debug');
    assert.equal(web.command, process.execPath);
    assert.match(web.args[0], /vite[\\/]bin[\\/]vite\.js$/);
    assert.equal(web.cwd, path.join(root, 'frontend'));
    assert.equal(config.seed.env.DATA_DIR, config.dataDir);
    assert.ok(config.seed.args.includes('--data-dir'));
  });

  test('DATA_DIR and LOG_LEVEL override the defaults; an existing database is not seeded again', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-dev-'));
    try {
      assert.equal(devConfig({ DATA_DIR: dataDir }, root).needsSeed, true);
      fs.writeFileSync(path.join(dataDir, 'manga.db'), '');
      const config = devConfig({ DATA_DIR: dataDir, LOG_LEVEL: 'info' }, root);
      assert.equal(config.needsSeed, false);
      assert.equal(config.processes[0].env.LOG_LEVEL, 'info');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('output is prefixed per line, also across chunk borders and CRLF', () => {
    const out = [];
    const p = linePrefixer('[api]', s => out.push(s));
    p.push('one\r\ntw');
    p.push(Buffer.from('o\nthr'));
    p.flush();
    p.flush();
    assert.deepEqual(out, ['[api] one\n', '[api] two\n', '[api] thr\n']);
  });

  test('npm run dev uses the script, npm start stays plain', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(scripts.start, 'node index.js');
    assert.equal(scripts.dev, 'node scripts/dev.js');
    assert.equal(scripts['dev:api'], 'node index.js');
    assert.ok(!/seed|bench/.test(scripts.test), 'seed and bench stay out of npm test');
  });
});
