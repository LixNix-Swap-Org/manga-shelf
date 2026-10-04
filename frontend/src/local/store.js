// Key-value storage of the standalone mode: the database file, the uploads (Blobs) and the API keys of the browser
// build. IndexedDB in the browser; memoryStore() for tests and as fallback when IndexedDB is missing.
export const LOCAL_DB_NAME = 'mangashelf-local';
// window event of the runtime: detail { type: 'status' | 'replaced' | 'reloaded', status } (App shows the notices)
export const LOCAL_STORE_EVENT = 'mangashelf:local-store';
// i18n
export const SAVE_FAILED_TEXT = 'Daten konnten nicht gespeichert werden';
// i18n
export const LOCKED_TEXT = 'Sammlung ist in einem anderen Fenster geöffnet';
// i18n
export const CONFLICT_TEXT = 'Die Sammlung wurde in einem anderen Fenster geändert – bitte neu laden.';
const STORES = ['db', 'files', 'secrets'];

const promisify = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export function indexedDbStore(idb = globalThis.indexedDB, name = LOCAL_DB_NAME) {
  let opening = null;
  const open = () => {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = idb.open(name, 1);
        req.onupgradeneeded = () => {
          for (const store of STORES) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { opening = null; reject(req.error); };
      });
    }
    return opening;
  };
  const run = async (store, mode, fn) => {
    const db = await open();
    const tx = db.transaction(store, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const value = await promisify(fn(tx.objectStore(store)));
    if (mode === 'readwrite') await done;
    else done.catch(() => {});
    return value;
  };
  return {
    // one database per browser profile: the runtime takes this navigator.locks lock for its lifetime
    lockName: name,
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    put: (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key)),
    delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
    keys: async (store) => (await run(store, 'readonly', (s) => s.getAllKeys())).map(String),
    clear: (store) => run(store, 'readwrite', (s) => s.clear())
  };
}

export function memoryStore() {
  const data = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  return {
    data,
    get: async (store, key) => data[store].get(key),
    put: async (store, key, value) => { data[store].set(key, value); },
    delete: async (store, key) => { data[store].delete(key); },
    keys: async (store) => [...data[store].keys()],
    clear: async (store) => { data[store].clear(); }
  };
}

export const defaultStore = () => (globalThis.indexedDB ? indexedDbStore() : memoryStore());
