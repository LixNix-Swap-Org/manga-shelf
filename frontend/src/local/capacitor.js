// Interface of the native standalone adapters (iOS/Android through Capacitor, wired by the mobile package):
//   store:  { get(store, key), put(store, key, value), delete(store, key), keys(store), clear(store) } with the stores
//           'db' (manga.db bytes; on the device the file Directory.Data/manga.db), 'files' (uploads; Filesystem
//           Directory.Data/uploads/) and 'secrets' (API keys; Secure Storage)
//   http:   { fetch, fetchText, fetchImage } through CapacitorHttp (no CORS limits), same timeouts and size caps as
//           local/http.js
//   secureCredentials: true (keys in the device's secure storage, no "nicht sicher" hint)
// Until then the browser adapters (IndexedDB, fetch) are used. Plug them in before the first request:
//   setLocalAdapters(await createCapacitorAdapters(plugins)) from local/localTransport.js
export async function createCapacitorAdapters(plugins) {
  if (!plugins) throw new Error('Capacitor-Plugins fehlen: der Modus ohne Server nutzt im Browser IndexedDB');
  const { store, http } = plugins;
  if (!store || !http) throw new Error('Capacitor-Adapter unvollständig (store und http erforderlich)');
  return { store, http, secureCredentials: true };
}
