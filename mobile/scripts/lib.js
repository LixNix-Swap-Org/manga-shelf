// Shared helpers of the mobile build scripts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MOBILE_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(MOBILE_DIR, 'build', 'out');

function run(cmd, args, { cwd = MOBILE_DIR, env = process.env, quiet = false } = {}) {
  if (!quiet) console.log(`[mobile] $ ${cmd} ${args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  return execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
}

/** The env values a signed build needs; all of them, or null when one is missing. */
function secretsFrom(env, names) {
  const values = {};
  for (const name of names) {
    const value = env[name];
    if (typeof value !== 'string' || !value.trim()) return null;
    values[name] = value.trim();
  }
  return values;
}

function androidSdkDir(env = process.env) {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Library', 'Android', 'sdk'), path.join(os.homedir(), 'Android', 'Sdk')];
  return candidates.find((dir) => dir && fs.existsSync(path.join(dir, 'platforms'))) || null;
}

function artifactName(version, suffix) {
  return `manga-shelf-${version}-${suffix}`;
}

function rootVersion() {
  return JSON.parse(fs.readFileSync(path.join(MOBILE_DIR, '..', 'package.json'), 'utf-8')).version;
}

function writeSecretFile(file, base64) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(base64, 'base64'), { mode: 0o600 });
  return file;
}

module.exports = { MOBILE_DIR, OUT_DIR, run, secretsFrom, androidSdkDir, artifactName, rootVersion, writeSecretFile };
