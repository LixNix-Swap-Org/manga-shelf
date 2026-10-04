// Native adapters of the standalone mode on iOS/Android; plugins come from window.mangashelfNative, plugged in by
// app/shell/capacitor.js before the first request. 'secrets' = Keychain / Keystore, never manga.db.
// The core stays in sql.js because its ctx.db is synchronous, the native SQLite plugin is not.
import { createBrowserHttp } from './http.js';
import { t } from '../i18n/index.js';

// runtime.js DB_KEY (not imported: runtime.js pulls in the core, which belongs to the lazy boot chunk)
const DB_KEY = 'manga.db';
export const UPLOAD_DIR = 'uploads';
export const SECRET_PREFIX = 'local-secret:';
const CHUNK = 0x8000;

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new TypeError(t('Nur Bytes oder Blobs lassen sich als Datei speichern'));
}

const safeName = (name) => {
  const text = String(name);
  if (!text || text.includes('/') || text.includes('\\') || text === '.' || text === '..') throw new Error(t('Ungültiger Dateiname: {text}', { text }));
  return text;
};

export function createNativeStore(bridge) {
  const { Filesystem, SecureStorage } = bridge.plugins;
  const directory = bridge.constants.Directory.Data;

  const read = async (path) => {
    try {
      const { data } = await Filesystem.readFile({ path, directory });
      return typeof data === 'string' ? base64ToBytes(data) : toBytes(data);
    } catch (err) {
      const found = await Filesystem.stat({ path, directory }).then(() => true, () => false);
      if (found) throw err;
      return undefined;
    }
  };
  const write = async (path, value) => {
    await Filesystem.writeFile({ path, directory, data: bytesToBase64(await toBytes(value)), recursive: true });
  };
  const remove = (path) => Filesystem.deleteFile({ path, directory }).catch(() => {});
  const exists = (path) => Filesystem.stat({ path, directory }).then(() => true, () => false);
  const rename = (from, to) => Filesystem.rename({ from, to, directory, toDirectory: directory });
  const uploadPath = (key) => `${UPLOAD_DIR}/${safeName(key)}`;

  /**
   * After an interrupted save (manga.db missing) the last complete copy is promoted before anything reads or writes.
   * .new is complete once .old exists, .tmp is the older scheme's copy; a lone .new is an unfinished first save.
   */
  async function recover(name) {
    if (await exists(name)) {
      await remove(`${name}.new`);
      await remove(`${name}.old`);
      await remove(`${name}.tmp`);
      return;
    }
    const hasOld = await exists(`${name}.old`);
    const candidates = hasOld ? [`${name}.new`, `${name}.old`] : [`${name}.tmp`];
    for (const from of candidates) {
      if (await exists(from)) {
        await rename(from, name);
        break;
      }
    }
    await remove(`${name}.new`);
    await remove(`${name}.old`);
    await remove(`${name}.tmp`);
  }

  // one database operation at a time: a read must never promote or delete the copy a running save works on
  let dbTail = Promise.resolve();
  const serial = (task) => {
    const run = dbTail.then(task, task);
    dbTail = run.catch(() => {});
    return run;
  };

  const db = {
    get: (key) => serial(async () => {
      const name = safeName(key);
      await recover(name);
      return read(name);
    }),
    put: (key, value) => serial(async () => {
      const name = safeName(key);
      await recover(name);
      await write(`${name}.new`, value);
      const hadOld = await exists(name);
      if (hadOld) await rename(name, `${name}.old`);
      await rename(`${name}.new`, name);
      if (hadOld) await remove(`${name}.old`);
    }),
    delete: (key) => serial(async () => {
      const name = safeName(key);
      for (const path of [name, `${name}.new`, `${name}.old`, `${name}.tmp`]) await remove(path);
    }),
    keys: () => serial(async () => {
      await recover(DB_KEY);
      return (await exists(DB_KEY)) ? [DB_KEY] : [];
    }),
    clear: () => db.delete(DB_KEY)
  };

  const files = {
    get: (key) => read(uploadPath(key)),
    put: (key, value) => write(uploadPath(key), value),
    delete: (key) => remove(uploadPath(key)),
    async keys() {
      try {
        const { files: entries } = await Filesystem.readdir({ path: UPLOAD_DIR, directory });
        return entries.filter((e) => e.type !== 'directory').map((e) => (typeof e === 'string' ? e : e.name));
      } catch (_) {
        return [];
      }
    },
    clear: () => Filesystem.rmdir({ path: UPLOAD_DIR, directory, recursive: true }).catch(() => {})
  };

  const secrets = {
    async get(key) {
      const raw = await SecureStorage.getItem(SECRET_PREFIX + key);
      if (raw === null || raw === undefined) return undefined;
      try { return JSON.parse(raw); } catch (_) { return undefined; }
    },
    put: (key, value) => SecureStorage.setItem(SECRET_PREFIX + key, JSON.stringify(value)),
    delete: (key) => SecureStorage.removeItem(SECRET_PREFIX + key),
    keys: async () => (await SecureStorage.keys()).filter((k) => k.startsWith(SECRET_PREFIX)).map((k) => k.slice(SECRET_PREFIX.length)),
    async clear() {
      for (const key of await secrets.keys()) await secrets.delete(key);
    }
  };

  const stores = { db, files, secrets };
  const pick = (store) => {
    const target = stores[store];
    if (!target) throw new Error(t('Unbekannter Speicher: {store}', { store }));
    return target;
  };
  return {
    get: async (store, key) => pick(store).get(key),
    put: async (store, key, value) => pick(store).put(key, value),
    delete: async (store, key) => pick(store).delete(key),
    keys: async (store) => pick(store).keys(),
    clear: async (store) => pick(store).clear()
  };
}

