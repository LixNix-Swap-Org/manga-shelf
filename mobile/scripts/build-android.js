#!/usr/bin/env node
// Release build for Android (APK + AAB) into build/out/. Signed with ANDROID_KEYSTORE_BASE64/_PASSWORD and
// ANDROID_KEY_ALIAS/_PASSWORD; without them the APK gets the debug key (sideload only) and the AAB stays unsigned.
//   node scripts/build-android.js [--skip-web | --from <app build dir>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MOBILE_DIR, OUT_DIR, run, secretsFrom, androidSdkDir, artifactName, rootVersion, writeSecretFile } = require('./lib');
const { syncVersion } = require('./sync-version');
const { prepareWeb } = require('./prepare-web');

const ANDROID_SECRETS = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
const ANDROID_DIR = path.join(MOBILE_DIR, 'android');
const OUTPUTS = path.join(ANDROID_DIR, 'app', 'build', 'outputs');

/**
 * Environment for the signingConfigs block of android/app/build.gradle. Plain names: gradlew runs under /bin/sh, and
 * dash (Ubuntu) drops variables whose names are no shell identifiers (ORG_GRADLE_PROJECT_android.injected.…).
 */
function signingEnv(secrets, keystoreFile) {
  return {
    MANGASHELF_KEYSTORE_FILE: keystoreFile,
    MANGASHELF_STORE_PASSWORD: secrets.ANDROID_KEYSTORE_PASSWORD,
    MANGASHELF_KEY_ALIAS: secrets.ANDROID_KEY_ALIAS,
    MANGASHELF_KEY_PASSWORD: secrets.ANDROID_KEY_PASSWORD
  };
}

const hex = (text) => String(text).replace(/[^0-9a-f]/gi, '').toLowerCase();

/** SHA-256 of the certificate from `keytool -list -v` (SHA256: AB:CD:…). */
function keytoolSha256(text) {
  const match = /SHA-?256:\s*([0-9A-F:]{95})/i.exec(String(text));
  return match ? hex(match[1]) : null;
}

/** Certificates of `apksigner verify --print-certs`: [{ dn, sha256 }]. */
function apksignerCerts(text) {
  const certs = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^Signer #(\d+) certificate (DN|SHA-256 digest): (.+)$/.exec(line.trim());
    if (!m) continue;
    const cert = certs.get(m[1]) || {};
    if (m[2] === 'DN') cert.dn = m[3].trim();
    else cert.sha256 = hex(m[3]);
    certs.set(m[1], cert);
  }
  return [...certs.values()];
}

/** Throws unless the APK is signed by exactly the release certificate (never the debug key). */
function checkReleaseSignature(apksignerOutput, expectedSha256) {
  const certs = apksignerCerts(apksignerOutput);
  if (!certs.length) throw new Error('APK ohne Signatur');
  if (certs.some((c) => /CN=Android Debug/i.test(c.dn || ''))) throw new Error('APK mit dem Debug-Schlüssel signiert');
  if (expectedSha256 && !certs.some((c) => c.sha256 === hex(expectedSha256))) {
    throw new Error(`APK nicht mit dem Release-Schlüssel signiert (gefunden: ${certs.map((c) => c.sha256).join(', ')})`);
  }
  return certs;
}

