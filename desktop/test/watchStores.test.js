// Covers the encrypted Crunchyroll login file and the page's watch state file of the desktop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createWatchSecret } = require('../lib/watchSecret');
const { createWatchPrefs, WATCH_PREF_KEYS, MAX_VALUE_BYTES } = require('../lib/watchPrefs');
const { tempDir, fakeSafeStorage, SECRET } = require('./watchFakes');

const secretIn = (dir, safeStorage, platform = 'darwin') => createWatchSecret({ file: path.join(dir, 'watch-secret.json'), safeStorage, platform });

test('the login is encrypted in its own file with mode 0600 and read back', (t) => {
    const dir = tempDir(t);
    const store = secretIn(dir, fakeSafeStorage());
    assert.deepEqual(store.state(), { state: 'ok', value: null });
    assert.equal(store.read(), null);
    store.write(SECRET);
    const raw = fs.readFileSync(store.file, 'utf8');
    assert.ok(!raw.includes(SECRET.etp_rt));
    if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    assert.deepEqual(store.read(), SECRET);
    assert.deepEqual(store.state(), { state: 'ok', value: SECRET });
    assert.ok(!fs.existsSync(path.join(dir, 'secure-store.json')));
    store.remove();
    store.remove();
    assert.equal(fs.existsSync(store.file), false);
});

test('precedence: locked before unreadable, unavailable only without a file', (t) => {
    const dir = tempDir(t);
    const safe = fakeSafeStorage();
    const store = secretIn(dir, safe);
    store.write(SECRET);

    safe.available = false;
    let decrypts = 0;
    const decrypt = safe.decryptString;
    safe.decryptString = (buf) => { decrypts += 1; return decrypt(buf); };
    assert.equal(store.state().state, 'locked');
    assert.throws(() => store.read(), (err) => err.code === 'locked');
    assert.throws(() => store.write(SECRET), (err) => err.code === 'locked');
    assert.equal(decrypts, 0);

    safe.available = true;
    safe.decryptThrows = true;
    assert.equal(store.state().state, 'unreadable');
    assert.throws(() => store.read(), (err) => err.code === 'unreadable');

    store.remove();
    safe.available = false;
    assert.equal(store.state().state, 'unavailable');
    assert.equal(store.read(), null);
});

test('Linux counts only a real keyring as usable', (t) => {
    const dir = tempDir(t);
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
        assert.equal(secretIn(dir, fakeSafeStorage({ backend }), 'linux').usable(), true, backend);
    }
    for (const backend of ['basic_text', 'unknown']) {
        assert.equal(secretIn(dir, fakeSafeStorage({ backend }), 'linux').usable(), false, backend);
        assert.equal(secretIn(dir, fakeSafeStorage({ backend }), 'linux').state().state, 'unavailable', backend);
    }
    assert.equal(secretIn(dir, fakeSafeStorage({ backend: 'basic_text' }), 'darwin').usable(), true);
});

test('an encryptString throw is unreadable while the store is usable', (t) => {
    const dir = tempDir(t);
    const safe = fakeSafeStorage();
    const store = secretIn(dir, safe);
    safe.encryptThrows = true;
    assert.throws(() => store.write(SECRET), (err) => err.code === 'unreadable' && err.storeError === true);
    assert.equal(fs.existsSync(store.file), false);
});

test('watch prefs: only the three keys, strings only, at most 256 KiB in UTF-8', (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'watch-state.json');
    const prefs = createWatchPrefs({ file });
    assert.deepEqual([...WATCH_PREF_KEYS], ['watch-sync:crunchyroll:state', 'watch-sync:crunchyroll:unmatched', 'watch-sync:crunchyroll:skipped']);
    const [state, unmatched] = WATCH_PREF_KEYS;
    assert.deepEqual(prefs.get(state), { ok: true, value: null });
    assert.deepEqual(prefs.set(state, '{"a":1}'), { ok: true });
    assert.deepEqual(prefs.get(state), { ok: true, value: '{"a":1}' });
    for (const key of ['mangashelf_servers', '__proto__', '', null, 3]) {
        assert.deepEqual(prefs.get(key), { ok: false, code: 'not_allowed' }, String(key));
        assert.deepEqual(prefs.set(key, 'x'), { ok: false, code: 'not_allowed' }, String(key));
        assert.deepEqual(prefs.remove(key), { ok: false, code: 'not_allowed' }, String(key));
    }
    assert.deepEqual(prefs.set(state, 42), { ok: false, code: 'not_allowed' });
    assert.deepEqual(prefs.set(state, null), { ok: false, code: 'not_allowed' });
    assert.deepEqual(prefs.set(unmatched, 'ü'.repeat(MAX_VALUE_BYTES / 2)), { ok: true });
    assert.deepEqual(prefs.set(unmatched, 'ü'.repeat(MAX_VALUE_BYTES / 2) + 'x'), { ok: false, code: 'too_large' });
    assert.equal(createWatchPrefs({ file }).get(unmatched).value.length, MAX_VALUE_BYTES / 2);
    assert.deepEqual(prefs.remove(unmatched), { ok: true });
    assert.deepEqual(prefs.remove(unmatched), { ok: true });
    const again = createWatchPrefs({ file });
    assert.deepEqual(again.get(unmatched), { ok: true, value: null });
    assert.deepEqual(again.get(state), { ok: true, value: '{"a":1}' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
