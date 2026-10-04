// The standalone core on the device: manga.db in sql.js (schema and migrations of core/schema.js, unchanged), the
// handlers of core/routes.js in-process, the server-only routes of localServer.js, the database file persisted to the
// key-value store after every change. SQL (the initialised sql.js module) is passed in, so Node tests can use it too.
import ctxModule from '../../../core/ctx.js';
import schema from '../../../core/schema.js';
import coreRoutes from '../../../core/routes.js';
import errors from '../../../core/errors.js';
import sqljs from '../../../core/adapters/sqljs.js';
import { createBlobFiles } from './files.js';
import { createLocalCredentials } from './credentials.js';
import { createLocalServer } from './localServer.js';

export const DB_KEY = 'manga.db';
export const LOCAL_PASSWORD_HASH = '!local-profile';
const PERSIST_DELAY_MS = 300;

const deviceTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'; } catch (_) { return 'Europe/Berlin'; }
};

const randomId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Opens database bytes (or a new database), checks them and migrates to the current schema. */
export function openDatabase(SQL, bytes) {
  const database = bytes ? new SQL.Database(bytes) : new SQL.Database();
  try {
    const conn = sqljs.connectionFromSqlJs(database);
    if (bytes) {
      const check = conn.prepare('PRAGMA quick_check').get();
      const result = check ? String(Object.values(check)[0]) : 'unbekannt';
      if (result !== 'ok') throw new Error(`Datenbank ist beschädigt (${result})`);
      if (!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mangas'").get()) {
        throw new Error('Keine Manga-Shelf-Datenbank');
      }
      const version = schema.appliedSchemaVersion(conn);
      if (version > schema.LATEST_SCHEMA_VERSION) {
        throw Object.assign(new Error(`Die Sicherung stammt aus einer neueren Version (Schema v${version} > v${schema.LATEST_SCHEMA_VERSION}) – bitte erst die App aktualisieren.`), { code: 'SCHEMA_NEWER' });
      }
    }
    schema.applySchema(conn);
    return conn;
  } catch (err) {
    database.close();
    throw err;
  }
}

const profileOf = (row) => (row ? { id: row.id, username: row.username, role: 'admin' } : null);

/** The users row for the local profile: by id, else by name (case-insensitive), else a new admin row. */
export function ensureProfileRow(conn, { id = null, name } = {}) {
  if (id !== null && id !== undefined) {
    const row = conn.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    if (row) return profileOf(row);
  }
  const username = String(name || '').trim() || 'Ich';
  const byName = conn.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (byName) return profileOf(byName);
  const res = conn.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, LOCAL_PASSWORD_HASH);
  return profileOf({ id: Number(res.lastInsertRowid), username });
}

const asText = (body) => (typeof body === 'string' ? body : JSON.stringify(body));

