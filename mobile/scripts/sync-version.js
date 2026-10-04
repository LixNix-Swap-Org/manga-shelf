#!/usr/bin/env node
// Copies the release version of the root package.json into the native projects before a build:
// android/app/build.gradle (versionName/versionCode), ios/App/App.xcodeproj (MARKETING_VERSION/CURRENT_PROJECT_VERSION)
// and mobile/package.json. `--check` only reports a difference (exit code 1).
const fs = require('fs');
const path = require('path');

const MOBILE_DIR = path.resolve(__dirname, '..');
const ROOT_PACKAGE = path.join(MOBILE_DIR, '..', 'package.json');
const FILES = {
  gradle: path.join(MOBILE_DIR, 'android', 'app', 'build.gradle'),
  pbxproj: path.join(MOBILE_DIR, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
  mobilePackage: path.join(MOBILE_DIR, 'package.json')
};

function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version || '').trim());
  if (!m) throw new Error(`Ungültige Version: ${version}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 999 || patch > 999) throw new Error(`Version ${version}: Minor und Patch höchstens 999`);
  return { major, minor, patch, name: `${major}.${minor}.${patch}` };
}

/** 2.19.1 -> 2019001: grows with every release, below Android's limit of 2100000000. */
function versionCode(version) {
  const { major, minor, patch } = parseVersion(version);
  const code = major * 1000000 + minor * 1000 + patch;
  if (code < 1 || code > 2100000000) throw new Error(`Version ${version} ergibt keinen gültigen versionCode`);
  return code;
}

function replaceAll(text, pattern, replacement, what) {
  if (!pattern.test(text)) throw new Error(`${what} nicht gefunden`);
  return text.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), replacement);
}

function patchGradle(text, version) {
  const { name } = parseVersion(version);
  let out = replaceAll(text, /versionCode\s+\d+/, `versionCode ${versionCode(version)}`, 'versionCode in build.gradle');
  out = replaceAll(out, /versionName\s+"[^"]*"/, `versionName "${name}"`, 'versionName in build.gradle');
  return out;
}

function patchPbxproj(text, version) {
  const { name } = parseVersion(version);
  let out = replaceAll(text, /MARKETING_VERSION = [^;]+;/, `MARKETING_VERSION = ${name};`, 'MARKETING_VERSION im Xcode-Projekt');
  out = replaceAll(out, /CURRENT_PROJECT_VERSION = [^;]+;/, `CURRENT_PROJECT_VERSION = ${versionCode(version)};`, 'CURRENT_PROJECT_VERSION im Xcode-Projekt');
  return out;
}

function patchPackageJson(text, version) {
  const pkg = JSON.parse(text);
  pkg.version = parseVersion(version).name;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const PATCHERS = { gradle: patchGradle, pbxproj: patchPbxproj, mobilePackage: patchPackageJson };

function syncVersion({ version, check = false, files = FILES } = {}) {
  const target = version || JSON.parse(fs.readFileSync(ROOT_PACKAGE, 'utf-8')).version;
  const changed = [];
  for (const [key, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) throw new Error(`${file} fehlt (npx cap add android/ios ausgeführt?)`);
    const before = fs.readFileSync(file, 'utf-8');
    const after = PATCHERS[key](before, target);
    if (after === before) continue;
    changed.push(file);
    if (!check) fs.writeFileSync(file, after);
  }
  return { version: parseVersion(target).name, code: versionCode(target), changed };
}

module.exports = { parseVersion, versionCode, patchGradle, patchPbxproj, patchPackageJson, syncVersion };

if (require.main === module) {
  const check = process.argv.includes('--check');
  try {
    const { version, code, changed } = syncVersion({ check });
    const where = changed.map((f) => path.relative(MOBILE_DIR, f)).join(', ');
    if (check && changed.length) {
      console.error(`[mobile] Version ${version} (${code}) fehlt in: ${where} – npm run version:sync`);
      process.exit(1);
    }
    console.log(`[mobile] Version ${version} (Build ${code})${changed.length ? ` gesetzt in: ${where}` : ' ist überall aktuell'}`);
  } catch (err) {
    console.error(`[mobile] ${err.message}`);
    process.exit(1);
  }
}
