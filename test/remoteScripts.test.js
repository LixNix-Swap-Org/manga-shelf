const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { resolveTarget, assertSecureTarget, credentials } = require('../scripts/lib/remote');
const { planSeed, DEMO_SERIES } = require('../scripts/seed-remote');

const scriptsDir = path.join(__dirname, '..', 'scripts');

describe('resolveTarget', () => {
  test('the command line wins over REMOTE_HOST/REMOTE_PORT and REMOTE_URL', () => {
    const env = { REMOTE_HOST: 'localhost', REMOTE_PORT: '3000', REMOTE_URL: 'https://env.example.com' };
    assert.equal(resolveTarget(['my-test-host', '4000'], env).baseUrl, 'http://my-test-host:4000/');
    assert.equal(resolveTarget(['https://cli.example.com/shelf'], env).baseUrl, 'https://cli.example.com/shelf/');
    assert.equal(resolveTarget(['my-test-host', '4000'], env).source, 'Kommandozeile');
  });

  test('REMOTE_URL beats the host/port pair; the pair defaults to http', () => {
    assert.equal(resolveTarget([], { REMOTE_URL: 'https://manga.example.com/app', REMOTE_HOST: 'x' }).baseUrl, 'https://manga.example.com/app/');
    assert.equal(resolveTarget([], { REMOTE_HOST: '10.0.0.5', REMOTE_PORT: '8080' }).baseUrl, 'http://10.0.0.5:8080/');
    assert.equal(resolveTarget([], {}).baseUrl, 'http://localhost:3000/');
  });

  test('flags are not taken for the host', () => {
    assert.equal(resolveTarget(['--wipe', 'host.lan', '--yes'], {}).baseUrl, 'http://host.lan:3000/');
  });

  test('invalid ports are rejected', () => {
    for (const port of ['abc', '0', '70000', '12.5']) {
      assert.throws(() => resolveTarget(['host', port], {}), /Ungültiger Port/, port);
    }
    assert.throws(() => resolveTarget([], { REMOTE_URL: 'ftp://x' }), /Nur http/);
  });

  test('the password never goes over plain http to another host unless allowed', () => {
    assert.equal(resolveTarget(['localhost'], {}).insecure, false);
    assert.equal(resolveTarget(['127.0.0.1'], {}).insecure, false);
    assert.equal(resolveTarget(['https://manga.example.com'], {}).insecure, false);
    const lan = resolveTarget(['192.168.1.20'], {});
    assert.equal(lan.insecure, true);
    assert.throws(() => assertSecureTarget(lan, {}), /unverschlüsselt/);
    assert.doesNotThrow(() => assertSecureTarget(lan, { REMOTE_ALLOW_HTTP: '1' }));
  });

  test('REMOTE_USER/REMOTE_PASS come before ADMIN_USER/ADMIN_PASS', () => {
    assert.deepEqual(credentials({ REMOTE_USER: 'r', ADMIN_USER: 'a', ADMIN_PASS: 'p' }), { username: 'r', password: 'p' });
    assert.deepEqual(credentials({}), { username: 'admin', password: '' });
  });
});

describe('planSeed', () => {
  const existing = [{ id: 1, title: 'One Piece' }, { id: 2, title: 'Meine echte Reihe' }];

  test('by default existing demo titles are skipped and nothing is deleted', () => {
    const plan = planSeed(existing, { wipe: false });
    assert.deepEqual(plan.toDelete, []);
    assert.deepEqual(plan.skipped.map(m => m.title), ['One Piece']);
    assert.equal(plan.toCreate.length, DEMO_SERIES.length - 1);
  });

  test('--wipe only ever deletes demo series', () => {
    const plan = planSeed([...existing, { id: 3, title: ' one piece ' }], { wipe: true });
    assert.deepEqual(plan.toDelete.map(m => m.id), [1, 3]);
    assert.equal(plan.toCreate.length, DEMO_SERIES.length);
  });
});

