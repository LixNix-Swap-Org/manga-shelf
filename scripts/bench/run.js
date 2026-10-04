// Headless API benchmark against a seeded temp database (not part of npm test).
//   npm run bench -- [--series 1500] [--volumes 45000] [--seed 42] [--runs 5] [--out bench.json]
//                    [--budget bench-budget.json] [--write-budget bench-budget.json]
// Prints JSON: median/min/max per endpoint, /api/health latency while a snapshot is being built, server peak RSS.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { fork, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_TOLERANCE = 0.3;

function parseArgs(argv) {
  const opts = { series: 1500, volumes: 45000, seed: 42, runs: 5 };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[i + 1];
    if (['--series', '--volumes', '--seed', '--runs'].includes(name)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${name} braucht eine ganze Zahl >= 1`);
      opts[name.slice(2)] = n;
    } else if (['--out', '--budget', '--write-budget'].includes(name)) {
      opts[name.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
    } else {
      throw new Error(`Unbekanntes Argument: ${name}`);
    }
    i++;
  }
  return opts;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = n => Math.round(n * 10) / 10;
  return { median: round(sorted[Math.floor(sorted.length / 2)]), min: round(sorted[0]), max: round(sorted[sorted.length - 1]) };
}

function request(base, urlPath, { method = 'GET', cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const started = process.hrtime.bigint();
    const req = http.request(base + urlPath, {
      method,
      headers: {
        'Accept-Encoding': 'gzip, br',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let bytes = 0;
      const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (!res.headers['content-encoding']) chunks.push(chunk); });
      res.on('end', () => resolve({
        status: res.statusCode,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        bytes,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startServer(dataDir) {
  const env = { ...process.env, DATA_DIR: dataDir, MANGA_SHELF_NO_LISTEN: '1', LOG_LEVEL: process.env.LOG_LEVEL || 'error' };
  delete env.JWT_SECRET;
  const child = fork(__filename, ['--serve'], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const waiting = new Map();
  let seq = 0;
  return new Promise((resolve, reject) => {
    child.on('exit', code => reject(new Error(`Benchmark-Server beendet (Code ${code})`)));
    child.on('message', msg => {
      if (msg.type === 'ready') {
        resolve({
          child,
          port: msg.port,
          largest: msg.largest,
          call: type => new Promise(res => { const id = ++seq; waiting.set(id, res); child.send({ type, id }); })
        });
        return;
      }
      const done = waiting.get(msg.id);
      if (done) { waiting.delete(msg.id); done(msg); }
    });
  });
}

function serve() {
  const app = require(path.join(ROOT, 'index.js'));
  const { db, closeDb } = require(path.join(ROOT, 'db.js'));
  const largest = db.prepare('SELECT manga_id AS id, count(*) AS entries FROM volumes GROUP BY manga_id ORDER BY entries DESC, manga_id LIMIT 1').get();
  const server = app.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port, largest }));
  process.on('message', msg => {
    if (msg.type === 'usage') {
      process.send({ id: msg.id, maxRssKb: process.resourceUsage().maxRSS, rssKb: Math.round(process.memoryUsage().rss / 1024) });
    } else if (msg.type === 'stop') {
      server.close(() => { closeDb(); process.exit(0); });
      server.closeAllConnections();
    }
  });
}

function compareToBudget(result, budget) {
  const tolerance = budget.tolerance ?? DEFAULT_TOLERANCE;
  const regressions = [];
  for (const [name, limit] of Object.entries(budget.endpoints || {})) {
    const got = result.endpoints[name];
    if (got && got.median > limit * (1 + tolerance)) regressions.push(`${name}: ${got.median} ms > ${limit} ms + ${Math.round(tolerance * 100)} %`);
  }
  if (budget.healthDuringSnapshotMs && result.healthDuringSnapshot.median > budget.healthDuringSnapshotMs * (1 + tolerance)) {
    regressions.push(`/api/health während Snapshot: ${result.healthDuringSnapshot.median} ms > ${budget.healthDuringSnapshotMs} ms + ${Math.round(tolerance * 100)} %`);
  }
  if (budget.maxRssMb && result.server.maxRssMb > budget.maxRssMb * (1 + tolerance)) {
    regressions.push(`Spitzen-RSS: ${result.server.maxRssMb} MB > ${budget.maxRssMb} MB + ${Math.round(tolerance * 100)} %`);
  }
  return regressions;
}

function budgetFrom(result, tolerance = DEFAULT_TOLERANCE) {
  return {
    tolerance,
    dataset: result.dataset,
    endpoints: Object.fromEntries(Object.entries(result.endpoints).map(([name, s]) => [name, s.median])),
    healthDuringSnapshotMs: result.healthDuringSnapshot.median,
    maxRssMb: result.server.maxRssMb
  };
}

async function runBench(opts) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-bench-'));
  let server;
  try {
    const seeded = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed.js'), '--data-dir', dataDir,
      '--series', String(opts.series), '--volumes', String(opts.volumes), '--seed', String(opts.seed)], { encoding: 'utf8' });
    if (seeded.status !== 0) throw new Error(`Seed fehlgeschlagen: ${seeded.stderr || seeded.stdout}`);
    const seedInfo = JSON.parse(seeded.stdout.trim().split('\n').pop());
    const admin = JSON.parse(fs.readFileSync(seedInfo.usersFile, 'utf8')).users.find(u => u.role === 'admin');

    server = await startServer(dataDir);
    const base = `http://127.0.0.1:${server.port}`;
    const login = await request(base, '/api/auth/login', { method: 'POST', body: { username: admin.username, password: admin.password } });
    if (login.status !== 200) throw new Error(`Login fehlgeschlagen: ${login.status} ${login.text}`);
    const cookie = [].concat(login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    const endpoints = [
      ['GET /api/mangas', '/api/mangas'],
      ['GET /api/mangas/:id', `/api/mangas/${server.largest.id}`],
      ['GET /api/offline-snapshot', '/api/offline-snapshot'],
      ['GET /api/stats', '/api/stats'],
      ['GET /api/shopping-list', '/api/shopping-list?include_others=1'],
      ['GET /api/export/csv', '/api/export/csv'],
      ['GET /api/release-radar', '/api/release-radar']
    ];
    const result = {
      node: process.version,
      dataset: { series: opts.series, volumes: opts.volumes, seed: opts.seed, largestSeriesEntries: server.largest.entries },
      runs: opts.runs,
      endpoints: {}
    };
    for (const [name, urlPath] of endpoints) {
      const first = await request(base, urlPath, { cookie });
      if (first.status !== 200) throw new Error(`${name} -> ${first.status}`);
      const times = [];
      for (let i = 0; i < opts.runs; i++) times.push((await request(base, urlPath, { cookie })).ms);
      result.endpoints[name] = { ...stats(times), firstMs: Math.round(first.ms * 10) / 10, wireBytes: first.bytes };
    }

    // the event loop is blocked while the snapshot is built: /api/health fired 50 ms into it waits that long
    const health = [];
    for (let i = 0; i < Math.max(3, opts.runs); i++) {
      const snapshot = request(base, '/api/offline-snapshot', { cookie });
      await new Promise(r => setTimeout(r, 50));
      health.push((await request(base, '/api/health')).ms);
      await snapshot;
    }
    result.healthDuringSnapshot = stats(health);

    const usage = await server.call('usage');
    result.server = { maxRssMb: Math.round(usage.maxRssKb / 1024), rssMb: Math.round(usage.rssKb / 1024) };
    return result;
  } finally {
    if (server) {
      server.child.removeAllListeners('exit');
      const exited = new Promise(r => server.child.once('exit', r));
      server.child.send({ type: 'stop' });
      await Promise.race([exited, new Promise(r => setTimeout(r, 5000).unref())]);
      if (server.child.exitCode === null) server.child.kill();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const result = await runBench(opts);
  const json = JSON.stringify(result, null, 2);
  console.log(json);
  if (opts.out) fs.writeFileSync(opts.out, `${json}\n`);
  if (opts.writeBudget) fs.writeFileSync(opts.writeBudget, `${JSON.stringify(budgetFrom(result), null, 2)}\n`);
  if (opts.budget) {
    const regressions = compareToBudget(result, JSON.parse(fs.readFileSync(opts.budget, 'utf8')));
    if (regressions.length) {
      console.error(`Regression gegenüber ${opts.budget}:\n  ${regressions.join('\n  ')}`);
      return 1;
    }
  }
  return 0;
}

if (require.main === module) {
  if (process.argv[2] === '--serve') {
    serve();
  } else {
    main(process.argv.slice(2))
      .then(code => { process.exitCode = code; })
      .catch(err => { console.error(`Benchmark fehlgeschlagen: ${err.message}`); process.exitCode = 1; });
  }
}

module.exports = { parseArgs, stats, compareToBudget, budgetFrom, runBench };
