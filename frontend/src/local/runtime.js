// The standalone core on the device: manga.db in sql.js (schema and migrations of core/schema.js, unchanged), the
// handlers of core/routes.js in-process, the server-only routes of localServer.js, the database file persisted to the
// key-value store after every change. SQL (the initialised sql.js module) is passed in, so Node tests can use it too.
import ctxModule from '../../../core/ctx.js';
import schema from '../../../core/schema.js';
import coreRoutes from '../../../core/routes.js';
import errors from '../../../core/errors.js';
import sqljs from '../../../core/adapters/sqljs.js';
import trash from '../../../core/handlers/trash.js';
import { createBlobFiles } from './files.js';
import { createLocalCredentials } from './credentials.js';
import { createLocalServer } from './localServer.js';
import { LOCAL_STORE_EVENT, SAVE_FAILED_TEXT, LOCKED_TEXT, CONFLICT_TEXT } from './store.js';
import { windowLocks as sharedWindowLocks } from './localTransport.js';
import { LOCAL_PASSWORD_HASH, sanitizeImportedDatabase } from './sanitize.js';
import { t } from '../i18n/index.js';

export const DB_KEY = 'manga.db';
// save counter next to the bytes (as text bytes: the native store only takes bytes)
export const SAVE_SEQ_KEY = 'manga.db.seq';
export { LOCAL_PASSWORD_HASH };
export const STAGED_PREFIX = '.incoming-';
// i18n
export const BUSY_TEXT = 'Die Sammlung wird gerade ersetzt – bitte gleich noch einmal versuchen.';
// a follower's profile that the stored database does not have yet: no row until this window holds the lock
export const PENDING_PROFILE_ID = -1;
const PERSIST_DELAY_MS = 300;
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const READ_METHODS = new Set(['GET', 'HEAD']);

const deviceTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'; } catch (_) { return 'Europe/Berlin'; }
};

const randomId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Opens database bytes (or a new database), checks them and migrates to the current schema. `live`: it becomes the
 * device's database, so its publisher aliases become the map of normalizePublisher (never for a copy).
 */
export function openDatabase(SQL, bytes, { live = false } = {}) {
  const database = bytes ? new SQL.Database(bytes) : new SQL.Database();
  try {
    const conn = sqljs.connectionFromSqlJs(database);
    if (bytes) {
      const check = conn.prepare('PRAGMA quick_check').get();
      const result = check ? String(Object.values(check)[0]) : t('unbekannt');
      if (result !== 'ok') throw new Error(t('Datenbank ist beschädigt ({result})', { result }));
      if (!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mangas'").get()) {
        throw new Error(t('Keine Manga-Shelf-Datenbank'));
      }
      const version = schema.appliedSchemaVersion(conn);
      if (version > schema.LATEST_SCHEMA_VERSION) {
        throw Object.assign(new Error(t('Die Sicherung stammt aus einer neueren Version (Schema v{version} > v{latestSchemaVersion}) – bitte erst die App aktualisieren.', { version, latestSchemaVersion: schema.LATEST_SCHEMA_VERSION })), { code: 'SCHEMA_NEWER' });
      }
    }
    schema.applySchema(conn, { loadAliases: live });
    return conn;
  } catch (err) {
    database.close();
    throw err;
  }
}

const profileOf = (row) => (row ? { id: row.id, username: row.username, role: 'admin' } : null);

/**
 * The users row for the local profile: by id (with `sameName` only while its name still matches), else by name
 * (case-insensitive), else a new admin row (null with `create: false`).
 */
export function ensureProfileRow(conn, { id = null, name } = {}, { create = true, sameName = false } = {}) {
  // stored profile name: stays German like every stored default
  const username = String(name || '').trim() || 'Ich'; // i18n-ignore
  if (id !== null && id !== undefined) {
    const row = conn.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    if (row && (!sameName || String(row.username).toLowerCase() === username.toLowerCase())) return profileOf(row);
  }
  const byName = conn.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (byName) return profileOf(byName);
  if (!create) return null;
  const res = conn.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, LOCAL_PASSWORD_HASH);
  return profileOf({ id: Number(res.lastInsertRowid), username });
}

const asText = (body) => (typeof body === 'string' ? body : JSON.stringify(body));

const TX_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const WRITE_SQL = /^\s*(WITH|INSERT|UPDATE|DELETE|REPLACE)\b|\bRETURNING\b/i;

/**
 * The connection with a write hook: a run() that changed rows, a get()/all() of a write statement (DELETE … RETURNING)
 * or an exec() other than transaction control marks it dirty.
 */
