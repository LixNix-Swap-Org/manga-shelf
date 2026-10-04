const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { resolveListen, probe } = require('../healthcheck');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const engineMajor = Number(/(\d+)/.exec(pkg.engines.node)[1]);

describe('Pterodactyl egg', () => {
  const egg = JSON.parse(read('egg-manga-shelf.json'));
  const install = egg.scripts.installation;

  test('is a PTDL_v2 export', () => {
    assert.equal(egg.meta.version, 'PTDL_v2');
  });

  test('the install entrypoint exists in the install image', () => {
    const shell = ['ash', 'sh', 'bash'].includes(install.entrypoint) ? install.entrypoint : null;
    assert.ok(shell, `unexpected entrypoint ${install.entrypoint}`);
    // stock Alpine images have no bash
    if (/alpine/.test(install.container) && !/installers:debian|bash/.test(install.container)) {
      assert.ok(['ash', 'sh'].includes(shell), `${install.container} cannot run ${shell}`);
    }
    assert.ok(install.script.startsWith(`#!/bin/${shell}\n`), 'the shebang does not match the entrypoint');
    assert.ok(!install.script.includes('\r'), 'install script must use \\n line endings');
  });

  test('runtime image satisfies the Node engine of package.json', () => {
    const majors = Object.values(egg.docker_images).map(img => Number((/nodejs_(\d+)/.exec(img) || [])[1]));
    assert.ok(majors.some(m => m >= engineMajor), `no nodejs_${engineMajor}+ image in ${JSON.stringify(egg.docker_images)}`);
  });

  test('every "done" string is printed by index.js and no placeholder is left', () => {
    const done = JSON.parse(egg.config.startup).done;
    const index = read('index.js');
    assert.ok(done.length > 0);
    for (const line of done) {
      assert.doesNotMatch(line, /change this text/);
      assert.ok(index.includes(line), `index.js never prints "${line}"`);
    }
  });

  test('the startup installs like the CI package job: production only, without install scripts', () => {
    const command = /npm install [^;)\n]+/;
    const egged = command.exec(egg.startup);
    const ci = command.exec(read('.github/workflows/ci.yml'));
    assert.ok(egged && ci, 'install command missing in the egg or the CI package job');
    assert.equal(egged[0].trim(), ci[0].trim());
    assert.match(egged[0], /--omit=dev/);
    assert.match(egged[0], /--ignore-scripts/);
  });

  test('the TRUST_PROXY text recommends the proxy address and warns about a directly reachable port', () => {
    const v = egg.variables.find(x => x.env_variable === 'TRUST_PROXY');
    assert.match(v.description, /Adresse oder Subnetz/);
    assert.match(v.description, /nur über den Proxy erreichbar/);
  });

  test('TRUST_PROXY is configurable and defaults to loopback', () => {
    const v = egg.variables.find(x => x.env_variable === 'TRUST_PROXY');
    assert.ok(v, 'TRUST_PROXY variable missing');
    assert.equal(v.default_value, require('../utils/trustProxy').DEFAULT_TRUST_PROXY);
    assert.ok(egg.variables.some(x => x.env_variable === 'SERVER_PORT'));
  });
});

describe('Docker image', () => {
  const dockerfile = read('Dockerfile');

  test('base images are pinned and new enough for node:sqlite', () => {
    const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map(m => m[1]);
    assert.ok(froms.length >= 2);
    for (const image of froms) {
      const m = /^node:(\d+)\.(\d+)\.(\d+)-alpine\d+\.\d+$/.exec(image);
      assert.ok(m, `${image} is not pinned to node:X.Y.Z-alpineA.B`);
      assert.ok(Number(m[1]) > 22 || (Number(m[1]) === 22 && Number(m[2]) >= 13), `${image} is older than Node 22.13`);
    }
  });

  test('the healthcheck uses healthcheck.js; dependencies come from the lockfile without install scripts', () => {
    assert.match(dockerfile, /HEALTHCHECK[\s\S]*healthcheck\.js/);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts && npm cache clean --force/);
  });

  test('the build context (copied whole into the backend-files stage) leaves out data, secrets and installs', () => {
    assert.match(dockerfile, /AS backend-files[\s\S]*COPY \. \./);
    const ignored = read('.dockerignore').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const entry of ['node_modules/', 'frontend/node_modules/', 'data/', 'data-dev/', '.env', '.env.*', 'ssl/', '**/*.pem', '**/*.key', '.git/']) {
      assert.ok(ignored.includes(entry), `.dockerignore misses ${entry}`);
    }
    assert.ok(ignored.includes('!.env.example'));
  });

  test('the entrypoint fixes the data folder ownership and drops to node', () => {
    assert.match(dockerfile, /ENTRYPOINT \["docker-entrypoint\.sh"\]/);
    assert.match(dockerfile, /apk add --no-cache su-exec/);
    assert.doesNotMatch(dockerfile, /^USER /m, 'USER would start the entrypoint without the rights to chown');
    const entry = read('docker-entrypoint.sh');
    assert.ok(entry.startsWith('#!/bin/sh\n'));
    assert.match(entry, /chown -R node:node/);
    assert.match(entry, /exec su-exec node "\$@"/);
    if (process.platform !== 'win32') {
      assert.equal(spawnSync('sh', ['-n', path.join(root, 'docker-entrypoint.sh')]).status, 0, 'entrypoint has a syntax error');
    }
  });

  test('compose keeps the ./data bind mount and documents TRUST_PROXY', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, /- \.\/data:\/app\/data/);
    assert.match(compose, /TRUST_PROXY/);
  });

  test('compose and .env.example suggest a proxy address, not a hop count, and a port bound to 127.0.0.1', () => {
    const compose = read('docker-compose.yml');
    const env = read('.env.example');
    assert.match(compose, /# - "127\.0\.0\.1:3000:3000"/);
    for (const text of [compose, env]) {
      assert.doesNotMatch(text, /^\s*#\s*-?\s*TRUST_PROXY=\d+\s*$/m, 'the example value must not be a hop count');
      assert.match(text, /TRUST_PROXY=loopback, 172\.18\.0\.0\/16/);
      assert.match(text, /127\.0\.0\.1:3000:3000/);
    }
  });
});

