// Pterodactyl egg and deployment files: egg validity, install/startup commands and the Docker context.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const https = require('https');
const { X509Certificate } = require('crypto');
const { spawn, spawnSync } = require('child_process');

const { resolveListen, serverTrust, probe, check } = require('../healthcheck');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const engineMajor = Number(/(\d+)/.exec(pkg.engines.node)[1]);
const NO_OPENSSL = spawnSync('openssl', ['version']).error ? 'openssl not installed' : false;

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function resolveImport(file) {
  for (const candidate of [file, `${file}.js`, `${file}.jsx`, `${file}.json`, path.join(file, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// top-level repository folders outside frontend/ that the frontend sources reach through relative imports (transitively)
function frontendExternalDirs() {
  const frontend = path.join(root, 'frontend');
  const queue = [path.join(frontend, 'vite.config.js')];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name) && !full.includes(`${path.sep}__tests__${path.sep}`)) queue.push(full);
    }
  };
  walk(path.join(frontend, 'src'));
  const seen = new Set();
  const dirs = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(js|jsx|mjs|cjs)$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(IMPORT_RE)) {
      const target = resolveImport(path.resolve(path.dirname(file), m[1]));
      if (!target) continue;
      const rel = path.relative(root, target).split(path.sep);
      if (rel[0] !== 'frontend' && rel[0] !== '..') dirs.add(rel[0]);
      queue.push(target);
    }
  }
  return dirs;
}

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
    assert.match(v.description, /enter its address/);
    assert.match(v.description, /never the whole subnet/);
    assert.match(v.description, /reachable only through the proxy/);
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
    const froms = [...dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)].map(m => m[1]);
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

  test('compose pulls the published image and keeps the local build as a comment', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, /^\s+image: ghcr\.io\/lixnix-swap-org\/manga-shelf:latest$/m);
    assert.match(compose, /^\s+# build: \.$/m);
    assert.doesNotMatch(compose, /^\s+build:/m);
  });

  test('multi-arch: only the runtime stage runs per target platform; labels, data folder and port are declared', () => {
    const stages = [...dockerfile.matchAll(/^FROM (--platform=\S+ )?\S+ AS (\S+)/gm)].map(m => ({ platform: m[1], name: m[2] }));
    assert.deepEqual(stages.map(s => s.name), ['frontend-builder', 'backend-files', 'runner']);
    assert.equal(stages[0].platform, '--platform=$BUILDPLATFORM ');
    assert.equal(stages[1].platform, '--platform=$BUILDPLATFORM ');
    assert.equal(stages[2].platform, undefined, 'the runtime stage must be built for the target platform');
    const runner = dockerfile.slice(dockerfile.indexOf('AS runner'));
    assert.match(runner, /npm ci --omit=dev --ignore-scripts/, 'production dependencies are installed in the target platform stage');
    assert.match(runner, /org\.opencontainers\.image\.version="\$\{VERSION\}"/);
    assert.match(runner, /org\.opencontainers\.image\.source="https:\/\/github\.com\/LixNix-Swap-Org\/manga-shelf"/);
    assert.match(runner, /DATA_DIR=\/app\/data/);
    assert.match(runner, /VOLUME \["\/app\/data"\]/);
    assert.match(runner, /EXPOSE 3000/);
  });

  test('the build context leaves out the apps, tests and workflows', () => {
    const ignored = read('.dockerignore').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const entry of ['desktop/', 'mobile/', 'test/', '.github/', 'frontend/dist/']) {
      assert.ok(ignored.includes(entry), `.dockerignore misses ${entry}`);
    }
  });

  test('the frontend stage copies every folder outside frontend/ that the web build imports', () => {
    const stage = dockerfile.slice(dockerfile.indexOf('AS frontend-builder'), dockerfile.indexOf('AS backend-files'));
    assert.match(stage, /^WORKDIR \/app\/frontend$/m);
    const copies = [...stage.matchAll(/^COPY (\S+) (\S+)$/gm)].map(m => ({ from: m[1], to: m[2] }));
    const ignored = read('.dockerignore').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const outside = frontendExternalDirs();
    assert.ok(outside.has('core'), 'the scan should find the ../core imports of src/local');
    for (const dir of outside) {
      assert.ok(copies.some(c => c.from === `${dir}/` && c.to === `/app/${dir}/`), `frontend-builder misses COPY ${dir}/ /app/${dir}/`);
      assert.ok(!ignored.includes(`${dir}/`), `.dockerignore drops ${dir}/`);
      const build = stage.indexOf('RUN npm run build');
      assert.ok(stage.indexOf(`COPY ${dir}/`) < build, `COPY ${dir}/ must come before the build`);
    }
  });

  test('compose and .env.example suggest a proxy address, not a hop count, and a port bound to 127.0.0.1', () => {
    const compose = read('docker-compose.yml');
    const env = read('.env.example');
    assert.match(compose, /# - "127\.0\.0\.1:3000:3000"/);
    for (const text of [compose, env]) {
      assert.doesNotMatch(text, /^\s*#\s*-?\s*TRUST_PROXY=\d+\s*$/m, 'the example value must not be a hop count');
      assert.match(text, /TRUST_PROXY=loopback, 172\.18\.0\.1\b/);
      assert.doesNotMatch(text, /TRUST_PROXY=loopback, 172\.18\.0\.0\/16/);
      assert.match(text, /127\.0\.0\.1:3000:3000/);
    }
  });
});