export async function createLocalRuntime({ SQL, store, http, profile = {}, secureCredentials = false, persistDelayMs = PERSIST_DELAY_MS, appVersion = '' }) {
  const stored = await store.get('db', DB_KEY);
  let conn = openDatabase(SQL, stored);
  const usersBefore = conn.prepare('SELECT count(*) AS n FROM users').get().n;
  let user = ensureProfileRow(conn, profile);
  const fresh = !stored || conn.prepare('SELECT count(*) AS n FROM users').get().n !== usersBefore;
  const files = createBlobFiles(store);
  await files.preload();
  const credentials = createLocalCredentials(store, { secure: secureCredentials });
  await credentials.load();

  const makeCtx = () => ctxModule.createCtx({
    db: ctxModule.dbFromConnection(conn),
    files,
    http,
    credentials: credentials.provider(),
    config: { appTimeZone: deviceTimeZone(), appVersion },
    randomId
  });
  let ctx = makeCtx();

  let timer = null;
  let saving = Promise.resolve();
  const save = () => {
    clearTimeout(timer);
    timer = null;
    const bytes = conn.export();
    saving = saving.then(() => store.put('db', DB_KEY, bytes)).catch((err) => {
      console.warn('[Lokal] Datenbank nicht gespeichert:', err?.message || err);
    });
    return saving;
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, persistDelayMs);
  };
  const flush = () => (timer ? save() : saving);
  // a new database or a new profile row is stored right away, not only with the first change
  if (fresh) await save();

  // every users row is a profile here (a server backup brings its users along); the role is always admin
  const listProfiles = () => conn.prepare('SELECT id, username, created_at FROM users ORDER BY id').all()
    .map((row) => ({ ...row, role: 'admin' }));

  const server = createLocalServer({
    getCtx: () => ctxModule.withUser(ctx, user),
    getProfile: () => user,
    listProfiles,
    credentials,
    http,
    isCoreRoute: (method, path) => Boolean(coreRoutes.matchRoute(method, path))
  });

  /** One request below /api as the server would answer it: { status, headers, body } (body: object or text). */
  async function request(method, url, body) {
    const m = String(method || 'GET').toUpperCase();
    const target = String(url);
    if (!target.startsWith('/api/')) return { status: 404, headers: {}, body: { error: 'Nicht gefunden', code: 'NOT_FOUND' } };
    const sub = target.slice(4);
    const path = sub.split('?')[0];
    try {
      const local = await server.handle(m, path, body);
      const answer = local ?? await coreRoutes.dispatch(ctxModule.withUser(ctx, user), { method: m, url: sub, body: typeof FormData !== 'undefined' && body instanceof FormData ? {} : body });
      if (m !== 'GET' && m !== 'HEAD') schedule();
      return { status: answer.status || 200, headers: answer.headers || {}, body: answer.body };
    } catch (err) {
      if (m !== 'GET' && m !== 'HEAD') schedule();
      const { status, body: errBody } = errors.errorAnswer(err);
      if (status >= 500) console.error('[Lokal]', m, path, err);
      return { status, headers: {}, body: errBody };
    }
  }

  return {
    request,
    asText,
    flush,
    files,
    credentials,
    getProfile: () => user,
    listProfiles,
    getContext: () => ctxModule.withUser(ctx, user),
    /** Schema version and row counts, as the server's backup manifest reports them. */
    facts() {
      const count = (sql) => conn.prepare(sql).get().n;
      return {
        schema_version: schema.appliedSchemaVersion(conn),
        counts: {
          mangas: count('SELECT count(*) AS n FROM mangas'),
          volumes: count('SELECT count(*) AS n FROM volumes'),
          users: count('SELECT count(*) AS n FROM users')
        }
      };
    },
    /** The database file as bytes (pending changes included). */
    exportDatabase() {
      clearTimeout(timer);
      timer = null;
      const bytes = conn.export();
      saving = saving.then(() => store.put('db', DB_KEY, bytes)).catch(() => {});
      return bytes;
    },
    /**
     * Replaces the collection: database bytes (checked and migrated first) and, when given, all uploads. The profile
     * becomes the row named `profileName` (case-insensitive), else the first admin, else a new row.
     */
    async replaceDatabase(bytes, { uploads = null, profileName } = {}) {
      const next = openDatabase(SQL, bytes);
      const admin = next.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      const named = profileName ? next.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(profileName) : null;
      const nextUser = ensureProfileRow(next, { id: named?.id ?? admin?.id ?? null, name: profileName || user.username });
      await flush();
      if (uploads) {
        await files.clear();
        for (const [name, data] of uploads) await files.write(name, data);
      }
      conn.close();
      conn = next;
      user = nextUser;
      ctx = makeCtx();
      await save();
      return user;
    },
    /**
     * Bytes of a changed copy: `fn(conn)` runs on a copy of this database (`from: 'current'`) or on a new, empty one
     * (`from: 'empty'`); the live database stays as it is.
     */
    databaseCopy(fn, { from = 'current' } = {}) {
      const copy = openDatabase(SQL, from === 'empty' ? null : conn.export());
      try {
        fn(copy);
        return copy.export();
      } finally {
        copy.close();
      }
    },
    /** Switches to (or creates) a profile in this database. */
    useProfile(selection) {
      user = ensureProfileRow(conn, selection);
      schedule();
      return user;
    },
    async close() {
      await flush();
      conn.close();
    }
  };
}