describe('healthcheck.js', () => {
  test('uses SERVER_PORT before PORT, like index.js', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-hc-'));
    try {
      assert.deepEqual(resolveListen({ SERVER_PORT: '4000', PORT: '3000' }, dir), { port: 4000, tls: false });
      assert.deepEqual(resolveListen({ PORT: '3001' }, dir), { port: 3001, tls: false });
      assert.deepEqual(resolveListen({}, dir), { port: 3000, tls: false });
      fs.mkdirSync(path.join(dir, 'ssl'));
      fs.writeFileSync(path.join(dir, 'ssl', 'privkey.pem'), 'k');
      fs.writeFileSync(path.join(dir, 'ssl', 'fullchain.pem'), 'c');
      assert.equal(resolveListen({}, dir).tls, true);
      assert.equal(resolveListen({ SSL_KEY_PATH: path.join(dir, 'missing.pem') }, dir).tls, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function runHealthcheck(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'healthcheck.js')], { env, stdio: 'ignore' });
    child.on('exit', code => resolve(code));
  });
}

async function startApp(env) {
  const server = spawn(process.execPath, [path.join(root, 'index.js')], { cwd: env.DATA_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  server.stderr.on('data', d => { stderr += d; });
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(`index.js exited: ${stderr}`);
    if (await runHealthcheck(env) === 0) return server;
    await new Promise(r => setTimeout(r, 150));
  }
  server.kill();
  throw new Error(`index.js did not become healthy: ${stderr}`);
}

describe('healthcheck.js against the real server', () => {
  let dir;
  const servers = [];

  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-hc-run-')); });
  after(async () => {
    for (const s of servers) if (s.exitCode === null) s.kill();
    await new Promise(r => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function baseEnv(name) {
    const dataDir = path.join(dir, name);
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: 'silent', SSL_KEY_PATH: path.join(dataDir, 'none.pem'), SSL_CERT_PATH: path.join(dataDir, 'none.crt') };
    delete env.SERVER_PORT;
    delete env.PORT;
    delete env.MANGA_SHELF_NO_LISTEN;
    return env;
  }

  test('passes on SERVER_PORT even when PORT points elsewhere', async () => {
    const env = { ...baseEnv('plain'), SERVER_PORT: String(await freePort()), PORT: String(await freePort()) };
    servers.push(await startApp(env));
    assert.equal(await runHealthcheck(env), 0);
    assert.equal(await runHealthcheck({ ...env, SERVER_PORT: '' }), 1, 'probing PORT must fail while the app listens on SERVER_PORT');
  });

  test('passes when the app serves native HTTPS with a certificate for another host', { skip: spawnSync('openssl', ['version']).error ? 'openssl not installed' : false }, async () => {
    const env = { ...baseEnv('tls'), SERVER_PORT: String(await freePort()) };
    env.SSL_KEY_PATH = path.join(env.DATA_DIR, 'privkey.pem');
    env.SSL_CERT_PATH = path.join(env.DATA_DIR, 'cert.pem');
    const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=manga.example.com',
      '-keyout', env.SSL_KEY_PATH, '-out', env.SSL_CERT_PATH], { stdio: 'ignore' });
    assert.equal(gen.status, 0, 'openssl could not create a test certificate');
    servers.push(await startApp(env));
    assert.equal(await runHealthcheck(env), 0);
    const port = Number(env.SERVER_PORT);
    assert.equal(await probe(true, port), true, 'the app should answer over HTTPS');
    assert.equal(await probe(false, port), false, 'the app should not answer plain HTTP when TLS is on');
  });
});