describe('server packages (nfpm)', () => {
  const nfpm = read('nfpm.yaml');

  test('every packaged file exists and the binary lands in /usr/bin', () => {
    for (const m of nfpm.matchAll(/^\s+(?:- src|postinstall|preremove|postremove): (\S+)$/gm)) {
      if (m[1].startsWith('dist/')) continue;
      assert.ok(fs.existsSync(path.join(root, m[1])), `${m[1]} fehlt`);
    }
    assert.match(nfpm, /src: dist\/server\/manga-shelf-server-linux\n\s+dst: \/usr\/bin\/manga-shelf-server/);
    assert.match(nfpm, /dst: \/usr\/lib\/systemd\/system\/manga-shelf\.service/);
    assert.match(nfpm, /^version: \$\{VERSION\}$/m);
    assert.match(nfpm, /^arch: \$\{ARCH\}$/m);
  });

  test('maintainer scripts are POSIX sh, create the user and never delete data', () => {
    for (const name of ['postinstall', 'preremove', 'postremove']) {
      const file = path.join(root, 'scripts/server-bin/packaging', `${name}.sh`);
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(text.startsWith('#!/bin/sh\n'), name);
      assert.doesNotMatch(text, /rm -rf?\s+\/var\/lib/, `${name} deletes data`);
      if (process.platform !== 'win32') assert.equal(spawnSync('sh', ['-n', file]).status, 0, `${name} has a syntax error`);
    }
    const post = fs.readFileSync(path.join(root, 'scripts/server-bin/packaging/postinstall.sh'), 'utf8');
    assert.match(post, /useradd --system --user-group --home-dir \/var\/lib\/manga-shelf/);
    assert.match(post, /chown manga-shelf:manga-shelf \/var\/lib\/manga-shelf/);
    const pre = fs.readFileSync(path.join(root, 'scripts/server-bin/packaging/preremove.sh'), 'utf8');
    assert.match(pre, /remove\|0\)/, 'an upgrade must not stop and disable the service');
  });
});

