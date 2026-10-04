// Mobile build scripts: prepare-web, version sync, signing, release checks and smoke arguments.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { injectBridgeTag, shouldCopy, parseArgs, prepareWeb, BRIDGE_TAG } = require('../scripts/prepare-web');
const { parseVersion, versionCode, patchGradle, patchPbxproj, patchPackageJson, syncVersion } = require('../scripts/sync-version');
const { signingPatch, exportOptionsPlist, toolEnv, IOS_SECRETS } = require('../scripts/build-ios');
const { signingEnv, ANDROID_SECRETS, keytoolSha256, apksignerCerts, checkReleaseSignature } = require('../scripts/build-android');
const { secretsFrom, artifactName } = require('../scripts/lib');
const { iosSimulatorArgs } = require('../scripts/smoke');

const MOBILE = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(MOBILE, rel), 'utf-8');

describe('prepare-web', () => {
  const html = '<head>\n    <meta http-equiv="Content-Security-Policy" content="x">\n    <script type="module" crossorigin src="./assets/index.js"></script>\n</head>';

  it('puts the bridge before the first script, once', () => {
    const out = injectBridgeTag(html);
    assert.ok(out.indexOf(BRIDGE_TAG) < out.indexOf('type="module"'));
    assert.equal(injectBridgeTag(out), out);
    assert.throws(() => injectBridgeTag('<head></head>'), /kein <script>/);
  });

  it('skips the precompressed copies and reads its options', () => {
    assert.equal(shouldCopy('index-abc.js'), true);
    assert.equal(shouldCopy('index-abc.js.br'), false);
    assert.equal(shouldCopy('index-abc.js.gz'), false);
    assert.deepEqual(parseArgs(['--build']).build, true);
    assert.equal(parseArgs(['--from', '/tmp/x']).from, path.resolve('/tmp/x'));
    assert.throws(() => parseArgs(['--nope']), /Unbekannte Option/);
  });

  it('refuses a web build (no app CSP) and assembles www from an app build', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-mobile-'));
    try {
      const from = path.join(dir, 'dist-app');
      fs.mkdirSync(path.join(from, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(from, 'index.html'), html.replace('Content-Security-Policy', 'nothing'));
      await assert.rejects(prepareWeb({ from, wwwDir: path.join(dir, 'www') }), /kein App-Build/);
      fs.writeFileSync(path.join(from, 'index.html'), html);
      fs.writeFileSync(path.join(from, 'assets', 'index.js'), 'console.log(1)');
      fs.writeFileSync(path.join(from, 'assets', 'index.js.br'), 'x');
      const www = await prepareWeb({ from, wwwDir: path.join(dir, 'www') });
      assert.ok(fs.readFileSync(path.join(www, 'index.html'), 'utf-8').includes(BRIDGE_TAG));
      assert.ok(fs.existsSync(path.join(www, 'assets', 'index.js')));
      assert.ok(!fs.existsSync(path.join(www, 'assets', 'index.js.br')));
      const bridge = fs.readFileSync(path.join(www, 'native-bridge.js'), 'utf-8');
      assert.match(bridge, /mangashelfNative/);
      assert.doesNotMatch(bridge, /^\s*(import|export)\s/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('version sync', () => {
  it('derives versionCode / CURRENT_PROJECT_VERSION from the release version', () => {
    assert.equal(versionCode('2.19.1'), 2019001);
    assert.equal(versionCode('2.20.0'), 2020000);
    assert.ok(versionCode('3.0.0') > versionCode('2.999.999'));
    assert.equal(parseVersion('2.19.1-beta.1').name, '2.19.1');
    assert.throws(() => parseVersion('v2'), /Ungültige Version/);
    assert.throws(() => versionCode('1.1000.0'), /höchstens 999/);
  });

  it('patches build.gradle, project.pbxproj and package.json', () => {
    const gradle = 'defaultConfig {\n        versionCode 1\n        versionName "1.0"\n}';
    assert.equal(patchGradle(gradle, '2.19.1'), 'defaultConfig {\n        versionCode 2019001\n        versionName "2.19.1"\n}');
    assert.throws(() => patchGradle('nothing', '2.19.1'), /versionCode/);
    const pbx = 'A\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0;\nB\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 1.0;';
    const out = patchPbxproj(pbx, '2.19.1');
    assert.equal(out.match(/MARKETING_VERSION = 2\.19\.1;/g).length, 2);
    assert.equal(out.match(/CURRENT_PROJECT_VERSION = 2019001;/g).length, 2);
    assert.equal(JSON.parse(patchPackageJson('{"name":"x","version":"0.0.1"}', '2.19.1')).version, '2.19.1');
  });

  it('the checked-in native projects carry the root version', () => {
    assert.deepEqual(syncVersion({ check: true }).changed, []);
  });
});

describe('signing', () => {
  it('needs every secret, else the unsigned fallback', () => {
    const full = { ANDROID_KEYSTORE_BASE64: 'a', ANDROID_KEYSTORE_PASSWORD: 'b', ANDROID_KEY_ALIAS: 'c', ANDROID_KEY_PASSWORD: 'd' };
    assert.deepEqual(secretsFrom(full, ANDROID_SECRETS), full);
    assert.equal(secretsFrom({ ...full, ANDROID_KEY_PASSWORD: ' ' }, ANDROID_SECRETS), null);
    assert.equal(secretsFrom({}, IOS_SECRETS), null);
    const env = signingEnv(full, '/tmp/release.keystore');
    assert.deepEqual(env, { MANGASHELF_KEYSTORE_FILE: '/tmp/release.keystore', MANGASHELF_STORE_PASSWORD: 'b', MANGASHELF_KEY_ALIAS: 'c', MANGASHELF_KEY_PASSWORD: 'd' });
  });

  it('passes signing through plain environment names that dash keeps, read by a signingConfigs block', () => {
    const env = signingEnv({ ANDROID_KEYSTORE_PASSWORD: 'b', ANDROID_KEY_ALIAS: 'c', ANDROID_KEY_PASSWORD: 'd' }, '/k');
    for (const name of Object.keys(env)) assert.match(name, /^[A-Z_][A-Z0-9_]*$/, `${name} is no shell identifier`);
    const gradle = read('android/app/build.gradle');
    for (const name of Object.keys(env)) assert.ok(gradle.includes(`System.getenv('${name}')`), `${name} not read in build.gradle`);
    assert.match(gradle, /signingConfigs \{[\s\S]*release \{[\s\S]*storeFile file\(releaseKeystore\)/);
    assert.match(gradle, /buildTypes \{\s*release \{\s*if \(releaseKeystore\) \{\s*signingConfig signingConfigs\.release/);
    assert.ok(gradle.indexOf('signingConfigs {') < gradle.indexOf('buildTypes {'));
  });

  it('accepts the APK only with the release certificate', () => {
    const sha = 'AB:'.repeat(31) + 'CD';
    assert.equal(keytoolSha256(`Alias name: manga\nCertificate fingerprints:\n\t SHA1: 00:11\n\t SHA256: ${sha}\n`), 'ab'.repeat(31) + 'cd');
    assert.equal(keytoolSha256('nichts'), null);
    const out = [
      'Signer #1 certificate DN: CN=Manga Shelf, O=Manga Shelf',
      `Signer #1 certificate SHA-256 digest: ${'ab'.repeat(31)}cd`,
      'Signer #1 certificate SHA-1 digest: 0011'
    ].join('\n');
    assert.deepEqual(apksignerCerts(out), [{ dn: 'CN=Manga Shelf, O=Manga Shelf', sha256: 'ab'.repeat(31) + 'cd' }]);
    assert.equal(checkReleaseSignature(out, 'ab'.repeat(31) + 'cd').length, 1);
    assert.throws(() => checkReleaseSignature(out, 'ff'.repeat(32)), /nicht mit dem Release-Schlüssel/);
    assert.throws(() => checkReleaseSignature('DOES NOT VERIFY', null), /ohne Signatur/);
    const debug = 'Signer #1 certificate DN: C=US, O=Android, CN=Android Debug\nSigner #1 certificate SHA-256 digest: 00';
    assert.throws(() => checkReleaseSignature(debug, null), /Debug-Schlüssel/);
  });

  it('signs only the App target and exports with the given profile', () => {
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    const patched = signingPatch(pbx, { team: 'ABCDE12345', profileUuid: 'uuid-1' });
    const count = (text, needle) => text.split(needle).length - 1;
    const appConfigs = count(pbx, 'PRODUCT_BUNDLE_IDENTIFIER = de.mangashelf.app;');
    assert.ok(appConfigs >= 2);
    assert.equal(count(patched, 'PROVISIONING_PROFILE_SPECIFIER = "uuid-1";'), appConfigs);
    assert.equal(count(patched, 'DEVELOPMENT_TEAM = ABCDE12345;'), appConfigs);
    assert.throws(() => signingPatch('x', { team: 't', profileUuid: 'u' }), /nicht im Xcode-Projekt/);
    const plist = exportOptionsPlist({ method: 'app-store-connect', team: 'T<1>', profileUuid: 'uuid-1' });
    assert.match(plist, /<key>de\.mangashelf\.app<\/key><string>uuid-1<\/string>/);
    assert.match(plist, /T&lt;1&gt;/);
  });

  it('names artifacts and runs CocoaPods under UTF-8', () => {
    assert.equal(artifactName('2.19.1', 'android.apk'), 'manga-shelf-2.19.1-android.apk');
    assert.equal(toolEnv({ LANG: 'C' }).LANG, 'en_US.UTF-8');
    assert.equal(toolEnv({ LANG: 'de_DE.UTF-8' }).LANG, 'de_DE.UTF-8');
    assert.ok(iosSimulatorArgs('/tmp/dd').includes('CODE_SIGNING_ALLOWED=NO'));
  });
});

describe('native project settings', () => {
  it('app id, name, deep link scheme, camera and native HTTP', () => {
    const config = read('capacitor.config.ts');
    assert.match(config, /appId: 'de\.mangashelf\.app'/);
    assert.match(config, /appName: 'Manga Shelf'/);
    assert.match(config, /CapacitorHttp: \{ enabled: true \}/);
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    assert.match(manifest, /android:scheme="manga-shelf" android:host="connect"/);
    assert.match(manifest, /android\.permission\.CAMERA/);
    assert.match(manifest, /com\.google\.mlkit\.vision\.DEPENDENCIES" android:value="barcode_ui"/);
    assert.match(read('android/app/src/main/res/xml/data_extraction_rules.xml'), /WSSecureStorageSharedPreferences/);
    const plist = read('ios/App/App/Info.plist');
    assert.match(plist, /<string>manga-shelf<\/string>/);
    assert.match(plist, /NSCameraUsageDescription/);
    assert.match(read('ios/App/Podfile'), /platform :ios, '15\.5'/);
  });

  it('dark from the first frame: WebView, launch screen, Android themes; edge-to-edge margins on Android 15', () => {
    const config = read('capacitor.config.ts');
    assert.match(config, /backgroundColor: '#0b0f19'/);
    assert.match(config, /adjustMarginsForEdgeToEdge: 'auto'/);
    const launch = read('ios/App/App/Base.lproj/LaunchScreen.storyboard');
    assert.doesNotMatch(launch, /systemBackgroundColor|image="Splash"/);
    assert.match(launch, /<color key="backgroundColor" red="0\.0431\d*" green="0\.0588\d*" blue="0\.098\d*" alpha="1" colorSpace="custom" customColorSpace="sRGB"\/>/);
    const plist = read('ios/App/App/Info.plist');
    assert.match(plist, /<key>UIStatusBarStyle<\/key>\s*<string>UIStatusBarStyleLightContent<\/string>/);
    const orientations = (key) => /<array>([\s\S]*?)<\/array>/.exec(plist.split(`<key>${key}</key>`)[1])[1].match(/UIInterfaceOrientation\w+/g);
    assert.deepEqual(orientations('UISupportedInterfaceOrientations'), ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight']);
    assert.equal(orientations('UISupportedInterfaceOrientations~ipad').length, 4);
    assert.match(read('android/app/src/main/res/values/colors.xml'), /<color name="app_background">#0B0F19<\/color>/);
    const styles = read('android/app/src/main/res/values/styles.xml');
    assert.match(styles, /android:windowBackground">@color\/app_background/);
    assert.match(styles, /windowSplashScreenBackground">@color\/app_background/);
    assert.doesNotMatch(styles, /@drawable\/splash/);
  });
});
