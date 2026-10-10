const fs = require('fs');
const { readJson, writeJson } = require('./jsonFile');

const KEYRING_BACKENDS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'];

const storeError = (code) => Object.assign(new Error(code), { code, storeError: true });

/** The Crunchyroll login of this device, encrypted with safeStorage in its own file; never handed to a page. */
function createWatchSecret({ file, safeStorage, platform }) {
    const usable = () => {
        try {
            if (!safeStorage.isEncryptionAvailable()) return false;
            return platform !== 'linux' || KEYRING_BACKENDS.includes(safeStorage.getSelectedStorageBackend());
        } catch (_) {
            return false;
        }
    };
    const exists = () => fs.existsSync(file);

    const decrypt = () => {
        const saved = readJson(file, null);
        if (!saved || typeof saved.data !== 'string') throw storeError('unreadable');
        let text;
        try {
            text = safeStorage.decryptString(Buffer.from(saved.data, 'base64'));
        } catch (_) {
            throw storeError('unreadable');
        }
        try {
            const value = JSON.parse(text);
            return value && typeof value === 'object' ? value : null;
        } catch (_) {
            return null;
        }
    };

    return {
        file,
        usable,
        state() {
            const present = exists();
            const ok = usable();
            if (present && !ok) return { state: 'locked', value: null };
            if (!present && !ok) return { state: 'unavailable', value: null };
            if (!present) return { state: 'ok', value: null };
            try {
                return { state: 'ok', value: decrypt() };
            } catch (err) {
                return { state: err.code || 'unreadable', value: null };
            }
        },
        read() {
            if (!exists()) return null;
            if (!usable()) throw storeError('locked');
            return decrypt();
        },
        write(value) {
            if (!usable()) throw storeError('locked');
            let data;
            try {
                data = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
            } catch (_) {
                throw storeError(usable() ? 'unreadable' : 'locked');
            }
            writeJson(file, { version: 1, data });
        },
        remove() {
            try {
                fs.unlinkSync(file);
            } catch (_) { /* already gone */ }
        }
    };
}

module.exports = { createWatchSecret, KEYRING_BACKENDS };
