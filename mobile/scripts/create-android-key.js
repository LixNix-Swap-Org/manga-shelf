#!/usr/bin/env node
// Creates the Android release keystore once and prints the four repository secrets build-android.js needs. Without
// them every CI build signs with a fresh debug key, and Android refuses to install the next APK over the previous one.
//   node scripts/create-android-key.js [--out <file>] [--alias <name>]
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./lib');
const { keytoolSha256, ANDROID_SECRETS } = require('./build-android');
const { execFileSync } = require('child_process');

const DEFAULT_ALIAS = 'manga-shelf';
const DNAME = 'CN=Manga Shelf, O=Manga Shelf';

function parseArgs(argv) {
  const args = { out: path.join(os.homedir(), 'manga-shelf-release.keystore'), alias: DEFAULT_ALIAS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i] || '');
    else if (argv[i] === '--alias') args.alias = argv[++i] || '';
    else throw new Error(`Unbekannte Option: ${argv[i]}`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(args.alias)) throw new Error('Alias nur aus Buchstaben, Ziffern, . _ -');
  return args;
}

/** keytool arguments for a PKCS12 release key (one password for store and key, as PKCS12 requires). */
function keytoolArgs(file, alias) {
  return ['-genkeypair', '-keystore', file, '-storetype', 'PKCS12', '-alias', alias, '-keyalg', 'RSA', '-keysize', '4096',
    '-validity', '10000', '-dname', DNAME, '-storepass:env', 'MANGASHELF_STORE_PASSWORD', '-keypass:env', 'MANGASHELF_STORE_PASSWORD'];
}

/** The four secrets as NAME=value lines, in the order of ANDROID_SECRETS. */
function secretLines(keystoreBytes, alias, password) {
  const values = {
    ANDROID_KEYSTORE_BASE64: Buffer.from(keystoreBytes).toString('base64'),
    ANDROID_KEYSTORE_PASSWORD: password,
    ANDROID_KEY_ALIAS: alias,
    ANDROID_KEY_PASSWORD: password
  };
  return ANDROID_SECRETS.map((name) => `${name}=${values[name]}`);
}

function createAndroidKey({ out, alias }) {
  const secretsFile = `${out}.secrets.txt`;
  for (const file of [out, secretsFile]) {
    if (fs.existsSync(file)) throw new Error(`${file} existiert schon; einen vorhandenen Schlüssel nie ersetzen (sonst lassen sich Updates nicht mehr drüber installieren)`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const password = crypto.randomBytes(24).toString('base64url');
  const env = { ...process.env, MANGASHELF_STORE_PASSWORD: password };
  run('keytool', keytoolArgs(out, alias), { env, quiet: true });
  fs.chmodSync(out, 0o600);
  const listing = execFileSync('keytool', ['-list', '-v', '-keystore', out, '-alias', alias, '-storepass:env', 'MANGASHELF_STORE_PASSWORD'],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const sha256 = keytoolSha256(listing);
  fs.writeFileSync(secretsFile, secretLines(fs.readFileSync(out), alias, password).join('\n') + '\n', { mode: 0o600 });
  return { out, secretsFile, sha256 };
}

if (require.main === module) {
  try {
    const { out, secretsFile, sha256 } = createAndroidKey(parseArgs(process.argv.slice(2)));
    console.log(`[mobile] Release-Schlüssel: ${out}`);
    console.log(`[mobile] SHA-256 des Zertifikats: ${sha256}`);
    console.log(`[mobile] Die vier Repository-Secrets stehen in ${secretsFile} (NAME=Wert, je Zeile ein Secret).`);
    console.log('[mobile] Unter Settings → Secrets and variables → Actions eintragen, dann die Secrets-Datei löschen.');
    console.log('[mobile] Den Schlüssel und das Passwort sicher aufbewahren: ohne sie lässt sich kein Update mehr drüber installieren.');
  } catch (err) {
    console.error(`[mobile] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { DEFAULT_ALIAS, parseArgs, keytoolArgs, secretLines, createAndroidKey };
