// npm run dev: backend with `node --watch` plus the Vite dev server in one terminal, output prefixed [api]/[web].
// Data lives in ./data-dev (DATA_DIR overrides it); an empty one is filled with a small seeded demo collection,
// the logins are in data-dev/seed-users.json. Ctrl+C stops both.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEV_SEED = ['--series', '120', '--volumes', '2400'];

function devConfig(env = process.env, root = ROOT) {
  const dataDir = path.resolve(root, env.DATA_DIR || 'data-dev');
  const apiEnv = { ...env, DATA_DIR: dataDir, LOG_LEVEL: env.LOG_LEVEL || 'debug' };
  return {
    dataDir,
    needsSeed: !fs.existsSync(path.join(dataDir, 'manga.db')),
    seed: { command: process.execPath, args: [path.join(root, 'scripts', 'seed.js'), '--data-dir', dataDir, ...DEV_SEED], env: { ...apiEnv, LOG_LEVEL: 'warn' } },
    processes: [
      { name: 'api', command: process.execPath, args: ['--watch', path.join(root, 'index.js')], cwd: root, env: apiEnv },
      // vite's own bin through node: no npm/.cmd shim, so it behaves the same in PowerShell, cmd and POSIX shells
      { name: 'web', command: process.execPath, args: [path.join(root, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js')], cwd: path.join(root, 'frontend'), env }
    ]
  };
}

/** Returns a writer that prefixes every complete line; a trailing partial line waits for the next chunk. */
function linePrefixer(prefix, write) {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) write(`${prefix} ${line}\n`);
    },
    flush() {
      if (pending) write(`${prefix} ${pending}\n`);
      pending = '';
    }
  };
}

function main() {
  const config = devConfig();
  if (!fs.existsSync(path.join(ROOT, 'frontend', 'node_modules', 'vite'))) {
    console.error('Frontend-Abhängigkeiten fehlen: zuerst `cd frontend && npm ci`.');
    process.exit(1);
  }
  if (config.needsSeed) {
    console.log(`[dev] ${config.dataDir} ist leer, lege Demo-Daten an …`);
    const seeded = spawnSync(config.seed.command, config.seed.args, { env: config.seed.env, stdio: 'inherit' });
    if (seeded.status !== 0) process.exit(seeded.status || 1);
    console.log(`[dev] Logins: ${path.join(config.dataDir, 'seed-users.json')}`);
  }

  const children = [];
  let stopping = false;
  const stopAll = code => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  };
  for (const proc of config.processes) {
    const child = spawn(proc.command, proc.args, { cwd: proc.cwd, env: proc.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = linePrefixer(`[${proc.name}]`, s => process.stdout.write(s));
    const err = linePrefixer(`[${proc.name}]`, s => process.stderr.write(s));
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('exit', code => {
      out.flush();
      err.flush();
      if (!stopping) console.error(`[dev] ${proc.name} beendet (Code ${code}), stoppe alles.`);
      stopAll(code || 0);
    });
    children.push(child);
  }
  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));
}

if (require.main === module) main();

module.exports = { devConfig, linePrefixer };
