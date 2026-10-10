const { readJson, writeJson } = require('./jsonFile');

const WATCH_PREF_KEYS = Object.freeze(['watch-sync:crunchyroll:state', 'watch-sync:crunchyroll:unmatched', 'watch-sync:crunchyroll:skipped']);
const MAX_VALUE_BYTES = 262144;

const NOT_ALLOWED = Object.freeze({ ok: false, code: 'not_allowed' });
const allowedKey = (key) => typeof key === 'string' && WATCH_PREF_KEYS.includes(key);

/** The per-device watch state of the page (three fixed keys), kept by the main process. */
function createWatchPrefs({ file }) {
    let values = null;
    const load = () => {
        if (!values) {
            const saved = readJson(file, null);
            values = {};
            const stored = saved && saved.values && typeof saved.values === 'object' ? saved.values : {};
            for (const key of WATCH_PREF_KEYS) if (typeof stored[key] === 'string') values[key] = stored[key];
        }
        return values;
    };
    const persist = (next) => {
        writeJson(file, { version: 1, values: next });
        values = next;
    };

    return {
        get(key) {
            if (!allowedKey(key)) return NOT_ALLOWED;
            const all = load();
            return { ok: true, value: Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null };
        },
        set(key, value) {
            if (!(typeof key === 'string' && typeof value === 'string') || !allowedKey(key)) return NOT_ALLOWED;
            if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return { ok: false, code: 'too_large' };
            persist({ ...load(), [key]: value });
            return { ok: true };
        },
        remove(key) {
            if (!allowedKey(key)) return NOT_ALLOWED;
            const all = load();
            if (Object.prototype.hasOwnProperty.call(all, key)) {
                const next = { ...all };
                delete next[key];
                persist(next);
            }
            return { ok: true };
        }
    };
}

module.exports = { createWatchPrefs, WATCH_PREF_KEYS, MAX_VALUE_BYTES };