// A fake instance that records every request the scripts send.
describe('scripts against a stub instance', () => {
  let server;
  let port;
  let requests;
  let mangas;
  let nextId;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        requests.push(`${req.method} ${req.url}`);
        const json = (status, data, headers = {}) => {
          res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
          res.end(JSON.stringify(data));
        };
        if (req.method === 'POST' && req.url === '/api/auth/login') {
          const { password } = JSON.parse(body || '{}');
          return password === 'right' ? json(200, { ok: true }, { 'Set-Cookie': 'token=abc; HttpOnly; Path=/' }) : json(401, { error: 'Falsch' });
        }
        if (req.headers.cookie !== 'token=abc') return json(401, { error: 'Nicht angemeldet' });
        if (req.method === 'GET' && req.url === '/api/mangas') return json(200, mangas);
        const one = /^\/api\/mangas\/(\d+)$/.exec(req.url);
        if (one && req.method === 'GET') return json(200, { ...mangas.find(m => m.id === Number(one[1])), volumes: [] });
        if (one && req.method === 'DELETE') {
          mangas = mangas.filter(m => m.id !== Number(one[1]));
          return json(200, { ok: true });
        }
        if (req.method === 'POST' && req.url === '/api/mangas') {
          const m = { id: nextId++, ...JSON.parse(body) };
          mangas.push(m);
          return json(201, m);
        }
        if (req.method === 'POST' && req.url === '/api/volumes') return json(201, { id: nextId++ });
        return json(404, { error: 'unknown' });
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  after(() => new Promise(r => server.close(r)));

  beforeEach(() => {
    requests = [];
    mangas = [{ id: 1, title: 'One Piece' }, { id: 2, title: 'Meine echte Reihe' }];
    nextId = 10;
  });

  function runScript(name, args, env = {}) {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(scriptsDir, name), ...args], {
        cwd: os.tmpdir(),
        env: { PATH: process.env.PATH, SEED_SKIP_COVERS: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('exit', code => resolve({ code, out }));
    });
  }

  test('seed-remote: the command-line target wins over REMOTE_HOST/REMOTE_PORT', async () => {
    const res = await runScript('seed-remote.js', ['127.0.0.1', '1'], { REMOTE_HOST: '127.0.0.1', REMOTE_PORT: String(port), REMOTE_PASS: 'right' });
    assert.notEqual(res.code, 0);
    assert.deepEqual(requests, [], 'the instance from the environment must not be contacted');
  });

  test('seed-remote: keeps every existing series by default', async () => {
    const res = await runScript('seed-remote.js', ['127.0.0.1', String(port)], { REMOTE_PASS: 'right' });
    assert.equal(res.code, 0, res.out);
    assert.ok(!requests.some(r => r.startsWith('DELETE')), requests.join('\n'));
    assert.deepEqual(mangas.map(m => m.title), ['One Piece', 'Meine echte Reihe', 'Spy × Family', 'Demon Slayer: Kimetsu no Yaiba']);
  });

  test('seed-remote: --wipe without a terminal needs --yes', async () => {
    const res = await runScript('seed-remote.js', ['127.0.0.1', String(port), '--wipe'], { REMOTE_PASS: 'right' });
    assert.notEqual(res.code, 0);
    assert.match(res.out, /--yes/);
    assert.ok(!requests.some(r => r.startsWith('DELETE')));
  });

  test('seed-remote: --wipe --yes replaces only the demo series', async () => {
    const res = await runScript('seed-remote.js', ['127.0.0.1', String(port), '--wipe', '--yes'], { REMOTE_PASS: 'right' });
    assert.equal(res.code, 0, res.out);
    assert.deepEqual(requests.filter(r => r.startsWith('DELETE')), ['DELETE /api/mangas/1']);
    assert.ok(mangas.some(m => m.title === 'Meine echte Reihe'));
    assert.equal(mangas.filter(m => m.title === 'One Piece').length, 1);
  });

  test('check-remote: exits 1 on a wrong password', async () => {
    const res = await runScript('check-remote.js', ['127.0.0.1', String(port)], { REMOTE_PASS: 'wrong' });
    assert.equal(res.code, 1);
    assert.match(res.out, /Login als "admin" fehlgeschlagen \(Status 401\)/);
  });

  test('check-remote: exits 1 when nothing listens', async () => {
    const res = await runScript('check-remote.js', ['127.0.0.1', '1'], { REMOTE_PASS: 'right' });
    assert.equal(res.code, 1);
  });

  test('check-remote: lists the series and exits 0', async () => {
    const res = await runScript('check-remote.js', [`http://127.0.0.1:${port}`], { REMOTE_PASS: 'right' });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /Total Mangas: 2/);
  });

  test('check-remote: refuses plain http to another host', async () => {
    const res = await runScript('check-remote.js', ['192.0.2.1', String(port)], { REMOTE_PASS: 'right' });
    assert.equal(res.code, 1);
    assert.match(res.out, /unverschlüsselt/);
  });
});
