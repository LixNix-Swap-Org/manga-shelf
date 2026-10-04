const path = require('path');
const { readJson, writeJson } = require('./jsonFile');

const STORE_FILE = 'secure-store.json';

/**
 * Key-value store for the app build's saved servers, encrypted via safeStorage (plain text without a backend).
 * While the backend is unavailable the store is `locked` (memory only): encrypted data is never downgraded.
 */
function createSecureStore(userDataDir, crypto) {
    const file = path.join(userDataDir, STORE_FILE);
    const available = Boolean(crypto && crypto.available());
    const entries = new Map();
    const sealed = new Map();
    const saved = readJson(file, null);
    const savedEncrypted = Boolean(saved && saved.encrypted);
    const locked = savedEncrypted && !available;
    const encrypted = available;
    if (saved && saved.entries && typeof saved.entries === 'object') {
        for (const [key, stored] of Object.entries(saved.entries)) {
            if (typeof stored !== 'string') continue;
            if (!savedEncrypted) {
                entries.set(key, stored);
                continue;
            }
            try {
                if (!available) throw new Error('locked');
                entries.set(key, crypto.decrypt(Buffer.from(stored, 'base64')));
            } catch (_) {
                // written under another keychain or the backend is locked: kept as it is
                sealed.set(key, stored);
            }
        }
    }

    const persist = () => {
        if (locked) return;
        const out = Object.fromEntries(sealed);
        for (const [key, value] of entries) {
            out[key] = encrypted ? crypto.encrypt(value).toString('base64') : value;
        }
        writeJson(file, { version: 1, encrypted, entries: out });
    };
    if (saved && !savedEncrypted && encrypted && entries.size) persist();

    const validKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 200;
    return {
        file,
        encrypted,
        locked,
        all: () => Object.fromEntries(entries),
        get: (key) => (entries.has(key) ? entries.get(key) : null),
        set(key, value) {
            if (!validKey(key) || typeof value !== 'string') return false;
            entries.set(key, value);
            sealed.delete(key);
            persist();
            return true;
        },
        remove(key) {
            const had = entries.delete(key) || sealed.delete(key);
            if (!had) return false;
            persist();
            return true;
        }
    };
}

/** safeStorage as the store's crypto; Linux "basic_text" is a fixed key, so it counts as unencrypted. */
function safeStorageCrypto(safeStorage, platform = process.platform) {
    return {
        available() {
            if (!safeStorage.isEncryptionAvailable()) return false;
            if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
                return safeStorage.getSelectedStorageBackend() !== 'basic_text';
            }
            return true;
        },
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (buffer) => safeStorage.decryptString(buffer)
    };
}

module.exports = { createSecureStore, safeStorageCrypto, STORE_FILE };