export function trackWrites(raw, onWrite) {
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      const writes = WRITE_SQL.test(sql);
      const reading = (fn) => (writes ? (...params) => {
        const result = fn(...params);
        onWrite();
        return result;
      } : fn);
      return {
        get: reading(stmt.get),
        all: reading(stmt.all),
        run: (...params) => {
          const result = stmt.run(...params);
          if (result?.changes) onWrite();
          return result;
        }
      };
    },
    exec(sql) {
      raw.exec(sql);
      if (!TX_CONTROL.test(sql)) onWrite();
    },
    export: () => raw.export(),
    close: () => raw.close()
  };
}

// the columns that can name an upload (services/uploadCleanup.js REFERENCE_COLUMNS)
const REFERENCE_COLUMNS = {
  mangas: ['cover_image', 'banner_image', 'description', 'manga_passion_edition_data'],
  volumes: ['cover_image', 'images', 'notes'],
  animes: ['cover_image', 'banner_image'],
  trash: ['payload']
};
const TOKEN_NAME = /^[A-Za-z0-9._-]+$/;

/** isReferenced(name) over every value of the reference columns (whole tokens; other names as substring). */
export function uploadReferences(conn) {
  const values = [];
  for (const [table, wanted] of Object.entries(REFERENCE_COLUMNS)) {
    const present = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    const columns = wanted.filter((c) => present.has(c));
    if (!columns.length) continue;
    for (const row of conn.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all()) {
      for (const c of columns) if (row[c]) values.push(String(row[c]));
    }
  }
  const tokens = new Set(values.flatMap((v) => v.split(/[^A-Za-z0-9._-]+/)).filter(Boolean));
  let text = null;
  return (name) => {
    if (tokens.has(name)) return true;
    if (TOKEN_NAME.test(name)) return false;
    text ??= values.join('\n');
    return text.includes(name) || text.includes(encodeURIComponent(name));
  };
}

const encodeSeq = (n) => Uint8Array.from(String(n), (c) => c.charCodeAt(0));
const decodeSeq = (value) => {
  if (!value) return 0;
  const n = Number(typeof value === 'string' ? value : String.fromCharCode(...value));
  return Number.isFinite(n) ? n : 0;
};

const sameBytes = (a, b) => Boolean(a && b) && a.length === b.length && a.every((x, i) => x === b[i]);

const codedError = (message, code) => Object.assign(new Error(message), { code });

/** Holds `name` through navigator.locks: { held, done, release } once granted; null when another holder has it. */
function requestLock(locks, name, options = {}) {
  return new Promise((resolve, reject) => {
    let release;
    const held = new Promise((r) => { release = r; });
    let done;
    try {
      done = locks.request(name, options, (lock) => {
        if (!lock) { resolve(null); return undefined; }
        resolve({ get done() { return done; }, release });
        return held;
      });
    } catch (err) {
      reject(err);
      return;
    }
    Promise.resolve(done).catch(reject);
  });
}

/**
 * The core on the device. Options: `files`, `locks` (one window holds the database), `channel(name)`, `win`/`doc`
 * (flush on pagehide/hidden), `now`, `windowLocks` (lock kept by a previous runtime via close({ keepLock: true })).
 */
