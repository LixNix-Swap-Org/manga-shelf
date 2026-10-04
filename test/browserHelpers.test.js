// Node-side helpers of the browser suites (no browser is started here).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { findChrome, chromeCandidates } = require('./browser/chrome');
const { buildServerEnv, snapshotDatabase } = require('./browser/run');
const { benchmarkEndpoint, requestApi, latencyStats, EXTERNAL_API, waitForToast } = require('./browser/helpers');

describe('findChrome', () => {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  test('finds Chrome on macOS', () => {
    assert.equal(findChrome({ env: {}, home: '/Users/x', exists: p => p === macChrome }), macChrome);
  });

  test('finds per-user installs under ~/Applications', () => {
    const userBrave = '/Users/x/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    assert.equal(findChrome({ env: {}, home: '/Users/x', exists: p => p === userBrave }), userBrave);
  });

  test('CHROME_BIN wins over every installed browser', () => {
    assert.equal(findChrome({ env: { CHROME_BIN: '/opt/chrome' }, home: '/Users/x', exists: () => true }), '/opt/chrome');
  });

  test('throws a hint about CHROME_BIN when nothing is installed', () => {
    assert.throws(() => findChrome({ env: {}, home: '/Users/x', exists: () => false }), /CHROME_BIN/);
  });

  test('lists Linux, macOS and Windows locations', () => {
    const list = chromeCandidates({}, '/home/x');
    assert.ok(list.includes('/usr/bin/google-chrome'));
    assert.ok(list.includes(macChrome));
    assert.ok(list.some(p => p.endsWith('chrome.exe')));
  });
});

describe('test/browser/run.js', () => {
  test('the test server always gets its own port and never native HTTPS', () => {
    const env = buildServerEnv({ SERVER_PORT: '25565', PORT: '3000', SSL_KEY_PATH: '/etc/ssl/real.pem', KEEP: '1' }, { dataDir: '/tmp/x', port: 4321 });
    assert.equal(env.SERVER_PORT, '4321');
    assert.equal(env.PORT, '4321');
    assert.equal(env.DATA_DIR, '/tmp/x');
    assert.ok(env.SSL_KEY_PATH.startsWith(path.join('/tmp/x', 'no-ssl')));
    assert.ok(env.SSL_CERT_PATH.startsWith(path.join('/tmp/x', 'no-ssl')));
    assert.equal(env.KEEP, '1');
  });

  test('--db copies rows that are still in the WAL', () => {
    const { DatabaseSync } = require('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-snap-'));
    const src = path.join(dir, 'manga.db');
    const dest = path.join(dir, 'copy.db');
    const live = new DatabaseSync(src);
    try {
      live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v INTEGER);');
      const insert = live.prepare('INSERT INTO t (v) VALUES (?)');
      for (let i = 0; i < 50; i++) insert.run(i);
      assert.ok(fs.statSync(`${src}-wal`).size > 0, 'rows should still be in the WAL');

      snapshotDatabase(src, dest);
      const copy = new DatabaseSync(dest);
      try {
        assert.equal(copy.prepare('SELECT count(*) AS n FROM t').get().n, 50);
      } finally {
        copy.close();
      }
    } finally {
      live.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('performance helpers', () => {
  function stub(status) {
    return new Promise(resolve => {
      const server = http.createServer((req, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie || null }));
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  test('requestApi reports the numeric status and sends the cookie', async () => {
    const server = await stub(200);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const res = await requestApi(base, '/api/mangas', 'token=abc');
      assert.equal(res.status, 200);
      assert.ok(res.bytes > 0);
      assert.ok(res.latencyMs >= 0);
    } finally {
      server.close();
    }
  });

  test('benchmarkEndpoint fails on a 404 instead of timing it', async () => {
    const server = await stub(404);
    try {
      await assert.rejects(benchmarkEndpoint(`http://127.0.0.1:${server.address().port}`, '/api/mangas/4', '', 5), /answered 404/);
    } finally {
      server.close();
    }
  });

  test('benchmarkEndpoint summarises successful runs', async () => {
    const server = await stub(200);
    try {
      const result = await benchmarkEndpoint(`http://127.0.0.1:${server.address().port}`, '/api/stats', 'token=abc', 5);
      assert.equal(result.iterations, 5);
      assert.ok(result.minMs <= result.p50Ms && result.p50Ms <= result.maxMs);
    } finally {
      server.close();
    }
  });

  test('latencyStats picks percentiles from the sorted list', () => {
    const s = latencyStats([5, 1, 3, 2, 4]);
    assert.equal(s.minMs, 1);
    assert.equal(s.maxMs, 5);
    assert.equal(s.p50Ms, 3);
    assert.equal(s.meanMs, 3);
  });

  test('only endpoints backed by external services are exempt from the API error check', () => {
    for (const p of ['/api/lookup/isbn', '/api/manga-passion/editions', '/api/release-radar/changes', '/api/mangas/4/gaps', '/api/volumes/lookup']) {
      assert.ok(EXTERNAL_API.test(p), p);
    }
    for (const p of ['/api/mangas', '/api/mangas/4', '/api/volumes/12', '/api/backup/restore', '/api/users/3', '/api/release-radar']) {
      assert.ok(!EXTERNAL_API.test(p), p);
    }
  });
});

describe('waitForToast', () => {
  function fakeToast(kind, text, visible = true) {
    const attrs = { 'data-toast': kind };
    return {
      innerText: text,
      offsetParent: visible ? {} : null,
      attrs,
      hasAttribute: name => name in attrs,
      setAttribute: (name, value) => { attrs[name] = String(value); },
      matches: sel => sel === '[data-toast]' || sel === `[data-toast="${kind}"]`
    };
  }

  function withDocument(toasts, fn) {
    const previous = global.document;
    global.document = { querySelectorAll: sel => toasts.filter(t => t.matches(sel)) };
    return fn().finally(() => { global.document = previous; });
  }

  const page = {
    async waitForFunction(predicate, options, ...args) {
      if (!predicate(...args)) throw new Error('timeout');
      return true;
    }
  };

  test('tags the newest matching toast and returns a selector for exactly that one', () => {
    const older = fakeToast('success', '„Band 1“ als gelesen markiert Rückgängig');
    const hidden = fakeToast('success', '„Band 1“ als gelesen markiert', false);
    const newer = fakeToast('success', '„Band 1“ als gelesen markiert Rückgängig');
    const info = fakeToast('info', '„Band 1“ als gelesen markiert');
    return withDocument([older, hidden, newer, info], async () => {
      const first = await waitForToast(page, 'als gelesen markiert', { kind: 'success' });
      const match = /^\[data-e2e-toast="([^"]+)"\]$/.exec(first);
      assert.ok(match, first);
      assert.equal(newer.attrs['data-e2e-toast'], match[1]);
      assert.equal(older.attrs['data-e2e-toast'], undefined);
      assert.equal(hidden.attrs['data-e2e-toast'], undefined);
      assert.equal(info.attrs['data-e2e-toast'], undefined);

      const second = await waitForToast(page, 'als gelesen markiert', { kind: 'success' });
      assert.notEqual(second, first);
      assert.equal(`[data-e2e-toast="${older.attrs['data-e2e-toast']}"]`, second);
    });
  });

  test('throws a readable error when no toast matches', () => withDocument([fakeToast('error', 'Fehler')], async () => {
    await assert.rejects(waitForToast(page, 'gespeichert', { kind: 'success' }), /No success toast with text "gespeichert"/);
  }));
});