/**
 * ctx.files over Directory.Data/uploads: read/stat/list hit the file system, <img> gets convertFileSrc(<uri>/<name>).
 * null without convertFileSrc/getUri (the runtime then falls back to Blobs in the store).
 */
export async function createNativeFiles(bridge, store = createNativeStore(bridge)) {
  const { Filesystem } = bridge?.plugins || {};
  if (typeof bridge?.convertFileSrc !== 'function' || typeof Filesystem?.getUri !== 'function') return null;
  const directory = bridge.constants.Directory.Data;
  let base;
  try {
    base = String((await Filesystem.getUri({ path: UPLOAD_DIR, directory })).uri || '').replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
  if (!base) return null;
  // a rewritten name gets a new URL, else the WebView keeps showing the cached image
  const versions = new Map();
  const valid = (name) => {
    try { return safeName(name); } catch (_) { return null; }
  };
  return {
    async write(name, bytes) {
      await store.put('files', name, bytes);
      versions.set(name, (versions.get(name) || 0) + 1);
    },
    read: (name) => store.get('files', name),
    async stat(name) {
      if (!valid(name)) return null;
      try {
        const info = await Filesystem.stat({ path: `${UPLOAD_DIR}/${name}`, directory });
        return { size: Number(info?.size) || 0 };
      } catch (_) {
        return null;
      }
    },
    touch: async () => {},
    async remove(name) {
      await store.delete('files', name);
      versions.delete(name);
    },
    list: () => store.keys('files'),
    urlFor(name) {
      if (!valid(name)) return null;
      const url = bridge.convertFileSrc(`${base}/${encodeURIComponent(name)}`);
      return versions.has(name) ? `${url}?v=${versions.get(name)}` : url;
    },
    async clear() {
      versions.clear();
      await store.clear('files');
    }
  };
}

/** ctx.http of the apps: Capacitor sends fetch natively, so a failed request is a network error, never a CORS block. */
export const createNativeHttp = (fetchImpl = (...args) => globalThis.fetch(...args)) => createBrowserHttp({ fetchImpl, isOnline: () => false });

/** The adapters for setLocalAdapters(); throws without the native bridge (the browser build keeps IndexedDB). */
export async function createCapacitorAdapters(bridge) {
  if (!bridge?.plugins?.Filesystem || !bridge.plugins.SecureStorage) {
    throw new Error(t('Capacitor-Plugins fehlen: der Modus ohne Server nutzt im Browser IndexedDB'));
  }
  const store = createNativeStore(bridge);
  const files = await createNativeFiles(bridge, store);
  return { store, http: createNativeHttp(), ...(files ? { files } : {}), secureCredentials: true };
}
