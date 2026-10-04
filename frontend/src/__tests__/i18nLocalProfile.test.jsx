// Standalone mode: the device core stores the profile's language like the server (PUT /auth/profile, /auth/me).
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import { createLocalRuntime } from '../local/runtime.js';
import { memoryStore } from '../local/store.js';

const offline = { fetch: async () => { throw new TypeError('offline'); }, fetchText: async () => { throw new Error('offline'); }, fetchImage: async () => { throw new Error('offline'); } };
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

describe('device core: language of the local profile', () => {
  it('PUT /api/auth/profile writes the profile row, /auth/me reads it back, the database is saved', async () => {
    const store = memoryStore();
    const rt = await createLocalRuntime({ SQL, store, http: offline, profile: { name: 'Felix' }, persistDelayMs: 0 });
    const put = await rt.request('PUT', '/api/auth/profile', { locale: 'en', default_language: 'ja' });
    expect(put.status).toBe(200);
    expect(put.body.user).toMatchObject({ id: 1, username: 'Felix', local: true, locale: 'en', default_language: 'ja' });
    expect((await rt.request('GET', '/api/auth/me')).body.user).toMatchObject({ locale: 'en', default_language: 'ja' });
    const bad = await rt.request('PUT', '/api/auth/profile', { locale: 'xx' });
    expect([bad.status, bad.body.code]).toEqual([400, 'LOCALE_INVALID']);
    await rt.flush();
    const reopened = await createLocalRuntime({ SQL, store, http: offline, profile: { id: 1, name: 'Felix' }, persistDelayMs: 0 });
    expect((await reopened.request('GET', '/api/auth/me')).body.user.locale).toBe('en');
    await rt.close?.();
    await reopened.close?.();
  });
});
