// ctx.files of the standalone browser build: uploads as Blobs in the key-value store, shown through object URLs.
// The database stores /uploads/<name> like the server; urlFor(name) maps it to the blob URL (assetUrl in utils/api.js).
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };

export const mimeOf = (name) => TYPES[(/\.[a-z0-9]+$/i.exec(name)?.[0] || '').toLowerCase()] || 'application/octet-stream';

const toBlob = (name, bytes) => (typeof Blob !== 'undefined' && bytes instanceof Blob ? bytes : new Blob([bytes], { type: mimeOf(name) }));

async function toBytes(blob) {
  if (!blob) return undefined;
  if (blob instanceof Uint8Array) return blob;
  return new Uint8Array(await blob.arrayBuffer());
}

export function createBlobFiles(store, { urls = globalThis.URL } = {}) {
  const objectUrls = new Map();
  const canUrl = typeof urls?.createObjectURL === 'function';
  const remember = (name, blob) => {
    if (!canUrl) return;
    const old = objectUrls.get(name);
    if (old) urls.revokeObjectURL(old);
    objectUrls.set(name, urls.createObjectURL(blob));
  };
  const forget = (name) => {
    const old = objectUrls.get(name);
    if (old && canUrl) urls.revokeObjectURL(old);
    objectUrls.delete(name);
  };
  return {
    async write(name, bytes) {
      const blob = toBlob(name, bytes);
      await store.put('files', name, blob);
      remember(name, blob);
    },
    read: async (name) => toBytes(await store.get('files', name)),
    async stat(name) {
      const blob = await store.get('files', name);
      return blob ? { size: blob.size ?? blob.length } : null;
    },
    touch: async () => {},
    async remove(name) {
      await store.delete('files', name);
      forget(name);
    },
    list: () => store.keys('files'),
    /** Object URLs for every stored upload, so <img src> resolves synchronously. */
    async preload() {
      for (const name of await store.keys('files')) {
        if (objectUrls.has(name)) continue;
        const blob = await store.get('files', name);
        if (blob) remember(name, toBlob(name, blob));
      }
    },
    urlFor: (name) => objectUrls.get(name) || null,
    async clear() {
      for (const name of [...objectUrls.keys()]) forget(name);
      await store.clear('files');
    }
  };
}