describe('server service definitions', () => {
  const services = require('../scripts/server-bin/services');

  test('Windows task arguments are quoted the way CommandLineToArgvW splits them', () => {
    const argsFor = (dataDir) => {
      const task = services.windowsTaskXml({ binary: 'C:\\x.exe', args: services.serverArgs({ dataDir }) });
      return /<Arguments>(.*)<\/Arguments>/.exec(task)[1].replace(/&quot;/g, '"').replace('--no-console --data-dir ', '');
    };
    assert.equal(argsFor('C:\\ProgramData\\manga-shelf\\data'), 'C:\\ProgramData\\manga-shelf\\data', 'no quotes without a space');
    assert.equal(argsFor('C:\\Program Files\\Manga'), '"C:\\Program Files\\Manga"', 'backslashes inside stay single');
    assert.equal(argsFor('D:\\Manga Daten\\'), '"D:\\Manga Daten\\\\"', 'a trailing backslash must not escape the closing quote');
    assert.equal(argsFor('D:\\a "b"'), '"D:\\a \\"b\\""');
    assert.equal(argsFor('D:\\x\\"y z'), '"D:\\x\\\\\\"y z"', 'backslashes before a quote are doubled, plus one for the quote');
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

  test('trusts the certificates of the server\'s own file, checked against the name they are issued for', { skip: NO_OPENSSL }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-hc-trust-'));
    try {
      const cert = (file, subject, ext) => selfSignedCert(dir, file, subject, ext).cert;
      const san = cert('san', '/CN=ignored.example', 'subjectAltName=DNS:manga.example.com,DNS:www.example.com,IP:192.168.1.5');
      const trust = serverTrust(san);
      assert.equal(trust.name, 'manga.example.com', 'the first DNS name wins over the CN and IP addresses');
      assert.equal(trust.ca.length, tls.rootCertificates.length + 1);
      assert.equal(serverTrust(cert('wild', '/CN=x', 'subjectAltName=DNS:*.example.org')).name, 'healthcheck.example.org');
      const ip = cert('ip', '/CN=nas', 'subjectAltName=IP:192.168.1.5');
      assert.equal(serverTrust(ip).name, '192.168.1.5');
      assert.equal(serverTrust(cert('cn', '/CN=shelf.lan')).name, 'shelf.lan');
      for (const [file, subject] of [['cnip', '/CN=192.168.1.5'], ['text', '/CN=Manga Shelf'], ['noname', '/O=Home'], ['tld', '/CN=*.lan']]) {
        const pem = cert(file, subject);
        const pinned = serverTrust(pem);
        assert.equal(pinned.name, null, subject);
        assert.equal(pinned.pin, new X509Certificate(fs.readFileSync(pem)).fingerprint256, subject);
      }
      const chain = path.join(dir, 'fullchain.pem');
      fs.writeFileSync(chain, fs.readFileSync(san, 'utf8') + fs.readFileSync(ip, 'utf8'));
      assert.equal(serverTrust(chain).name, 'manga.example.com', 'the leaf comes first');
      assert.equal(serverTrust(chain).ca.length, tls.rootCertificates.length + 2);
      fs.writeFileSync(path.join(dir, 'garbage.pem'), 'c');
      assert.equal(serverTrust(path.join(dir, 'garbage.pem')), null);
      assert.equal(serverTrust(path.join(dir, 'missing.pem')), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function selfSignedCert(dir, name, subject, ext) {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.pem`);
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', subject,
    ...(ext ? ['-addext', ext] : []), '-keyout', key, '-out', cert], { stdio: 'ignore' });
  assert.equal(gen.status, 0, 'openssl could not create a test certificate');
  return { key, cert };
}

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

  test('passes when the app serves native HTTPS with a certificate for another host', { skip: NO_OPENSSL }, async () => {
    const env = { ...baseEnv('tls'), SERVER_PORT: String(await freePort()) };
    const { key, cert } = selfSignedCert(env.DATA_DIR, 'server', '/CN=manga.example.com');
    env.SSL_KEY_PATH = key;
    env.SSL_CERT_PATH = cert;
    servers.push(await startApp(env));
    assert.equal(await runHealthcheck(env), 0);
    const port = Number(env.SERVER_PORT);
    const trust = serverTrust(cert);
    assert.equal(await probe(trust, port), true, 'the app should answer over HTTPS');
    assert.equal(await probe(null, port), false, 'the app should not answer plain HTTP when TLS is on');
    assert.equal(await probe(serverTrust(selfSignedCert(env.DATA_DIR, 'other', '/CN=manga.example.com').cert), port), false);
    assert.equal(await probe({ ...trust, name: 'evil.example.com' }, port), false);
  });

  test('passes with a certificate that names no checkable host, and only with that certificate', { skip: NO_OPENSSL }, async () => {
    for (const [name, subject] of [['cnlocal', '/CN=127.0.0.1'], ['cnip', '/CN=192.168.1.5'], ['text', '/CN=Manga Shelf'], ['noname', '/O=Home']]) {
      const dataDir = path.join(dir, name);
      fs.mkdirSync(dataDir, { recursive: true });
      const { key, cert } = selfSignedCert(dataDir, 'server', subject);
      const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
        res.writeHead(req.url === '/api/health' ? 200 : 404).end();
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();
      try {
        assert.equal(await check({ SERVER_PORT: String(port), SSL_KEY_PATH: key, SSL_CERT_PATH: cert }, dataDir), true, subject);
        const other = selfSignedCert(dataDir, 'other', subject).cert;
        assert.equal(await probe(serverTrust(other), port), false, `${subject}: another certificate with the same subject`);
      } finally {
        await new Promise(r => server.close(r));
      }
    }
  });
});
