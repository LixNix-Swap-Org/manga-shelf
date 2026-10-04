// Mobile build scripts: prepare-web, version sync, signing, release checks and smoke arguments.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { injectBridgeTag, shouldCopy, parseArgs, prepareWeb, BRIDGE_TAG } = require('../scripts/prepare-web');
const { parseVersion, versionCode, patchGradle, patchPbxproj, patchPackageJson, syncVersion } = require('../scripts/sync-version');
const { signingPatch, withoutShareExtension, exportOptionsPlist, profileFits, toolEnv, IOS_SECRETS, IOS_SHARE_SECRET } = require('../scripts/build-ios');
const { SHARE_TARGET, SHARE_BUNDLE_ID, APP_GROUP } = require('../scripts/add-share-extension');
const { notes, detectSigning } = require('../../scripts/release/signing');
const { signingEnv, ANDROID_SECRETS, keytoolSha256, apksignerCerts, checkReleaseSignature } = require('../scripts/build-android');
const { secretsFrom, artifactName } = require('../scripts/lib');
const { iosSimulatorArgs } = require('../scripts/smoke');

const MOBILE = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(MOBILE, rel), 'utf-8');
// Java/Swift source without comments, for checks that a call is absent
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\/? .*$/gm, '');

// Capacitor reads the platform once at import, so each platform gets its own Node process
function bridgeOn(platform) {
  const setup = {
    android: 'globalThis.androidBridge = { postMessage() {} };',
    ios: 'globalThis.webkit = { messageHandlers: { bridge: { postMessage() {} } } };'
  }[platform] || '';
  const script = `${setup} const m = await import(${JSON.stringify(path.join(MOBILE, 'src/native-bridge.mjs'))});
    const b = m.createBridge(); console.log(JSON.stringify({ version: b.version, platform: b.platform, plugins: Object.keys(b.plugins),
      keychainAccess: b.constants.KeychainAccess }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' });
  return JSON.parse(out.trim().split('\n').pop());
}

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

  it('signs the share extension with its own profile, matched by bundle id, and exports both profiles', () => {
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    const count = (text, needle) => text.split(needle).length - 1;
    const profiles = { 'de.mangashelf.app': 'uuid-app', [SHARE_BUNDLE_ID]: 'uuid-share' };
    const patched = signingPatch(pbx, { team: 'ABCDE12345', profiles });
    const appConfigs = count(pbx, 'PRODUCT_BUNDLE_IDENTIFIER = de.mangashelf.app;');
    const shareConfigs = count(pbx, `PRODUCT_BUNDLE_IDENTIFIER = ${SHARE_BUNDLE_ID};`);
    assert.equal(shareConfigs, 2, 'Debug and Release');
    assert.equal(count(patched, 'PROVISIONING_PROFILE_SPECIFIER = "uuid-app";'), appConfigs);
    assert.equal(count(patched, 'PROVISIONING_PROFILE_SPECIFIER = "uuid-share";'), shareConfigs);
    assert.equal(count(patched, 'DEVELOPMENT_TEAM = ABCDE12345;'), appConfigs + shareConfigs);
    const appOnly = signingPatch(pbx, { team: 'T', profiles: { 'de.mangashelf.app': 'uuid-app' } });
    assert.equal(count(appOnly, 'PROVISIONING_PROFILE_SPECIFIER'), appConfigs, 'the extension keeps automatic signing');
    const plist = exportOptionsPlist({ method: 'app-store-connect', team: 'T', profiles });
    assert.match(plist, /<key>de\.mangashelf\.app<\/key><string>uuid-app<\/string><key>de\.mangashelf\.app\.ShareToMangaShelf<\/key><string>uuid-share<\/string>/);
    assert.ok(profileFits('ABCDE12345.de.mangashelf.app.ShareToMangaShelf', SHARE_BUNDLE_ID));
    assert.ok(profileFits('ABCDE12345.*', SHARE_BUNDLE_ID));
    assert.ok(!profileFits('ABCDE12345.de.mangashelf.app', SHARE_BUNDLE_ID), 'the app profile is no extension profile');
    assert.equal(IOS_SHARE_SECRET, 'IOS_SHARE_PROVISIONING_PROFILE_BASE64');
    assert.ok(!IOS_SECRETS.includes(IOS_SHARE_SECRET), 'optional: a signed build never fails for the missing profile');
  });

  it('a signed build without the extension profile leaves the extension and the App Group out', () => {
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    const out = withoutShareExtension(pbx);
    const appTarget = (text) => /\/\* App \*\/ = \{\s*isa = PBXNativeTarget;[\s\S]*?\n\t\t\};/.exec(text)[0];
    assert.match(appTarget(pbx), /\/\* Embed Foundation Extensions \*\/,/);
    assert.match(appTarget(pbx), /\/\* PBXTargetDependency \*\/,/);
    assert.doesNotMatch(appTarget(out), /Embed Foundation Extensions|PBXTargetDependency/);
    assert.doesNotMatch(out, /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/);
    assert.equal(pbx.split('\n').length - out.split('\n').length, 4, 'phase, dependency and two entitlement lines');
    assert.equal(withoutShareExtension(out), out);
    assert.match(signingPatch(out, { team: 'T', profileUuid: 'u' }), /PROVISIONING_PROFILE_SPECIFIER = "u";/);
  });

  it('the release text names the extension only when the step passes its secret', () => {
    const ios = { IOS_CERT_P12_BASE64: 'a', IOS_CERT_PASSWORD: 'b', IOS_PROVISIONING_PROFILE_BASE64: 'c', APPLE_TEAM_ID: 'd' };
    const line = (env) => notes(detectSigning(env), env).split('\n').find((l) => l.includes('iPhone'));
    assert.match(line(ios), /: signiert$/);
    assert.match(line({ ...ios, [IOS_SHARE_SECRET]: '' }), /signiert, ohne Teilen-Ziel \(iOS\)/);
    assert.match(line({ ...ios, [IOS_SHARE_SECRET]: 'p' }), /signiert, mit Teilen-Ziel \(iOS\)/);
    assert.match(line({ [IOS_SHARE_SECRET]: 'p' }), /: unsigniert$/);
  });

  it('names artifacts and runs CocoaPods under UTF-8', () => {
    assert.equal(artifactName('2.19.1', 'android.apk'), 'manga-shelf-2.19.1-android.apk');
    assert.equal(toolEnv({ LANG: 'C' }).LANG, 'en_US.UTF-8');
    assert.equal(toolEnv({ LANG: 'de_DE.UTF-8' }).LANG, 'de_DE.UTF-8');
    assert.ok(iosSimulatorArgs('/tmp/dd').includes('CODE_SIGNING_ALLOWED=NO'));
  });
});

describe('native bridge', () => {
  it('version 3: AppLauncher everywhere, WebLogin in both apps, ShareIntent on Android, SharedInbox on iOS', () => {
    const android = bridgeOn('android');
    assert.equal(android.version, 3);
    assert.equal(android.platform, 'android');
    for (const name of ['ShareIntent', 'AppLauncher', 'WebLogin']) assert.ok(android.plugins.includes(name), name);
    assert.ok(!android.plugins.includes('SharedInbox'));
    const ios = bridgeOn('ios');
    assert.equal(ios.platform, 'ios');
    for (const name of ['SharedInbox', 'AppLauncher', 'WebLogin']) assert.ok(ios.plugins.includes(name), name);
    assert.ok(!ios.plugins.includes('ShareIntent'));
    const other = bridgeOn('web');
    for (const name of ['ShareIntent', 'SharedInbox', 'WebLogin']) assert.ok(!other.plugins.includes(name), name);
    assert.ok(other.plugins.includes('AppLauncher'));
  });

  it('exports the Keychain access levels by name only (whenUnlockedThisDeviceOnly = 1 for the watch secret)', () => {
    assert.deepEqual(bridgeOn('ios').keychainAccess, {
      whenUnlocked: 0, whenUnlockedThisDeviceOnly: 1, afterFirstUnlock: 2, afterFirstUnlockThisDeviceOnly: 3, whenPasscodeSetThisDeviceOnly: 4
    });
  });
});

describe('mangashelf-native plugin package', () => {
  const PLUGIN = 'plugins/mangashelf-native';
  const swift = (name) => read(`${PLUGIN}/ios/Sources/MangashelfNative/${name}.swift`);
  const java = (name) => read(`${PLUGIN}/android/src/main/java/de/mangashelf/nativeplugin/${name}.java`);
  const quoted = (text) => [...text.matchAll(/"([a-z.-]+\.com)"/g)].map((m) => m[1]).sort();

  it('a local file: dependency that cap sync wires into both projects', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.dependencies['mangashelf-native'], 'file:plugins/mangashelf-native');
    const plugin = JSON.parse(read(`${PLUGIN}/package.json`));
    assert.deepEqual(plugin.capacitor, { ios: { src: 'ios' }, android: { src: 'android' } });
    assert.match(read(`${PLUGIN}/MangashelfNative.podspec`), /s\.name = 'MangashelfNative'/);
    assert.match(read('ios/App/Podfile'), /pod 'MangashelfNative', :path => '\.\.\/\.\.\/plugins\/mangashelf-native'/);
    assert.match(read('ios/App/Podfile.lock'), /MangashelfNative \(from `\.\.\/\.\.\/plugins\/mangashelf-native`\)/);
    assert.match(read('android/capacitor.settings.gradle'), /project\(':mangashelf-native'\)\.projectDir = new File\('\.\.\/plugins\/mangashelf-native\/android'\)/);
    assert.match(read('android/app/capacitor.build.gradle'), /implementation project\(':mangashelf-native'\)/);
  });

  it('every Swift file names at most one @objc class, the plugin (cap sync lists only the first match per file)', () => {
    const dir = path.join(MOBILE, PLUGIN, 'ios/Sources/MangashelfNative');
    const found = fs.readdirSync(dir).flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf-8').matchAll(/@objc\(([A-Za-z0-9_-]+)\)/g)].map((m) => m[1]));
    assert.deepEqual(found.sort(), ['SharedInboxPlugin', 'WebLoginPlugin']);
    assert.match(swift('WebLoginPlugin'), /jsName = "WebLogin"/);
    assert.match(swift('SharedInboxPlugin'), /jsName = "SharedInbox"/);
    assert.match(java('WebLoginPlugin'), /@CapacitorPlugin\(name = "WebLogin"\)/);
  });

  it('the same host allow-lists on both platforms', () => {
    const iosDomains = quoted(/cookieDomains: Set<String> = \[([^\]]*)\]/.exec(swift('WebLoginPlugin'))[1]);
    const iosHosts = quoted(/requestHosts: Set<String> = \[([^\]]*)\]/.exec(swift('WebLoginPlugin'))[1]);
    const androidDomains = quoted(/COOKIE_DOMAINS = [^;]*;/.exec(java('WebLoginPlugin'))[0]);
    const androidHosts = quoted(/REQUEST_HOSTS = [^;]*;/.exec(java('WebLoginPlugin'))[0]);
    assert.deepEqual(iosDomains, ['crunchyroll.com']);
    assert.deepEqual(androidDomains, iosDomains);
    assert.deepEqual(iosHosts, ['beta-api.crunchyroll.com', 'www.crunchyroll.com']);
    assert.deepEqual(androidHosts, iosHosts);
  });

  it('iOS: sign-in in an in-memory data store, requests without a cookie jar and without redirects', () => {
    const controller = swift('WebLoginController');
    assert.match(controller, /WKWebsiteDataStore\.nonPersistent\(\)/);
    assert.doesNotMatch(code(controller), /WKWebsiteDataStore\.default\(\)|HTTPCookieStorage\.shared/);
    const request = swift('WebLoginRequest');
    assert.match(request, /URLSessionConfiguration\.ephemeral/);
    assert.match(request, /httpCookieStorage = nil/);
    assert.match(request, /httpShouldSetCookies = false/);
    assert.match(request, /httpShouldHandleCookies = false/);
    assert.match(request, /willPerformHTTPRedirection[\s\S]*?completionHandler\(nil\)/);
    assert.doesNotMatch(code(request), /URLSession\.shared/);
  });

  it('Android: login in its own WebView profile where supported, deleted afterwards and again at the next open', () => {
    const plugin = code(java('WebLoginPlugin'));
    assert.match(plugin, /PROFILE = "crunchyroll-login"/);
    assert.match(plugin, /isolated = WebViewFeature\.isFeatureSupported\(WebViewFeature\.MULTI_PROFILE\);/);
    // setProfile must come before any other call on the new WebView
    const created = plugin.indexOf('webView = new WebView(');
    const firstUse = plugin.indexOf('webView.', created);
    const setProfile = plugin.indexOf('WebViewCompat.setProfile(webView, PROFILE)', created);
    assert.ok(created > 0 && setProfile > created && setProfile < firstUse, 'setProfile right after new WebView');
    assert.match(plugin, /getOrCreateProfile\(PROFILE\)/);
    assert.match(plugin, /store\.deleteProfile\(PROFILE\)/);
    assert.match(plugin, /if \(isolated\) main\.post\(WebLoginPlugin::deleteProfile\)/);
    const open = plugin.slice(plugin.indexOf('public void open('), plugin.indexOf('private void show('));
    assert.ok(open.indexOf('removeLeftovers(cookieDomain)') > 0 && open.indexOf('removeLeftovers(') < open.indexOf('show('), 'leftovers of a killed process go first');
    assert.match(plugin, /jar\.getCookie\("https:\/\/www\." \+ domain\)/, 'the cookie is read from the dialog profile');
  });

  it('Android: wipes only the login profile; the shared-profile fallback expires what the dialog visited, never the app origin', () => {
    const plugin = code(java('WebLoginPlugin'));
    const cleanup = plugin.slice(plugin.indexOf('private void cleanup()'), plugin.indexOf('private void removeLeftovers('));
    const wipe = /if \(isolated\) \{\s*jar\.removeAllCookies\(null\);\s*jar\.flush\(\);\s*storage\.deleteAllData\(\);\s*\} else \{/.exec(cleanup);
    assert.ok(wipe, 'removeAllCookies/deleteAllData only in the isolated branch');
    assert.doesNotMatch(plugin.replace(wipe[0], ''), /removeAllCookies|deleteAllData|removeSessionCookies/, 'would wipe the app WebView');
    assert.doesNotMatch(plugin, /CookieManager\.getInstance\(\)\.(removeAll|setCookie)|WebStorage\.getInstance\(\)\.deleteAll/);
    assert.match(plugin, /onPageStarted\(WebView view, String started, Bitmap favicon\) \{\s*if \(!isolated\) remember\(started\);/);
    assert.match(plugin, /name \+ "=; Max-Age=0; Path=" \+ path \+ "; Secure"\)/);
    assert.match(plugin, /name \+ "=; Max-Age=0; Path=" \+ path \+ "; Secure; Domain=\." \+ parent\)/);
    assert.match(plugin, /for \(String origin : origins\) storage\.deleteOrigin\(origin\)/);
    assert.match(plugin, /new File\(getContext\(\)\.getNoBackupFilesDir\(\), HOSTS_FILE\)/);
    assert.match(plugin, /getBridge\(\)\.getHost\(\)/, 'the app origin (localhost) is never cleaned');
    for (const call of ['clearCache(true)', 'clearHistory()', 'destroy()']) assert.ok(plugin.includes(`webView.${call}`), call);
    assert.ok(plugin.indexOf('cleanup();', plugin.indexOf('private void finish(')) > 0, 'cancel and success run the same cleanup');
  });

  it('Android: requests over OkHttp without cookie jar, cache or redirects; never HttpURLConnection or the CookieHandler', () => {
    const request = code(java('WebLoginRequest'));
    // Capacitor installs a process-wide CookieHandler at every start, which HttpURLConnection would use
    assert.doesNotMatch(request, /HttpURLConnection|java\.net\.|CookieHandler|URLConnection/);
    for (const part of ['.cookieJar(CookieJar.NO_COOKIES)', '.cache(null)', '.followRedirects(false)', '.followSslRedirects(false)',
      '.retryOnConnectionFailure(false)', '.callTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)']) assert.ok(request.includes(part), part);
    assert.match(request, /TIMEOUT_MS = 20000;/);
    assert.match(request, /MAX_BYTES = 8 \* 1024 \* 1024;/);
    assert.match(request, /if \(!isolated\(CLIENT\)\) throw new NotAllowed\(\);/);
    assert.match(request, /client\.cookieJar\(\) == CookieJar\.NO_COOKIES && client\.cache\(\) == null && !client\.followRedirects\(\) && !client\.followSslRedirects\(\)/);
    assert.match(request, /CLIENT\.newCall\(/);
    assert.equal((request.match(/new OkHttpClient/g) || []).length, 1, 'one client, built here');
    const plugin = code(java('WebLoginPlugin'));
    assert.match(plugin, /"GET"\.equals\(method\) \|\| "POST"\.equals\(method\)/);
    assert.match(read('plugins/mangashelf-native/android/build.gradle'), /implementation 'com\.squareup\.okhttp3:okhttp:4\.12\.\d+'/);
  });

  it('logging off: debug builds print no plugin payloads (Crunchyroll cookie, bearer tokens)', () => {
    const config = read('capacitor.config.ts');
    assert.match(config, /^ {2}loggingBehavior: 'none',$/m);
    assert.equal((config.match(/loggingBehavior/g) || []).length, 1, 'no platform override');
  });
});

describe('mobile.yml', () => {
  const yml = () => read('../.github/workflows/mobile.yml');
  const stepOf = (text, run) => {
    const at = text.indexOf(`run: npm run ${run}\n`);
    assert.ok(at > 0, run);
    return text.slice(text.lastIndexOf('- name:', at), at);
  };

  it('every step that builds the web part gets VITE_WATCH_CRUNCHYROLL from the repository variable', () => {
    const text = yml();
    for (const run of ['smoke:android', 'build:android', 'smoke:ios', 'build:ios']) {
      assert.match(stepOf(text, run), /\n {8}env:\n(?: {10}\S.*\n)*? {10}VITE_WATCH_CRUNCHYROLL: \$\{\{ vars\.WATCH_CRUNCHYROLL \}\}\n/, run);
    }
    assert.equal((text.match(/VITE_WATCH_CRUNCHYROLL:/g) || []).length, 4);
    assert.doesNotMatch(text, /:\s*write\b/, 'read-only token');
  });
});

describe('iOS share extension', () => {
  const pbx = () => read('ios/App/App.xcodeproj/project.pbxproj');
  const settingsOf = (text, bundleId) => [...text.matchAll(/buildSettings = \{([\s\S]*?)\};/g)].map((m) => m[1])
    .filter((body) => body.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};`));

  it('a ShareToMangaShelf target embedded in the app, extension API only, same deployment target and version', () => {
    const text = pbx();
    assert.match(text, new RegExp(`/\\* ${SHARE_TARGET} \\*/ = \\{\\s*isa = PBXNativeTarget;[\\s\\S]*?productType = "com\\.apple\\.product-type\\.app-extension";`));
    const app = settingsOf(text, 'de.mangashelf.app');
    const ext = settingsOf(text, SHARE_BUNDLE_ID);
    assert.equal(ext.length, 2);
    const value = (body, key) => new RegExp(`\\b${key} = ([^;]+);`).exec(body)?.[1];
    for (const body of ext) {
      assert.equal(value(body, 'APPLICATION_EXTENSION_API_ONLY'), 'YES');
      assert.equal(value(body, 'CODE_SIGN_ENTITLEMENTS'), `${SHARE_TARGET}/${SHARE_TARGET}.entitlements`);
      assert.equal(value(body, 'INFOPLIST_FILE'), `${SHARE_TARGET}/Info.plist`);
      for (const key of ['IPHONEOS_DEPLOYMENT_TARGET', 'MARKETING_VERSION', 'CURRENT_PROJECT_VERSION']) {
        assert.equal(value(body, key), value(app[0], key), key);
      }
    }
    for (const body of app) assert.equal(value(body, 'CODE_SIGN_ENTITLEMENTS'), 'App/App.entitlements');
    const appTarget = /\/\* App \*\/ = \{\s*isa = PBXNativeTarget;[\s\S]*?\n\t\t\};/.exec(text)[0];
    const phases = /buildPhases = \(([\s\S]*?)\);/.exec(appTarget)[1];
    assert.ok(phases.indexOf('Embed Foundation Extensions') > phases.indexOf('/* Resources */'));
    assert.ok(phases.indexOf('Embed Foundation Extensions') < phases.indexOf('[CP] Embed Pods Frameworks'), 'before the CocoaPods scripts (build cycle)');
    assert.match(text, /dstSubfolderSpec = 13;/);
    assert.doesNotMatch(text, /SDKs\/iPhoneOS[\d.]*\.sdk/, 'no reference into one Xcode version');
  });

  it('both targets carry the App Group; the extension and SharedInbox agree on suite, key and cap', () => {
    for (const file of ['App/App.entitlements', `${SHARE_TARGET}/${SHARE_TARGET}.entitlements`]) {
      const plist = read(`ios/App/${file}`);
      assert.match(plist, /<key>com\.apple\.security\.application-groups<\/key>\s*<array>\s*<string>group\.de\.mangashelf\.app<\/string>/, file);
    }
    assert.equal(APP_GROUP, 'group.de.mangashelf.app');
    const ext = read(`ios/App/${SHARE_TARGET}/ShareViewController.swift`);
    const inbox = read('plugins/mangashelf-native/ios/Sources/MangashelfNative/SharedInboxPlugin.swift');
    for (const source of [ext, inbox]) {
      assert.match(source, /static let suiteName = "group\.de\.mangashelf\.app"/);
      assert.match(source, /static let key = "pendingShares"/);
    }
    assert.match(ext, /static let cap = 20/);
    assert.match(ext, /An Manga Shelf übergeben – beim nächsten Öffnen bestätigen/);
    assert.doesNotMatch(code(ext), /openURL|\.open\(/, 'the extension never opens the app');
    assert.match(inbox, /didBecomeActiveNotification/);
    assert.match(inbox, /notifyListeners\("shareReceived", data: [\s\S]*?retainUntilConsumed: true\)/);
  });

  it('Info.plist: share service for one web URL or text, principal class, versions from the build settings', () => {
    const plist = read(`ios/App/${SHARE_TARGET}/Info.plist`);
    assert.match(plist, /<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.share-services<\/string>/);
    assert.match(plist, /<key>NSExtensionActivationSupportsWebURLWithMaxCount<\/key>\s*<integer>1<\/integer>/);
    assert.match(plist, /<key>NSExtensionActivationSupportsText<\/key>\s*<true\/>/);
    assert.match(plist, /<key>NSExtensionPrincipalClass<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.ShareViewController<\/string>/);
    assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/);
    assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/);
  });

  it('mobile.yml declares the optional profile secret and hands it only to the IPA build', () => {
    const yml = read('../.github/workflows/mobile.yml');
    const secrets = /secrets:\n([\s\S]*?)\n {2}workflow_dispatch:/.exec(yml)[1];
    assert.match(secrets, /IOS_SHARE_PROVISIONING_PROFILE_BASE64:\n\s+required: false/);
    const uses = [...yml.matchAll(/IOS_SHARE_PROVISIONING_PROFILE_BASE64: \$\{\{ secrets\.IOS_SHARE_PROVISIONING_PROFILE_BASE64 \}\}/g)];
    assert.equal(uses.length, 1);
    const step = yml.slice(yml.lastIndexOf('- name:', uses[0].index), yml.indexOf('run:', uses[0].index));
    assert.match(step, /name: Release-Build \(IPA\)/);
    assert.doesNotMatch(yml, /:\s*write\b/, 'no write permissions');
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

  it('Android share intent: SEND text/plain filter, manga-shelf://share, plugin registered before super.onCreate', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    const filters = manifest.match(/<intent-filter>[\s\S]*?<\/intent-filter>/g);
    const send = filters.find((f) => f.includes('android.intent.action.SEND"'));
    assert.ok(send, 'SEND filter');
    assert.match(send, /android\.intent\.category\.DEFAULT/);
    assert.match(send, /android:mimeType="text\/plain"/);
    const view = filters.find((f) => f.includes('android.intent.action.VIEW'));
    assert.match(view, /android:scheme="manga-shelf" android:host="connect"/);
    assert.match(view, /android:scheme="manga-shelf" android:host="share"/);
    const activity = read('android/app/src/main/java/de/mangashelf/app/MainActivity.java');
    const register = activity.indexOf('registerPlugin(ShareIntentPlugin.class)');
    assert.ok(register > 0, 'registered');
    assert.ok(register < activity.indexOf('super.onCreate('), 'before super.onCreate');
    const plugin = read('android/app/src/main/java/de/mangashelf/app/ShareIntentPlugin.java');
    assert.match(plugin, /@CapacitorPlugin\(name = "ShareIntent"\)/);
    assert.match(plugin, /notifyListeners\("shareReceived", data, true\)/, 'retained until JS subscribes');
    assert.match(plugin, /setIntent\(new Intent\(Intent\.ACTION_MAIN\)\)/, 'consumed');
    assert.doesNotMatch(plugin, /void load\(/, 'the cold-start intent arrives through handleOnNewIntent only');
  });

  it('share intent: a recreated or Recents-relaunched activity does not deliver the share again', () => {
    const activity = read('android/app/src/main/java/de/mangashelf/app/MainActivity.java');
    const guard = activity.indexOf('Intent.ACTION_SEND.equals(intent.getAction())');
    assert.ok(guard > 0, 'SEND guard in onCreate');
    assert.ok(guard < activity.indexOf('super.onCreate('), 'before super.onCreate, which replays getIntent()');
    const condition = activity.slice(guard, activity.indexOf('{', guard));
    assert.match(condition, /savedInstanceState != null/);
    assert.match(condition, /Intent\.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY/);
    assert.match(activity.slice(guard), /^[\s\S]*?setIntent\(new Intent\(Intent\.ACTION_MAIN\)\)/);
    const plugin = read('android/app/src/main/java/de/mangashelf/app/ShareIntentPlugin.java');
    const history = plugin.indexOf('Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY');
    assert.ok(history > 0, 'plugin ignores history relaunches');
    assert.ok(history < plugin.indexOf('notifyListeners('), 'before the share is delivered');
  });

  it('app launcher: dependency and cap sync output for both platforms', () => {
    assert.match(JSON.parse(read('package.json')).dependencies['@capacitor/app-launcher'], /^\^7\./);
    assert.match(read('android/capacitor.settings.gradle'), /capacitor-app-launcher/);
    assert.match(read('android/app/capacitor.build.gradle'), /capacitor-app-launcher/);
    assert.match(read('ios/App/Podfile'), /pod 'CapacitorAppLauncher'/);
    assert.match(read('ios/App/Podfile.lock'), /CapacitorAppLauncher/);
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
