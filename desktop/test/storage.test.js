// Covers the encrypted secret store and the persisted desktop settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSecureStore, safeStorageCrypto } = require('../lib/secureStore');
const { createSettings } = require('../lib/settings');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-desktop-'));

// stands in for safeStorage: reversible, but the file must not contain the plain value
const fakeCrypto = (available = true) => ({
    available: () => available,
    encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString('hex')}`),
    decrypt: (buf) => {
        const raw = buf.toString();
        if (!raw.startsWith('enc:')) throw new Error('fremder Schlüssel');
        return Buffer.from(raw.slice(4), 'hex').toString();
    }
});

test('secure store encrypts values on disk and reads them back', (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = createSecureStore(dir, fakeCrypto());
    assert.equal(store.encrypted, true);
    assert.equal(store.get('mangashelf_servers'), null);
    store.set('mangashelf_servers', '[{"token":"geheim-123"}]');
    store.set('mangashelf_active_server', 'srv-1');
    const raw = fs.readFileSync(store.file, 'utf8');
    assert.ok(!raw.includes('geheim-123'));
    assert.equal(JSON.parse(raw).encrypted, true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);

    const again = createSecureStore(dir, fakeCrypto());
    assert.deepEqual(again.all(), { mangashelf_servers: '[{"token":"geheim-123"}]', mangashelf_active_server: 'srv-1' });
    assert.equal(again.remove('mangashelf_active_server'), true);
    assert.equal(again.remove('mangashelf_active_server'), false);
    assert.deepEqual(Object.keys(createSecureStore(dir, fakeCrypto()).all()), ['mangashelf_servers']);
});

test('secure store refuses bad keys and values', (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = createSecureStore(dir, fakeCrypto());
    assert.equal(store.set('', 'x'), false);
    assert.equal(store.set('k'.repeat(201), 'x'), false);
    assert.equal(store.set('k', 42), false);
    assert.deepEqual(store.all(), {});
});

test('without encryption values stay readable and are marked unencrypted; a broken file starts empty', (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const plain = createSecureStore(dir, fakeCrypto(false));
    assert.equal(plain.encrypted, false);
    plain.set('a', 'b');
    assert.equal(JSON.parse(fs.readFileSync(plain.file, 'utf8')).encrypted, false);
    // the keychain becomes available later: the entries are re-written encrypted
    const upgraded = createSecureStore(dir, fakeCrypto(true));
    assert.equal(upgraded.get('a'), 'b');
    assert.equal(JSON.parse(fs.readFileSync(plain.file, 'utf8')).encrypted, true);

    fs.writeFileSync(plain.file, '{kaputt');
    assert.deepEqual(createSecureStore(dir, fakeCrypto()).all(), {});
});

test('entries another keychain wrote stay unreadable but are written back unchanged, the rest loads', (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = createSecureStore(dir, fakeCrypto());
    store.set('ok', 'wert');
    const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    const foreign = Buffer.from('xyz').toString('base64');
    saved.entries.foreign = foreign;
    fs.writeFileSync(store.file, JSON.stringify(saved));
    const again = createSecureStore(dir, fakeCrypto());
    assert.deepEqual(again.all(), { ok: 'wert' });
    again.set('neu', 'x');
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).entries.foreign, foreign);
    assert.equal(again.remove('foreign'), true);
    assert.equal('foreign' in JSON.parse(fs.readFileSync(store.file, 'utf8')).entries, false);
});

test('a locked keychain never downgrades the file: entries stay encrypted, changes live in memory only', (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const first = createSecureStore(dir, fakeCrypto());
    first.set('mangashelf_servers', '[{"id":"s1","token":"T1"}]');
    first.set('mangashelf_active_server', 's1');
    const before = fs.readFileSync(first.file, 'utf8');

    const locked = createSecureStore(dir, fakeCrypto(false));
    assert.equal(locked.locked, true);
    assert.equal(locked.encrypted, false);
    assert.deepEqual(locked.all(), {});
    assert.equal(locked.set('mangashelf_active_server', 's2'), true);
    assert.equal(locked.get('mangashelf_active_server'), 's2');
    locked.remove('mangashelf_servers');
    assert.equal(fs.readFileSync(first.file, 'utf8'), before, 'the file is not touched');
    assert.ok(!fs.readFileSync(first.file, 'utf8').includes('s2'));

    const unlocked = createSecureStore(dir, fakeCrypto(true));
    assert.equal(unlocked.locked, false);
    assert.deepEqual(unlocked.all(), { mangashelf_servers: '[{"id":"s1","token":"T1"}]', mangashelf_active_server: 's1' });
    // a plain file without a keychain stays a plain file (nothing to protect yet)
    const plainDir = tempDir();
    t.after(() => fs.rmSync(plainDir, { recursive: true, force: true }));
    createSecureStore(plainDir, fakeCrypto(false)).set('a', 'b');
    assert.equal(createSecureStore(plainDir, fakeCrypto(false)).locked, false);
});

test('safeStorageCrypto treats Linux basic_text as unencrypted', () => {
    const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
    assert.equal(safeStorageCrypto(safeStorage, 'linux').available(), false);
    assert.equal(safeStorageCrypto({ ...safeStorage, getSelectedStorageBackend: () => 'gnome_libsecret' }, 'linux').available(), true);
    assert.equal(safeStorageCrypto(safeStorage, 'darwin').available(), true);
    assert.equal(safeStorageCrypto({ ...safeStorage, isEncryptionAvailable: () => false }, 'win32').available(), false);
});

test('settings persist normalised values and survive a broken file', (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const settings = createSettings(dir);
    assert.equal(settings.get().mode, null);
    settings.update({ mode: 'server', serverPort: 8080, bogus: true });
    const again = createSettings(dir);
    assert.equal(again.get().mode, 'server');
    assert.equal(again.get().serverPort, 8080);
    assert.equal('bogus' in again.get(), false);
    fs.writeFileSync(settings.file, 'nope');
    assert.equal(createSettings(dir).get().mode, null);
});
