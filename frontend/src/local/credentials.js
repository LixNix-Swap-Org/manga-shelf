// API keys of the standalone mode, outside manga.db. The browser build keeps them in
// IndexedDB, readable by anyone with access to this browser profile: flagged as "nicht sicher, nur für Tests". The apps
// replace the store with the device's secure storage (Capacitor Secure Storage, Electron safeStorage).
// provider() is the core/sources/credentials.js interface; reads are synchronous from memory after load().
export const INSECURE_STORAGE_TEXT = 'Im Browser liegen Schlüssel unverschlüsselt in diesem Browserprofil – nicht sicher, nur für Tests. Die App speichert sie im sicheren Speicher des Geräts.';

const keyOf = (userId, provider) => `${userId === null ? 'instance' : userId}:${provider}`;
const USED_WRITE_GAP_MS = 60 * 1000;

export function createLocalCredentials(store, { secure = false, now = () => Date.now() } = {}) {
  const entries = new Map();
  const lastUsedWrite = new Map();
  const persist = (key) => {
    const entry = entries.get(key);
    return (entry ? store.put('secrets', key, entry) : store.delete('secrets', key)).catch(() => {});
  };
  const patch = (userId, provider, change) => {
    const key = keyOf(userId, provider);
    const entry = entries.get(key);
    if (!entry) return;
    entries.set(key, { ...entry, ...change });
    persist(key);
  };
  const usable = (entry) => (entry && !entry.last_error ? entry : null);

  return {
    secure,
    async load() {
      entries.clear();
      for (const key of await store.keys('secrets')) {
        const entry = await store.get('secrets', key);
        if (entry && typeof entry.secret === 'string') entries.set(key, entry);
      }
    },
    entry: (userId, provider) => entries.get(keyOf(userId, provider)) || null,
    async save(userId, provider, { secret, label = null, allowBackground = false }) {
      const key = keyOf(userId, provider);
      entries.set(key, {
        secret, label, last4: secret.slice(-4), allow_background: userId === null ? 0 : (allowBackground ? 1 : 0),
        last_ok_at: now(), last_used_at: null, last_error: null
      });
      await persist(key);
      return entries.get(key);
    },
    async setAllowBackground(userId, provider, on) {
      const key = keyOf(userId, provider);
      if (!entries.has(key)) return null;
      entries.set(key, { ...entries.get(key), allow_background: on ? 1 : 0 });
      await persist(key);
      return entries.get(key);
    },
    async remove(userId, provider) {
      const key = keyOf(userId, provider);
      const had = entries.delete(key);
      await persist(key);
      return had;
    },
    usersWithKeys: () => new Set([...entries.keys()].filter((k) => !k.startsWith('instance:')).map((k) => k.split(':')[0])).size,
    provider() {
      return {
        get(userId, provider) {
          const entry = usable(entries.get(keyOf(userId, provider)));
          return entry ? { secret: entry.secret, allowBackground: Boolean(entry.allow_background) } : null;
        },
        instance(provider) {
          const entry = usable(entries.get(keyOf(null, provider)));
          return entry ? { secret: entry.secret, fromEnv: false } : null;
        },
        background(provider) {
          return [...entries.entries()]
            .filter(([key, e]) => key.endsWith(`:${provider}`) && !key.startsWith('instance:') && e.allow_background && !e.last_error)
            .map(([key, e]) => ({ userId: Number(key.split(':')[0]), secret: e.secret }));
        },
        failed(userId, provider, message) {
          patch(userId, provider, { last_error: message });
        },
        used(userId, provider, ok) {
          const key = keyOf(userId, provider);
          const t = now();
          if (t - (lastUsedWrite.get(key) || 0) < USED_WRITE_GAP_MS) return;
          lastUsedWrite.set(key, t);
          patch(userId, provider, ok ? { last_used_at: t, last_ok_at: t } : { last_used_at: t });
        },
        status(userId, provider) {
          const entry = entries.get(keyOf(userId, provider));
          return entry ? { configured: true, last_error: entry.last_error } : { configured: false, last_error: null };
        }
      };
    }
  };
}
