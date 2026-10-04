// Browser start of the standalone core: sql.js with its wasm file (an asset of the app build), IndexedDB, fetch.
// Loaded lazily by localTransport.js, so neither sql.js nor the core reach the start chunk.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { createLocalRuntime } from './runtime.js';
import { defaultStore } from './store.js';
import { createBrowserHttp } from './http.js';

export async function bootLocalRuntime({ profile, adapters = {}, onBlocked } = {}) {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  return createLocalRuntime({
    SQL,
    store: adapters.store || defaultStore(),
    http: adapters.http || createBrowserHttp({ onBlocked }),
    secureCredentials: Boolean(adapters.secureCredentials),
    profile: profile ? { id: profile.id, name: profile.name } : {},
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
  });
}