export async function createLocalRuntime({
  SQL, store, http, files: givenFiles = null, profile = {}, secureCredentials = false, persistDelayMs = PERSIST_DELAY_MS,
  appVersion = '', now = () => new Date(), locks = globalThis.navigator?.locks, win = globalThis.window, doc = globalThis.document,
  channel = (name) => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null),
  windowLocks = sharedWindowLocks
}) {
  const lockName = typeof store.lockName === 'string' && store.lockName ? `${store.lockName}:${DB_KEY}` : null;
  let lock = lockName ? windowLocks?.take(lockName) ?? null : null;
  let follower = false;
  if (!lock && lockName && typeof locks?.request === 'function') {
    try {
      lock = await requestLock(locks, lockName, { ifAvailable: true });
      follower = !lock;
    } catch (_) {
      lock = null;
    }
  }

  let dirty = false;
  let timer = null;
  let saving = Promise.resolve();
  let lastError = null;
  let failures = 0;
  let conflict = false;
  let closed = false;
  // replaceDatabase runs: writes are refused and nothing of the old database is saved
  let replacing = false;
  const listeners = new Set();

  let savedAt = null;
  const status = () => ({ saveError: lastError ? (lastError.message || String(lastError)) : null, follower, conflict, savedAt });
  const emit = (type) => {
    const detail = { type, status: status() };
    for (const listener of [...listeners]) listener(detail);
    try { win?.dispatchEvent?.(new CustomEvent(LOCAL_STORE_EVENT, { detail })); } catch (_) { /* no window */ }
  };

  const markDirty = () => {
    if (follower || closed) return;
    dirty = true;
    // while saving fails the retry timer stays: a new write must not hammer the store
    if (lastError || replacing) return;
    clearTimeout(timer);
    timer = setTimeout(save, persistDelayMs);
  };

  // a write to a connection that is no longer the live one (a handler still running on the replaced database) is not saved
  const track = (raw) => {
    const tracked = trackWrites(raw, () => { if (tracked === conn) markDirty(); });
    return tracked;
  };
  const openLive = (bytes) => track(openDatabase(SQL, bytes, { live: true }));

  let seq = 0;
  let conn = null;
  let user = null;
  let fresh = false;

  /** A follower never writes: a profile the stored database lacks stays pending until this window holds the lock. */
  function resolveProfile(selection, options = {}) {
    return ensureProfileRow(conn, selection, { ...options, create: !follower })
      || { id: PENDING_PROFILE_ID, username: String(selection?.name || '').trim() || 'Ich', role: 'admin' }; // i18n-ignore
  }

  try {
    const stored = await store.get('db', DB_KEY);
    seq = decodeSeq(await store.get('db', SAVE_SEQ_KEY));
    conn = openLive(stored);
    const usersBefore = conn.prepare('SELECT count(*) AS n FROM users').get().n;
    user = resolveProfile(profile);
    fresh = !stored || conn.prepare('SELECT count(*) AS n FROM users').get().n !== usersBefore;
  } catch (err) {
    // a database that does not open must not keep the lock (the next attempt would only read)
    lock?.release();
    throw err;
  }

  const baseFiles = givenFiles || createBlobFiles(store);
  await baseFiles.preload?.();
  // names written in this session: the orphan cleanup never takes an upload whose form is still open
  const written = new Set();
  const files = {
    ...baseFiles,
    async write(name, bytes, options) {
      written.add(name);
      return baseFiles.write(name, bytes, options);
    }
  };
  const credentials = createLocalCredentials(store, { secure: secureCredentials });
  await credentials.load();

  const makeCtx = () => ctxModule.createCtx({
    db: ctxModule.dbFromConnection(conn),
    files,
    http,
    credentials: credentials.provider(),
    config: { appTimeZone: deviceTimeZone(), appVersion },
    now,
    randomId
  });
  let ctx = makeCtx();

  // the window holding the database tells the others after each save
  const bus = lockName && (lock || follower) ? channel(lockName) : null;
  bus?.unref?.();

  /** Writes the bytes unless another window saved a newer copy since this one read it. */
  async function persist(bytes) {
    const storedSeq = decodeSeq(await store.get('db', SAVE_SEQ_KEY));
    if (storedSeq > seq) throw codedError(CONFLICT_TEXT, 'LOCAL_CONFLICT');
    await store.put('db', SAVE_SEQ_KEY, encodeSeq(seq + 1));
    seq += 1;
    await store.put('db', DB_KEY, bytes);
  }

  const retryDelay = () => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1));

  function persistNow(bytes) {
    const run = saving.then(() => persist(bytes));
    saving = run.then(() => {
      const recovered = Boolean(lastError);
      lastError = null;
      failures = 0;
      // a write during a retry only set `dirty` (markDirty leaves the retry timer alone)
      if (dirty && !timer && !closed && !replacing && !follower && !conflict) timer = setTimeout(save, persistDelayMs);
      savedAt = Date.now();
      if (recovered) emit('status');
      try { bus?.postMessage({ type: 'saved', seq }); } catch (_) { /* channel closed */ }
      emit('saved');
    }, (err) => {
      console.warn('[Lokal] Datenbank nicht gespeichert:', err?.message || err);
      dirty = true;
      failures += 1;
      lastError = err;
      if (err?.code === 'LOCAL_CONFLICT') conflict = true;
      else if (!closed) {
        clearTimeout(timer);
        timer = setTimeout(save, retryDelay());
      }
      emit('status');
    });
    return run;
  }

  function save() {
    clearTimeout(timer);
    timer = null;
    if (follower || conflict || replacing) return saving;
    dirty = false;
    persistNow(conn.export()).catch(() => {});
    return saving;
  }

  /** Saves pending changes now; rejects while the store keeps failing (the data is not safe yet). */
  async function flush() {
    if (timer || dirty) await save();
    else await saving;
    if (lastError) throw codedError(`${t(SAVE_FAILED_TEXT)}: ${lastError.message || lastError}`, lastError.code || 'LOCAL_SAVE_FAILED');
  }

  // a new database or a new profile row is stored right away, not only with the first change
  if (fresh && !follower) await save();

  const listProfiles = () => conn.prepare('SELECT id, username, created_at FROM users ORDER BY id').all()
    .map((row) => ({ ...row, role: 'admin' }));

  /** Re-reads the stored database (a follower after the holder saved, or when it takes over the lock). */
  async function reloadFromStore() {
    const bytes = await store.get('db', DB_KEY);
    if (!bytes) return;
    const next = openLive(bytes);
    seq = decodeSeq(await store.get('db', SAVE_SEQ_KEY));
    conn.close();
    conn = next;
    // another window may have given this id to a different profile meanwhile
    user = resolveProfile({ id: user.id, name: user.username }, { sameName: true });
    ctx = makeCtx();
    dirty = false;
  }

  async function dropUnreferencedUploads() {
    const isReferenced = uploadReferences(conn);
    let removed = 0;
    for (const name of await files.list()) {
      if (written.has(name) || isReferenced(name)) continue;
      await files.remove(name);
      removed += 1;
    }
    return removed;
  }

  // the server's scheduler purges the trash after 30 days; on the device the window holding the database does it
  async function housekeeping() {
    if (follower || closed || replacing) return;
    try {
      trash.purgeTrash(ctx);
      // with navigator.locks unavailable another window may hold uploads this one does not know yet
      if (lock || !lockName) await dropUnreferencedUploads();
    } catch (err) {
      console.warn('[Lokal] Aufräumen fehlgeschlagen:', err?.message || err);
    }
  }
  const startup = housekeeping();
  const daily = setInterval(() => { housekeeping(); }, DAY_MS);
  daily?.unref?.();

  let waiting = null;
  if (follower) {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    waiting = { abort };
    requestLock(locks, lockName, abort ? { signal: abort.signal } : {}).then(async (granted) => {
      if (closed) { granted?.release(); return; }
      lock = granted;
      await reloadFromStore();
      follower = false;
      if (user.id === PENDING_PROFILE_ID) user = ensureProfileRow(conn, { name: user.username });
      housekeeping();
      emit('status');
    }).catch(() => {});
  }

  if (bus) {
    bus.onmessage = (event) => {
      if (follower && event?.data?.type === 'saved') reloadFromStore().then(() => emit('reloaded'), () => {});
    };
  }

  const onHide = () => { flush().catch(() => {}); };
  const onVisibility = () => { if (doc?.visibilityState === 'hidden') onHide(); };
  win?.addEventListener?.('pagehide', onHide);
  doc?.addEventListener?.('visibilitychange', onVisibility);

  const server = createLocalServer({
    getCtx: () => ctxModule.withUser(ctx, user),
    getProfile: () => user,
    listProfiles,
    credentials,
    http,
    isCoreRoute: (method, path) => Boolean(coreRoutes.matchRoute(method, path))
  });

  // export() reopens the sql.js database and restarts the count: only a difference matters
  const changeCount = () => conn.prepare('SELECT total_changes() AS n').get().n;

  const refusal = () => {
    if (follower) return { status: 423, body: { error: LOCKED_TEXT, code: 'LOCAL_LOCKED' } };
    if (replacing) return { status: 423, body: { error: BUSY_TEXT, code: 'LOCAL_BUSY' } };
    if (conflict) return { status: 409, body: { error: CONFLICT_TEXT, code: 'LOCAL_CONFLICT' } };
    if (lastError) return { status: 507, body: { error: SAVE_FAILED_TEXT, code: 'LOCAL_SAVE_FAILED' } };
    return null;
  };

  /** One request below /api as the server would answer it: { status, headers, body } (body: object or text). */
  async function request(method, url, body) {
    const m = String(method || 'GET').toUpperCase();
    const target = String(url);
    if (!target.startsWith('/api/')) return { status: 404, headers: {}, body: { error: 'Nicht gefunden', code: 'NOT_FOUND' } }; // i18n-ignore: answer text
    const sub = target.slice(4);
    const path = sub.split('?')[0];
    // writes that cannot be kept are refused instead of acknowledged
    const write = !READ_METHODS.has(m);
    const refused = write ? refusal() : null;
    if (refused) return { ...refused, headers: { 'Cache-Control': 'no-store' } };
    // safety net next to the write hook: any change of the connection during a write request marks it dirty
    const source = conn;
    const before = write && !closed ? changeCount() : null;
    try {
      const local = await server.handle(m, path, body);
      const answer = local ?? await coreRoutes.dispatch(ctxModule.withUser(ctx, user), { method: m, url: sub, body: typeof FormData !== 'undefined' && body instanceof FormData ? {} : body });
      return { status: answer.status || 200, headers: answer.headers || {}, body: answer.body };
    } catch (err) {
      const { status: code, body: errBody } = errors.errorAnswer(err);
      if (code >= 500) console.error('[Lokal]', m, path, err);
      return { status: code, headers: {}, body: errBody };
    } finally {
      if (before !== null && !closed && conn === source && changeCount() !== before) markDirty();
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
    /** { saveError, follower, conflict }: App shows them as lasting notices. */
    status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The start's trash purge and upload cleanup (tests wait for it). */
    housekeeping: () => startup,
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
      if (!follower && !conflict && !replacing) {
        dirty = false;
        persistNow(bytes).catch(() => {});
      }
      return bytes;
    },
    /**
     * Replaces the collection (checked and migrated bytes, optional uploads); the profile becomes `profileName`, else
     * the first admin. New data is stored before the swap, so a failure keeps the old one. Writes answer 423 meanwhile.
     */
    async replaceDatabase(bytes, { uploads = null, profileName, prepare = null } = {}) {
      const refused = refusal();
      // i18n-dynamic: the refusal texts are the marked constants of store.js and BUSY_TEXT
      if (refused && refused.status !== 507) throw codedError(t(refused.body.error), refused.body.code);
      // fenced until the end: a save of the old database queued behind the new bytes would bring it back
      replacing = true;
      clearTimeout(timer);
      timer = null;
      try {
        const next = openDatabase(SQL, bytes);
        const added = [];
        const staged = [];
        let nextUser;
        try {
          const admin = next.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
          const named = profileName ? next.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(profileName) : null;
          nextUser = ensureProfileRow(next, { id: named?.id ?? admin?.id ?? null, name: profileName || user.username });
          if (uploads) {
            const existing = new Set(await files.list());
            for (const [name, data] of uploads) {
              if (!existing.has(name)) {
                added.push(name);
                await files.write(name, data);
              } else if (!sameBytes(await files.read(name), data)) {
                const temp = STAGED_PREFIX + name;
                added.push(temp);
                await files.write(temp, data);
                staged.push([name, temp, data]);
              }
            }
          }
          sanitizeImportedDatabase(next);
          if (prepare) await prepare(next);
          await persistNow(next.export());
        } catch (err) {
          for (const name of added) await files.remove(name).catch(() => {});
          next.close();
          throw err;
        }
        conn.close();
        // the aliases are loaded through core/schema.js, the module instance the core's handlers use
        schema.applySchema(next, { loadAliases: true });
        conn = track(next);
        user = nextUser;
        ctx = makeCtx();
        dirty = false;
        for (const [name, temp, data] of staged) {
          try {
            await files.write(name, data);
            await files.remove(temp);
          } catch (err) {
            console.warn('[Lokal] Datei nicht übernommen:', name, err?.message || err);
          }
        }
        if (uploads) {
          for (const name of await files.list()) {
            if (!uploads.has(name) && !name.startsWith(STAGED_PREFIX)) await files.remove(name).catch(() => {});
          }
        }
      } finally {
        replacing = false;
        // a failed replace keeps the old database: what changed there before is still to be saved
        if (dirty && !timer && !lastError && !closed && !follower && !conflict) timer = setTimeout(save, persistDelayMs);
      }
      emit('replaced');
      return user;
    },
    /**
     * Bytes of a changed copy: `fn(conn)` runs on a copy of this database (`from: 'current'`) or on a new, empty one
     * (`from: 'empty'`); the live database (and its publisher aliases) stays as it is.
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
      user = resolveProfile(selection);
      return user;
    },
    /** `keepLock`: the database lock stays with this window (windowLocks) for its next runtime, no waiting window gets it. */
    async close({ keepLock = false } = {}) {
      try {
        await flush();
      } finally {
        closed = true;
        clearTimeout(timer);
        clearInterval(daily);
        win?.removeEventListener?.('pagehide', onHide);
        doc?.removeEventListener?.('visibilitychange', onVisibility);
        waiting?.abort?.abort();
        try { bus?.close(); } catch (_) { /* closed */ }
        conn.close();
        if (lock && keepLock && windowLocks) {
          windowLocks.keep(lockName, lock);
        } else if (lock) {
          lock.release();
          await Promise.resolve(lock.done).catch(() => {});
        }
        if (follower || conflict) {
          follower = false;
          conflict = false;
          emit('status');
        }
      }
    }
  };
}
