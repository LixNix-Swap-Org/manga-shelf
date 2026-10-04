#!/usr/bin/env node
// Release build for iPhone/iPad into build/out/ (macOS, Xcode, CocoaPods). With IOS_CERT_* , IOS_PROVISIONING_PROFILE_BASE64
// and APPLE_TEAM_ID it makes a signed IPA (IOS_EXPORT_METHOD); `--testflight` uploads it with the APP_STORE_CONNECT_API_KEY_*
// variables. Without them it makes an unsigned IPA (CODE_SIGNING_ALLOWED=NO) for AltStore, Sideloadly or Xcode.
//   node scripts/build-ios.js [--skip-web | --from <app build dir>] [--testflight]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { MOBILE_DIR, OUT_DIR, run, secretsFrom, artifactName, rootVersion, writeSecretFile } = require('./lib');
const { syncVersion } = require('./sync-version');
const { prepareWeb } = require('./prepare-web');

const IOS_SECRETS = ['IOS_CERT_P12_BASE64', 'IOS_CERT_PASSWORD', 'IOS_PROVISIONING_PROFILE_BASE64', 'APPLE_TEAM_ID'];
const TESTFLIGHT_SECRETS = ['APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_API_KEY_ISSUER_ID', 'APP_STORE_CONNECT_API_KEY_BASE64'];
const BUNDLE_ID = 'de.mangashelf.app';
const IOS_DIR = path.join(MOBILE_DIR, 'ios', 'App');
const PBXPROJ = path.join(IOS_DIR, 'App.xcodeproj', 'project.pbxproj');
const WORK_DIR = path.join(MOBILE_DIR, 'build', 'ios');

// CocoaPods fails under a non-UTF-8 locale (Encoding::CompatibilityError)
const toolEnv = (env) => ({ ...env, LANG: env.LANG && /UTF-8/i.test(env.LANG) ? env.LANG : 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });

function archiveArgs(archivePath) {
  return ['-workspace', 'App.xcworkspace', '-scheme', 'App', '-configuration', 'Release', '-destination', 'generic/platform=iOS',
    '-archivePath', archivePath, 'archive'];
}

/** Manual signing for the App target only (a global PROVISIONING_PROFILE_SPECIFIER would break the Pods targets). */
function signingPatch(pbxproj, { team, profileUuid, identity = 'Apple Distribution' }) {
  const anchor = `PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`;
  if (!pbxproj.includes(anchor)) throw new Error(`${anchor} nicht im Xcode-Projekt gefunden`);
  const settings = [
    'CODE_SIGN_STYLE = Manual;',
    `DEVELOPMENT_TEAM = ${team};`,
    `PROVISIONING_PROFILE_SPECIFIER = "${profileUuid}";`,
    `"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "${identity}";`
  ];
  return pbxproj.split('\n').map((line) => {
    if (!line.includes(anchor)) return line;
    const indent = /^\s*/.exec(line)[0];
    return [line, ...settings.map((s) => `${indent}${s}`)].join('\n');
  }).join('\n');
}