function releaseCertSha256(keystore, secrets) {
  const out = execFileSync('keytool', ['-list', '-v', '-keystore', keystore, '-alias', secrets.ANDROID_KEY_ALIAS, '-storepass:env', 'MANGASHELF_STORE_PASSWORD'], {
    encoding: 'utf8', env: { ...process.env, MANGASHELF_STORE_PASSWORD: secrets.ANDROID_KEYSTORE_PASSWORD }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const sha = keytoolSha256(out);
  if (!sha) throw new Error('Fingerabdruck des Release-Schlüssels nicht gefunden');
  return sha;
}

function verifyApk(sdk, apk, expectedSha256) {
  const out = execFileSync(path.join(latestBuildTools(sdk), 'apksigner'), ['verify', '--print-certs', apk], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return checkReleaseSignature(out, expectedSha256);
}

function latestBuildTools(sdk) {
  const dir = path.join(sdk, 'build-tools');
  const versions = fs.existsSync(dir) ? fs.readdirSync(dir).filter((v) => /^\d/.test(v)) : [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) throw new Error(`Keine Android build-tools in ${dir}`);
  return path.join(dir, versions[versions.length - 1]);
}

function debugKeystore() {
  const file = path.join(os.homedir(), '.android', 'debug.keystore');
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  run('keytool', ['-genkeypair', '-keystore', file, '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US']);
  return file;
}

function debugSign(sdk, unsignedApk, outFile) {
  const tools = latestBuildTools(sdk);
  const aligned = `${unsignedApk}.aligned`;
  run(path.join(tools, 'zipalign'), ['-f', '-p', '4', unsignedApk, aligned]);
  run(path.join(tools, 'apksigner'), ['sign', '--ks', debugKeystore(), '--ks-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey',
    '--key-pass', 'pass:android', '--out', outFile, aligned]);
  fs.rmSync(aligned, { force: true });
}

function parseArgs(argv) {
  const args = { skipWeb: false, from: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-web') args.skipWeb = true;
    else if (argv[i] === '--from') args.from = path.resolve(argv[++i] || '');
    else throw new Error(`Unbekannte Option: ${argv[i]}`);
  }
  return args;
}

async function buildAndroid({ skipWeb = false, from = null, env = process.env } = {}) {
  const version = rootVersion();
  syncVersion();
  if (!skipWeb) await prepareWeb(from ? { from } : { build: true });
  run('npx', ['cap', 'sync', 'android']);

  const sdk = androidSdkDir(env);
  if (!sdk) throw new Error('Kein Android SDK gefunden (ANDROID_HOME setzen)');
  const secrets = secretsFrom(env, ANDROID_SECRETS);
  const keystore = secrets ? writeSecretFile(path.join(MOBILE_DIR, 'build', 'signing', 'release.keystore'), secrets.ANDROID_KEYSTORE_BASE64) : null;
  if (!secrets) console.log('[mobile] Keine Android-Signierschlüssel: APK mit Debug-Schlüssel, AAB unsigniert');
  let expected = null;
  try {
    if (secrets) expected = releaseCertSha256(keystore, secrets);
    run('./gradlew', ['assembleRelease', 'bundleRelease', '--no-daemon'], {
      cwd: ANDROID_DIR,
      env: { ...env, ANDROID_HOME: sdk, ...(secrets ? signingEnv(secrets, keystore) : {}) }
    });
  } finally {
    if (keystore) fs.rmSync(keystore, { force: true });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const apkOut = path.join(OUT_DIR, artifactName(version, 'android.apk'));
  const aabOut = path.join(OUT_DIR, artifactName(version, secrets ? 'android.aab' : 'android-unsigned.aab'));
  if (secrets) {
    const signedApk = path.join(OUTPUTS, 'apk', 'release', 'app-release.apk');
    if (!fs.existsSync(signedApk)) throw new Error(`Signierte APK fehlt (${signedApk}); Gradle hat die Signierdaten nicht übernommen`);
    verifyApk(sdk, signedApk, expected);
    fs.copyFileSync(signedApk, apkOut);
  } else {
    debugSign(sdk, path.join(OUTPUTS, 'apk', 'release', 'app-release-unsigned.apk'), apkOut);
  }
  fs.copyFileSync(path.join(OUTPUTS, 'bundle', 'release', 'app-release.aab'), aabOut);
  return { signed: Boolean(secrets), files: [apkOut, aabOut] };
}

module.exports = { ANDROID_SECRETS, signingEnv, keytoolSha256, apksignerCerts, checkReleaseSignature, latestBuildTools, verifyApk, buildAndroid };

if (require.main === module) {
  buildAndroid(parseArgs(process.argv.slice(2)))
    .then(({ files }) => console.log(`[mobile] Android fertig:\n  ${files.join('\n  ')}`))
    .catch((err) => {
      console.error(`[mobile] ${err.message}`);
      process.exit(1);
    });
}
