#!/usr/bin/env node
// CI smoke test of a native project: cap sync, cap doctor and a debug build (Android: assembleDebug; iOS: simulator
// build without signing), copied to build/out/ for the artifact upload. Uses www/ when it exists, else --from <app
// build dir>, else builds the frontend.
//   node scripts/smoke.js android|ios [--from <app build dir>]
const fs = require('fs');
const path = require('path');
const { MOBILE_DIR, OUT_DIR, run, androidSdkDir, artifactName, rootVersion } = require('./lib');
const { prepareWeb, WWW_DIR } = require('./prepare-web');
const { toolEnv } = require('./build-ios');

function iosSimulatorArgs(derivedData) {
  return ['-workspace', 'App.xcworkspace', '-scheme', 'App', '-configuration', 'Debug', '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derivedData, 'CODE_SIGNING_ALLOWED=NO', 'build'];
}

// Name of the smoke output in build/out/: a debug-signed APK, or the simulator app as a zip
function smokeArtifact(platform, version = rootVersion()) {
  return path.join(OUT_DIR, artifactName(version, platform === 'android' ? 'android-debug.apk' : 'ios-simulator.zip'));
}

// cap sync runs before cap doctor: the gitignored assets folders exist only after a sync
async function smoke(platform, { from = null, env = process.env } = {}) {
  if (platform !== 'android' && platform !== 'ios') throw new Error('Plattform android oder ios angeben');
  if (from || !fs.existsSync(path.join(WWW_DIR, 'index.html'))) await prepareWeb(from ? { from } : { build: true });
  if (platform === 'android') {
    const sdk = androidSdkDir(env);
    if (!sdk) throw new Error('Kein Android SDK gefunden (ANDROID_HOME setzen)');
    const aenv = { ...env, ANDROID_HOME: sdk };
    run('npx', ['cap', 'sync', 'android'], { env: aenv });
    run('npx', ['cap', 'doctor', 'android'], { env: aenv });
    run('./gradlew', ['assembleDebug', '--no-daemon'], { cwd: path.join(MOBILE_DIR, 'android'), env: aenv });
    const apk = path.join(MOBILE_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    if (!fs.existsSync(apk)) throw new Error(`${apk} fehlt nach assembleDebug`);
    const out = smokeArtifact('android');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.copyFileSync(apk, out);
    return out;
  }
  if (process.platform !== 'darwin') throw new Error('Der iOS-Smoke-Test braucht macOS mit Xcode');
  const xenv = toolEnv(env);
  run('npx', ['cap', 'sync', 'ios'], { env: xenv });
  run('npx', ['cap', 'doctor', 'ios'], { env: xenv });
  const derivedData = path.join(MOBILE_DIR, 'build', 'ios', 'DerivedData');
  run('xcodebuild', iosSimulatorArgs(derivedData), { cwd: path.join(MOBILE_DIR, 'ios', 'App'), env: xenv });
  const app = path.join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app');
  if (!fs.existsSync(app)) throw new Error(`${app} fehlt nach dem Simulator-Build`);
  const out = smokeArtifact('ios');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(out, { force: true });
  run('ditto', ['-c', '-k', '--keepParent', app, out]);
  return out;
}

module.exports = { smoke, iosSimulatorArgs, smokeArtifact };

if (require.main === module) {
  const [platform, ...rest] = process.argv.slice(2);
  const fromAt = rest.indexOf('--from');
  smoke(platform, { from: fromAt >= 0 ? path.resolve(rest[fromAt + 1] || '') : null })
    .then((out) => console.log(`[mobile] Smoke-Test ${platform} bestanden: ${out}`))
    .catch((err) => {
      console.error(`[mobile] ${err.message}`);
      process.exit(1);
    });
}