const xmlEscape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function exportOptionsPlist({ method, team, profileUuid }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>${xmlEscape(method)}</string>
  <key>teamID</key><string>${xmlEscape(team)}</string>
  <key>signingStyle</key><string>manual</string>
  <key>provisioningProfiles</key>
  <dict><key>${BUNDLE_ID}</key><string>${xmlEscape(profileUuid)}</string></dict>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
`;
}

function zipPayload(appDir, ipaFile) {
  const stage = path.join(WORK_DIR, 'ipa');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'Payload'), { recursive: true });
  run('ditto', [appDir, path.join(stage, 'Payload', 'App.app')]);
  fs.rmSync(ipaFile, { force: true });
  run('zip', ['-qry', ipaFile, 'Payload'], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
}

function plistValue(file, key) {
  return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf-8' }).trim();
}

/** Temporary keychain with the certificate, installed profile; returns what cleanup() removes. */
function installSigning(secrets) {
  const keychain = path.join(WORK_DIR, 'signing.keychain-db');
  const password = crypto.randomBytes(24).toString('hex');
  const p12 = writeSecretFile(path.join(WORK_DIR, 'cert.p12'), secrets.IOS_CERT_P12_BASE64);
  const profile = writeSecretFile(path.join(WORK_DIR, 'profile.mobileprovision'), secrets.IOS_PROVISIONING_PROFILE_BASE64);
  const decoded = path.join(WORK_DIR, 'profile.plist');
  fs.writeFileSync(decoded, execFileSync('security', ['cms', '-D', '-i', profile]));
  const profileUuid = plistValue(decoded, 'UUID');
  const installed = path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles', `${profileUuid}.mobileprovision`);
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.copyFileSync(profile, installed);

  const existing = execFileSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf-8' })
    .split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  fs.rmSync(keychain, { force: true });
  run('security', ['create-keychain', '-p', password, keychain], { quiet: true });
  run('security', ['set-keychain-settings', '-lut', '21600', keychain], { quiet: true });
  run('security', ['unlock-keychain', '-p', password, keychain], { quiet: true });
  run('security', ['import', p12, '-P', secrets.IOS_CERT_PASSWORD, '-A', '-t', 'cert', '-f', 'pkcs12', '-k', keychain], { quiet: true });
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain], { quiet: true });
  run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...existing], { quiet: true });

  return {
    profileUuid,
    keychain,
    cleanup() {
      try { run('security', ['list-keychains', '-d', 'user', '-s', ...existing], { quiet: true }); } catch (_) { /* keep going */ }
      try { run('security', ['delete-keychain', keychain], { quiet: true }); } catch (_) { /* already gone */ }
      for (const file of [p12, profile, decoded, installed]) fs.rmSync(file, { force: true });
    }
  };
}

function uploadToTestFlight(ipa, keys) {
  const keyDir = path.join(os.homedir(), '.appstoreconnect', 'private_keys');
  const keyFile = writeSecretFile(path.join(keyDir, `AuthKey_${keys.APP_STORE_CONNECT_API_KEY_ID}.p8`), keys.APP_STORE_CONNECT_API_KEY_BASE64);
  try {
    run('xcrun', ['altool', '--upload-app', '-f', ipa, '-t', 'ios', '--apiKey', keys.APP_STORE_CONNECT_API_KEY_ID,
      '--apiIssuer', keys.APP_STORE_CONNECT_API_KEY_ISSUER_ID]);
  } finally {
    fs.rmSync(keyFile, { force: true });
  }
}

function parseArgs(argv) {
  const args = { skipWeb: false, from: null, testflight: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-web') args.skipWeb = true;
    else if (argv[i] === '--testflight') args.testflight = true;
    else if (argv[i] === '--from') args.from = path.resolve(argv[++i] || '');
    else throw new Error(`Unbekannte Option: ${argv[i]}`);
  }
  return args;
}

async function buildIos({ skipWeb = false, from = null, testflight = false, env = process.env } = {}) {
  if (process.platform !== 'darwin') throw new Error('Der iOS-Build braucht macOS mit Xcode');
  const version = rootVersion();
  const xenv = toolEnv(env);
  syncVersion();
  if (!skipWeb) await prepareWeb(from ? { from } : { build: true });
  run('npx', ['cap', 'sync', 'ios'], { env: xenv });

  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const archivePath = path.join(WORK_DIR, 'App.xcarchive');
  fs.rmSync(archivePath, { recursive: true, force: true });
  const secrets = secretsFrom(env, IOS_SECRETS);

  if (!secrets) {
    console.log('[mobile] Keine iOS-Signierschlüssel: unsignierte IPA (selbst signieren mit AltStore, Sideloadly oder Xcode)');
    run('xcodebuild', [...archiveArgs(archivePath), 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY='], { cwd: IOS_DIR, env: xenv });
    const ipa = path.join(OUT_DIR, artifactName(version, 'ios-unsigned.ipa'));
    zipPayload(path.join(archivePath, 'Products', 'Applications', 'App.app'), ipa);
    return { signed: false, files: [ipa] };
  }

  const original = fs.readFileSync(PBXPROJ, 'utf-8');
  const signing = installSigning(secrets);
  try {
    fs.writeFileSync(PBXPROJ, signingPatch(original, { team: secrets.APPLE_TEAM_ID, profileUuid: signing.profileUuid }));
    run('xcodebuild', [...archiveArgs(archivePath), `OTHER_CODE_SIGN_FLAGS=--keychain ${signing.keychain}`], { cwd: IOS_DIR, env: xenv });
    const optionsFile = path.join(WORK_DIR, 'ExportOptions.plist');
    fs.writeFileSync(optionsFile, exportOptionsPlist({
      method: env.IOS_EXPORT_METHOD || 'app-store-connect', team: secrets.APPLE_TEAM_ID, profileUuid: signing.profileUuid
    }));
    const exportDir = path.join(WORK_DIR, 'export');
    fs.rmSync(exportDir, { recursive: true, force: true });
    run('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportPath', exportDir, '-exportOptionsPlist', optionsFile], { cwd: IOS_DIR, env: xenv });
    const ipa = path.join(OUT_DIR, artifactName(version, 'ios.ipa'));
    fs.copyFileSync(path.join(exportDir, 'App.ipa'), ipa);
    if (testflight) {
      const keys = secretsFrom(env, TESTFLIGHT_SECRETS);
      if (keys) uploadToTestFlight(ipa, keys);
      else console.log('[mobile] TestFlight übersprungen: APP_STORE_CONNECT_API_KEY_* fehlen');
    }
    return { signed: true, files: [ipa] };
  } finally {
    fs.writeFileSync(PBXPROJ, original);
    signing.cleanup();
  }
}

module.exports = { IOS_SECRETS, TESTFLIGHT_SECRETS, signingPatch, exportOptionsPlist, archiveArgs, toolEnv, buildIos };

if (require.main === module) {
  buildIos(parseArgs(process.argv.slice(2)))
    .then(({ files }) => console.log(`[mobile] iOS fertig:\n  ${files.join('\n  ')}`))
    .catch((err) => {
      console.error(`[mobile] ${err.message}`);
      process.exit(1);
    });
}
